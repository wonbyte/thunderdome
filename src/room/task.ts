// Task model: input checks, ids, and the forks one task owns. No Durable Object code here,
// so the unit tests can run it with a mock Artifacts binding.
import { AGENT_NAMES, type AgentName } from "../agents/prompt";
import { AGENT_TIME_LIMIT_MS, type AgentOutcome } from "../agents/runner";
import { deleteRepo, forkFor, forkName, isArtifactsError, isRepoName, latestCommit, notReady } from "../artifacts/repo";
import type { JudgeInput } from "../judge/judge";
import type { ScoreParts } from "../judge/score";
import type { DecidedBy } from "../judge/why";
import type { BaseRequest } from "../push/push"; // type-only: push.ts imports isTaskId from here
import { retry } from "../retry";
import type { ShipResult } from "../ship/ship";
import type { FusionResult } from "../judge/fusion";
import { claimsOf, type ClaimBoard } from "./claims";
import type { RaceMemory } from "./races";

// A task with N agents uses the first N names.
export { AGENT_NAMES };
/** Fewest robots in a race. */
export const MIN_AGENTS = 3;
/** Most robots in a race: one per name. */
export const MAX_AGENTS = AGENT_NAMES.length;
/** Longest task prompt POST /tasks accepts. */
export const MAX_PROMPT_LENGTH = 10_000;
/** Pushes remembered per agent, so event retries are recorded once. */
export const MAX_SEEN_PUSHES = 50;

const TASK_ID_PATTERN = /^t-[0-9a-f]{8}$/;

/**
 * Exactly one of repo and template. A template task forks the template into a fresh source
 * repo first, so the race and the merge never change the template.
 */
export type CreateTaskInput = { prompt: string; agents: number } & ({ repo: string; template?: never } | { template: string; repo?: never });

/** A checked create request with the task id the room was made for. */
export type NewTask = CreateTaskInput & { id: string };

/** One agent's fork: its repo name, git remote and default branch. */
export interface ForkSlot {
  name: AgentName;
  fork: string;
  remote: string;
  defaultBranch: string;
}

/** Where an agent's run is: not started, starting, running, or how it ended. */
export type AgentStatus = "idle" | "starting" | "running" | AgentOutcome["end"];

/** One push to an agent's fork. push.ts's PushEvent fits this shape. */
export interface PushInput {
  agent: string;
  after: string;
  commits: number;
  message?: string;
}

/** A Workers Preview to save: its URL and the commit it was built from. */
export interface PreviewInput {
  url: string;
  commit: string;
}

/** A saved Workers Preview. */
export interface Preview extends PreviewInput {
  at: string; // ISO
}

/** One recorded push, for the git graph. */
export interface PushLogEntry {
  at: string; // ISO, when it was recorded
  commit: string; // the push's `after`
  commits: number; // counted commits, 0 for a bad count
  message?: string; // only when the push had one
}

/** What an agent's pushes added up to, for the board and the git graph. */
export interface PushState {
  commits: number; // sum of commit counts of recorded pushes
  pushes: number; // recorded pushes (distinct `after`)
  lastPushAt: string; // ISO, time of the last recorded push
  head: string; // newest head commit by push (record) order
  headMessage?: string; // its message (removed when the newest push has none)
  seen: string[]; // recorded `after` commits, oldest first, capped at MAX_SEEN_PUSHES
  log?: PushLogEntry[]; // recorded pushes, oldest first, capped at MAX_SEEN_PUSHES; missing (older tasks) = empty
  preview?: Preview; // newest saved preview and the commit it was built from
  previewFailed?: string; // a commit whose preview build failed for good; the look stops waiting for it
}

/** One agent in a task: its fork, its run, and its pushes. */
export interface AgentSlot extends ForkSlot, Partial<Omit<AgentOutcome, "end">> {
  status: AgentStatus;
  startedAt?: string;
  endedAt?: string;
  push?: PushState;
}

/** creating → ready → running → finished. "failed" means the forks could not be made. */
export type TaskStatus = "creating" | "ready" | "running" | "finished" | "failed";

/** One fork's score in a verdict. */
export interface VerdictScore {
  agent: string;
  total: number;
  eligible: boolean;
  parts: ScoreParts;
}

/** The judge's outcome and what shipping it did. */
export interface Verdict {
  winner: string | null;
  why: string;
  judgedAt: string; // ISO
  ship: ShipResult;
  scores?: VerdictScore[]; // ranked order; missing on older verdicts
  decidedBy?: DecidedBy; // missing with no winner or no eligible runner-up
  headline?: string; // the judge's one-line reason; missing with no winner or no eligible runner-up
  lesson?: string; // the winner's strongest point, as a clause; see why.ts lesson()
  fusion?: FusionResult; // the fusion round, when it tried something or failed
}

/**
 * A race: the task prompt, its source repo, the agents and their forks, and, once judged, the
 * verdict.
 */
export interface Task {
  id: string;
  repo: string; // the source repo the forks come from and the winner merges into
  template?: string; // the template the source repo was forked from, if any
  prompt: string;
  status: TaskStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  agents: AgentSlot[];
  error?: TaskError;
  verdict?: Verdict;
  baseCommit?: string; // the source head when the forks were made; the base preview is built from it
  basePreview?: Preview; // the "before" preview of the source at baseCommit
  memory?: RaceMemory[]; // earlier races on the same app, told to every agent; missing = none
  judging?: JudgeStep[]; // the judge Workflow's steps as they ran, for the race page; missing on older races
}

/** One judge Workflow step as the race page shows it. */
export interface JudgeStep {
  name: string; // JUDGE_STEP_NAME: "fork <agent>", "look", "split", "compare", "fuse" or "ship"
  state: "running" | "done" | "failed";
  startedAt: string; // ISO, the latest start (a retried step starts again)
  endedAt?: string; // ISO, set by "done" and "failed"
  attempt?: string; // the Workflow attempt that started it; only that attempt may end it
}

/** The judge steps the race page knows. */
export const JUDGE_STEP_NAME = /^(fork [a-z]{1,20}|look|split|compare|fuse|ship)$/;
const JUDGE_STEPS_MAX = 16;

/**
 * Records a judge step starting or ending; a later state replaces an earlier one. False, and the
 * task unchanged, for an unknown name, once the verdict is in, or past JUDGE_STEPS_MAX steps. An
 * end from an older attempt is refused: Workflows can retry a step while the first attempt still
 * runs, and that attempt finishing must not mark the retry done.
 */
export function recordJudgeStep(task: Task, name: string, state: JudgeStep["state"], at: string, attempt?: string): boolean {
  if (!JUDGE_STEP_NAME.test(name) || task.verdict !== undefined) return false;
  const steps = task.judging ?? [];
  const found = steps.find((s) => s.name === name);
  if (found === undefined && steps.length >= JUDGE_STEPS_MAX) return false;
  if (state !== "running" && found?.attempt !== undefined && attempt !== found.attempt) return false;
  const tag = attempt === undefined ? {} : { attempt };
  const step: JudgeStep = state === "running" ? { name, state, startedAt: at, ...tag } : { name, state, startedAt: found?.startedAt ?? at, endedAt: at, ...tag };
  task.judging = found === undefined ? [...steps, step] : steps.map((s) => (s.name === name ? step : s));
  return true;
}

/** A type alias, not an interface, so it fits the SQL row type. */
export type LoggedStep = {
  seq: number;
  agent: string;
  at: string;
  kind: string;
  text: string;
};

/** What TaskRoom.recordPush returns. known: the task and agent exist. */
export type PushRecordResult = { known: boolean; recorded: boolean; build: boolean };

/** True once the agent's run has ended, however it ended. */
export function isAgentDone(status: AgentStatus): boolean {
  return status === "done" || status === "failed" || status === "timeout";
}

/** A task-level error for the client, with an optional machine-readable code. */
export interface TaskError {
  error: string;
  code?: string;
}

/** Errors do not keep their fields across Durable Object RPC, so TaskRoom returns these instead. */
export type CreateTaskResult =
  | { ok: true; task: Task; tokens: Record<string, string> }
  | { ok: false; status: number; error: TaskError };

/** What TaskRoom.run returns over RPC: the started task, or why it could not start. */
export type RunTaskResult = { ok: true; task: Task } | { ok: false; status: number; error: TaskError };

/** A fresh random task id, `t-` and 8 hex digits. */
export function newTaskId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  return `t-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/** True when `id` has the task id shape. */
export function isTaskId(id: string): boolean {
  return TASK_ID_PATTERN.test(id);
}

/** Returns the checked input, or an error message for the client. */
export function parseCreateTask(body: unknown): CreateTaskInput | string {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return "Body must be a JSON object";
  const { repo, template, prompt, agents = MIN_AGENTS } = body as Record<string, unknown>;
  if ((repo === undefined) === (template === undefined)) return "Give exactly one of repo and template";
  if (repo !== undefined && (typeof repo !== "string" || !isRepoName(repo))) return "repo must be an Artifacts repo name";
  // The source name adds "-t-xxxxxxxx" to the template name.
  if (template !== undefined && (typeof template !== "string" || !isRepoName(sourceName(template, "t-00000000")))) {
    return "template must be an Artifacts repo name of at most 89 characters";
  }
  if (typeof prompt !== "string" || prompt.trim() === "") return "prompt must be a non-empty string";
  if (prompt.length > MAX_PROMPT_LENGTH) return `prompt must be at most ${MAX_PROMPT_LENGTH} characters`;
  if (typeof agents !== "number" || !Number.isInteger(agents) || agents < MIN_AGENTS || agents > MAX_AGENTS) {
    return `agents must be an integer from ${MIN_AGENTS} to ${MAX_AGENTS}`;
  }
  return typeof repo === "string" ? { repo, prompt, agents } : { template: template as string, prompt, agents };
}

/** The source repo name of a template task: the template name plus the task id. */
export function sourceName(template: string, taskId: string): string {
  return `${template}-${taskId}`;
}

/** A fork with its write token, which stays in the TaskRoom. */
export interface ForkWithToken extends ForkSlot {
  token: string;
}

/** What making the forks produced: the source repo, its head, and each agent's fork. */
export interface MadeForks {
  source: string;
  forks: ForkWithToken[];
  base: string | undefined; // source head hash after the agent forks are made; undefined if unreadable or empty
}

/** Tries per agent fork while the source repo is busy: twice what one fork alone needed. */
export const FORK_ATTEMPTS = 20;

/**
 * The source repo of a task: the given repo, or a fresh fork of the template.
 * If an agent fork fails, deletes the forks made so far (and a fresh source) and throws the first error.
 */
export async function makeForks(artifacts: Artifacts, task: NewTask, sleep?: (ms: number) => Promise<void>): Promise<MadeForks> {
  if (task.template === undefined) {
    const forks = await forkAgents(artifacts, task.id, task.repo, task.agents, sleep);
    return { source: task.repo, forks, base: await headOf(artifacts, task.repo) };
  }
  const source = sourceName(task.template, task.id);
  await retry(
    () => forkFor(artifacts, task.template, source, `Thunderdome task ${task.id}, source from ${task.template}`),
    { attempts: 10, delayMs: 1_000, shouldRetry: notReady },
    sleep,
  );
  try {
    const forks = await forkAgents(artifacts, task.id, source, task.agents, sleep);
    // headOf never throws, so a missing head never deletes the source.
    return { source, forks, base: await headOf(artifacts, source) };
  } catch (cause) {
    await Promise.allSettled([deleteRepo(artifacts, source)]);
    throw cause;
  }
}

/** The head commit hash of a repo's default branch, or undefined when unreadable or empty. */
async function headOf(artifacts: Artifacts, source: string): Promise<string | undefined> {
  try {
    return (await latestCommit(artifacts, source))?.hash;
  } catch {
    return undefined;
  }
}

/**
 * Makes one fork per agent, all at once: one at a time, the source and 5 forks took about 19 s
 * before a race could start. A source repo that is still busy (`*_IN_PROGRESS`) is retried, with enough tries for the
 * forks to go through one by one if Artifacts serializes them. When any fork fails, the others are deleted.
 */
async function forkAgents(artifacts: Artifacts, taskId: string, source: string, agents: number, sleep?: (ms: number) => Promise<void>): Promise<ForkWithToken[]> {
  const settled = await Promise.allSettled(
    AGENT_NAMES.slice(0, agents).map(async (name): Promise<ForkWithToken> => {
      const fork = forkName(taskId, name);
      const access = await retry(
        () => forkFor(artifacts, source, fork, `Thunderdome task ${taskId}, agent ${name}`),
        { attempts: FORK_ATTEMPTS, delayMs: 1_000, shouldRetry: notReady },
        sleep,
      );
      return { name, fork: access.name, remote: access.remote, defaultBranch: access.defaultBranch, token: access.token };
    }),
  );
  const forks = settled.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
  const failed = settled.find((r) => r.status === "rejected");
  if (failed === undefined) return forks;
  await Promise.allSettled(forks.map((fork) => deleteRepo(artifacts, fork.fork)));
  throw failed.reason;
}

/** Maps a failure to an HTTP status and a message for the client. */
export function describeFailure(cause: unknown, repo: string): { status: number; error: TaskError } {
  if (isArtifactsError(cause, "NOT_FOUND")) {
    return { status: 404, error: { error: `Repo not found: ${repo}`, code: cause.code } };
  }
  if (isArtifactsError(cause)) return { status: 502, error: { error: cause.message, code: cause.code } };
  return { status: 500, error: { error: String(cause) } };
}

/**
 * Records one agent's end. Returns false when the agent already ended (alarm retries repeat it).
 * The task finishes when every agent has ended.
 */
export function applyOutcome(task: Task, agent: string, outcome: AgentOutcome, now: string): boolean {
  const slot = slotOf(task, agent);
  if (slot === undefined || isAgentDone(slot.status)) return false;
  const { end, ...rest } = outcome;
  Object.assign(slot, rest, { status: end, endedAt: now });
  finishIfAllDone(task, now);
  return true;
}

/**
 * Records whether each sandbox started. Only agents still "starting" change, so an end that
 * arrived first is kept.
 */
export function applyStarts(task: Task, starts: { agent: string; error?: string }[], now: string): void {
  for (const start of starts) {
    const slot = slotOf(task, start.agent);
    if (slot === undefined || slot.status !== "starting") continue;
    if (start.error === undefined) {
      slot.status = "running";
    } else {
      Object.assign(slot, { status: "failed", pushed: false, error: start.error, endedAt: now });
    }
  }
  finishIfAllDone(task, now);
}

/**
 * Records a push once per `after` commit (event retries repeat it). The newest recorded push
 * becomes the head and is appended to the log. Any task status, because the runner's last push
 * lands after the agent ends.
 */
export function applyPush(task: Task, push: PushInput, now: string): boolean {
  const slot = slotOf(task, push.agent);
  if (slot === undefined) return false;
  const state = slot.push;
  if (state?.seen.includes(push.after)) return false;
  const commits = Number.isSafeInteger(push.commits) && push.commits > 0 ? push.commits : 0;
  const entry: PushLogEntry = { at: now, commit: push.after, commits, ...(push.message === undefined ? {} : { message: push.message }) };
  slot.push = {
    commits: (state?.commits ?? 0) + commits,
    pushes: (state?.pushes ?? 0) + 1,
    lastPushAt: now,
    head: push.after,
    ...(push.message === undefined ? {} : { headMessage: push.message }),
    seen: [...(state?.seen ?? []), push.after].slice(-MAX_SEEN_PUSHES),
    log: [...(state?.log ?? []), entry].slice(-MAX_SEEN_PUSHES),
    ...(state?.preview === undefined ? {} : { preview: state.preview }),
  };
  return true;
}

/** True when commit is the agent's newest head and has no saved preview yet. */
export function needsPreview(task: Task, agent: string, commit: string): boolean {
  const push = slotOf(task, agent)?.push;
  return push !== undefined && push.head === commit && push.preview?.commit !== commit;
}

/** Saves a preview only for the agent's newest head, so an older build never replaces a newer one. */
export function applyPreview(task: Task, agent: string, preview: PreviewInput, now: string): boolean {
  const push = slotOf(task, agent)?.push;
  if (push === undefined || push.head !== preview.commit) return false;
  push.preview = { url: preview.url, commit: preview.commit, at: now };
  return true;
}

/** Notes that the preview of the agent's newest head failed to build, so the look does not wait for it. */
export function applyPreviewFailure(task: Task, agent: string, commit: string): boolean {
  const push = slotOf(task, agent)?.push;
  if (push === undefined || push.head !== commit) return false;
  push.previewFailed = commit;
  return true;
}

/** Saves the base preview only when it was built from the task's base commit. */
export function applyBasePreview(task: Task, preview: PreviewInput, now: string): boolean {
  if (task.baseCommit === undefined || task.baseCommit !== preview.commit) return false;
  task.basePreview = { url: preview.url, commit: preview.commit, at: now };
  return true;
}

/** The PushWorkflow params for the base preview, or undefined without a base commit. */
export function baseRequest(task: Task): BaseRequest | undefined {
  if (task.baseCommit === undefined) return undefined;
  return { kind: "base", taskId: task.id, repo: task.repo, commit: task.baseCommit };
}

function slotOf(task: Task, agent: string): AgentSlot | undefined {
  return task.agents.find((candidate) => candidate.name === agent);
}

function finishIfAllDone(task: Task, now: string): void {
  if (task.status === "running" && task.agents.every((slot) => isAgentDone(slot.status))) {
    task.status = "finished";
    task.finishedAt = now;
  }
}

/** True only for the change that made the task finished, so the room starts one judge run. */
export function justFinished(before: TaskStatus, task: Task): boolean {
  return before !== "finished" && task.status === "finished";
}

/** Saves the verdict once. Returns false, and leaves the task unchanged, when it already has one. */
export function saveVerdict(task: Task, verdict: Verdict): boolean {
  if (task.verdict !== undefined) return false;
  task.verdict = verdict;
  return true;
}

/** The Workflow params from task state and the claim board. Every agent slot is judged. */
export function judgeInput(task: Task, board: ClaimBoard): JudgeInput {
  return {
    taskId: task.id,
    repo: task.repo,
    task: task.prompt,
    forks: task.agents.map((slot) => {
      const claims = claimsOf(board, slot.name);
      return {
        agent: slot.name,
        fork: slot.fork,
        remote: slot.remote,
        defaultBranch: slot.defaultBranch,
        filesClaimed: claims.files,
        filesShared: claims.shared,
        ...(slot.endedAt === undefined ? {} : { endedAt: slot.endedAt }),
      };
    }),
  };
}

/**
 * The repos a purge deletes: every agent fork, and the source repo when a template made it for
 * this task. A source given as `repo` is shared with other tasks, so it stays.
 */
export function purgeRepos(task: Task): string[] {
  const forks = task.agents.map((slot) => slot.fork);
  return task.template === undefined ? forks : [...forks, task.repo];
}

/** Why a task may not be purged now, or undefined when it may. Agents still push to a running task's forks. */
export function purgeRefusal(task: Task | undefined, now: number = Date.now()): string | undefined {
  if (task === undefined) return undefined;
  if (task.status === "creating") return "Task is creating";
  // A race past its watchdog time has stalled: no agent will report any more, so it may go.
  if (task.status === "running" && !isStalled(task, now)) return "Task is running";
  if (task.status === "finished" && task.verdict === undefined) return "Task is being judged";
  return undefined;
}

/**
 * The watchdog: a running race whose agents have not all ended this long after it started has
 * stalled (a sandbox lost track of its agent, for example when a deploy reset it mid-start).
 */
export const WATCHDOG_MS = AGENT_TIME_LIMIT_MS + 4 * 60 * 1_000;

/** True when a running race is past its watchdog time. */
export function isStalled(task: Task, now: number): boolean {
  const started = task.startedAt === undefined ? NaN : Date.parse(task.startedAt);
  return task.status === "running" && Number.isFinite(started) && now >= started + WATCHDOG_MS;
}

/**
 * The outcome the watchdog gives each agent that never ended. Its pushes are kept: the judge
 * scores whatever the fork holds.
 */
export function stalledOutcomes(task: Task): { agent: string; outcome: AgentOutcome }[] {
  return task.agents
    .filter((slot) => !isAgentDone(slot.status))
    .map((slot) => ({
      agent: slot.name,
      outcome: {
        end: "failed" as const,
        pushed: slot.push !== undefined,
        ...(slot.push === undefined ? {} : { commit: slot.push.head }),
        error: "The sandbox stopped reporting before the agent ended; the judge scores what the fork holds",
      },
    }));
}

/** Why an agent may not use the claim board now, or undefined when it may. */
export function claimRefusal(task: Task | undefined, agent: string): { status: number; error: string } | undefined {
  if (task === undefined) return { status: 404, error: "not found" };
  if (task.status !== "ready" && task.status !== "running") return { status: 409, error: `Task is ${task.status}` };
  const slot = slotOf(task, agent);
  if (slot === undefined) return { status: 404, error: `No agent ${agent} in this task` };
  if (isAgentDone(slot.status)) return { status: 409, error: `Agent ${agent} has ended` };
  return undefined;
}
