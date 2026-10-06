import { DurableObject } from "cloudflare:workers";

import type { Step } from "../agents/events";
import { AGENT_TIME_LIMIT_MS, type AgentOutcome } from "../agents/runner";
import type { SavedDiff } from "../judge/diffs";
import { judgeInstanceId } from "../judge/judge";
import { deleteRepo } from "../artifacts/repo";
import { startWorkflow } from "../start";
import {
  claimFiles,
  describeClaim,
  emptyBoard,
  parseFiles,
  releaseFiles,
  type ClaimBoard,
  type ClaimResult,
} from "./claims";
import { RACE_INDEX_MAX, raceMemory, summaryOf, type RaceMemory } from "./races";
import {
  applyBasePreview,
  applyOutcome,
  applyPreview,
  applyPush,
  applyStarts,
  baseRequest,
  claimRefusal,
  describeFailure,
  judgeInput,
  justFinished,
  makeForks,
  needsPreview,
  purgeRefusal,
  purgeRepos,
  saveVerdict as recordVerdict,
  sourceName,
  stalledOutcomes,
  WATCHDOG_MS,
  type CreateTaskResult,
  type LoggedStep,
  type NewTask,
  type Preview,
  type PreviewInput,
  type PushInput,
  type PushRecordResult,
  type PushState,
  type RunTaskResult,
  type Task,
  type TaskStatus,
  type Verdict,
} from "./task";

const TASK_KEY = "task";
// Fork write tokens stay in the Durable Object. GET /tasks/:id never returns them.
const TOKENS_KEY = "tokens";
const CLAIMS_KEY = "claims";
// kv key `diff:<agent>`: the diff the judge scored for that agent's fork.
const DIFF_KEY_PREFIX = "diff:";
const MAX_STEPS_PER_PAGE = 500;
// Close code for a socket whose send failed.
const CLOSE_SEND_FAILED = 1011;
// The one RaceIndex instance.
const RACE_INDEX_NAME = "all";

// One message on the live WebSocket. Each change is sent once, after it is saved.
export type LiveEvent =
  | { kind: "snapshot"; taskId: string; task: Task | null } // sent to a new socket only
  | { kind: "status"; taskId: string; task: Task } // run start, starts applied
  | { kind: "steps"; taskId: string; agent: string; steps: LoggedStep[] }
  | { kind: "claim"; taskId: string; agent: string; result: ClaimResult }
  | { kind: "release"; taskId: string; agent: string; released: string[] }
  | { kind: "push"; taskId: string; agent: string; push: Omit<PushState, "seen" | "preview"> }
  | { kind: "preview"; taskId: string; agent: string; preview: Preview }
  | { kind: "agent-end"; taskId: string; agent: string; outcome: AgentOutcome; status: TaskStatus }
  | { kind: "verdict"; taskId: string; verdict: Verdict }
  | { kind: "base-preview"; taskId: string; preview: Preview };

// One TaskRoom per task. It owns the task state, the fork tokens, the claim board, the
// agents' step log, and the live WebSockets.
export class TaskRoom extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS steps (seq INTEGER PRIMARY KEY AUTOINCREMENT, agent TEXT NOT NULL, at TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL)",
    );
  }

  // GET /tasks/:id/live: accepts a hibernating WebSocket and sends it a snapshot.
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return Response.json({ error: "Expected Upgrade: websocket" }, { status: 426, headers: { upgrade: "websocket" } });
    }
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    const task = this.#task() ?? null;
    const taskId = task?.id ?? new URL(request.url).pathname.split("/")[2] ?? "";
    this.#send(server, JSON.stringify({ kind: "snapshot", taskId, task } satisfies LiveEvent));
    return new Response(null, { status: 101, webSocket: client });
  }

  // Clients only listen.
  webSocketMessage(_ws: WebSocket, _message: string | ArrayBuffer): void {}

  webSocketClose(ws: WebSocket, code: number, reason: string, _wasClean: boolean): void {
    try {
      ws.close(code, reason);
    } catch {
      // Already closed, or a code that cannot be sent back (1005, 1006).
    }
  }

  webSocketError(_ws: WebSocket, error: unknown): void {
    console.error({ event: "live.socket_error", error: String(error) });
  }

  async create(input: NewTask): Promise<CreateTaskResult> {
    if (this.#task() !== undefined) {
      return { ok: false, status: 409, error: { error: `Task ${input.id} already exists` } };
    }
    const task: Task = {
      id: input.id,
      repo: input.template === undefined ? input.repo : sourceName(input.template, input.id),
      ...(input.template === undefined ? {} : { template: input.template }),
      prompt: input.prompt,
      status: "creating",
      createdAt: new Date().toISOString(),
      agents: [],
    };
    // Written before the first await, so a second create for this id sees it.
    this.#save(task);
    let tokens: Record<string, string>;
    try {
      const { source, forks, base } = await makeForks(this.env.ARTIFACTS, input);
      task.repo = source;
      if (base !== undefined) task.baseCommit = base;
      tokens = Object.fromEntries(forks.map((fork) => [fork.name, fork.token]));
      task.status = "ready";
      task.agents = forks.map(({ token: _token, ...slot }) => ({ ...slot, status: "idle" }));
      const memory = await this.#memory(task);
      if (memory.length > 0) task.memory = memory;
      this.ctx.storage.kv.put(TOKENS_KEY, tokens);
      this.#save(task);
    } catch (cause) {
      console.error(cause);
      const { status, error } = describeFailure(cause, input.repo ?? input.template);
      task.status = "failed";
      task.error = error;
      this.#save(task);
      return { ok: false, status, error };
    }
    // A failed create is not recorded.
    await this.#index(task);
    return { ok: true, task, tokens };
  }

  // Starts every agent at once, each in its own sandbox on its own fork.
  async run(): Promise<RunTaskResult> {
    const task = this.#task();
    if (task === undefined) return { ok: false, status: 404, error: { error: "not found" } };
    if (task.status !== "ready") {
      return { ok: false, status: 409, error: { error: `Task is ${task.status}; only a ready task can run` } };
    }
    const tokens = this.ctx.storage.kv.get<Record<string, string>>(TOKENS_KEY) ?? {};
    const now = Date.now();
    task.status = "running";
    task.startedAt = new Date(now).toISOString();
    for (const slot of task.agents) {
      slot.status = "starting";
      slot.startedAt = task.startedAt;
    }
    // Written before the first await, so a second run sees "running".
    this.#save(task);
    // The watchdog ends the race even if a sandbox never reports back.
    await this.ctx.storage.setAlarm(now + WATCHDOG_MS);
    this.#broadcast({ kind: "status", taskId: task.id, task });
    await this.#index(task);
    const settled = await Promise.allSettled(
      task.agents.map((slot) =>
        this.env.SANDBOX.getByName(slot.fork).startAgent({
          taskId: task.id,
          agent: slot.name,
          fork: slot.fork,
          remote: slot.remote,
          token: tokens[slot.name] ?? "",
          defaultBranch: slot.defaultBranch,
          prompt: task.prompt,
          deadline: now + AGENT_TIME_LIMIT_MS,
          model: this.env.AGENT_MODEL ?? "",
          ...(task.memory === undefined ? {} : { memory: task.memory }),
        }),
      ),
    );
    // Steps and ends can arrive while the sandboxes start, so apply the starts to fresh state.
    const latest = this.#task() ?? task;
    const before = latest.status;
    applyStarts(
      latest,
      settled.map((result, index) => ({
        agent: task.agents[index]!.name,
        error: result.status === "rejected" ? String(result.reason) : undefined,
      })),
      new Date().toISOString(),
    );
    this.#save(latest);
    this.#broadcast({ kind: "status", taskId: latest.id, task: latest });
    await this.#startBasePreview(latest);
    if (justFinished(before, latest)) {
      // Every start failed.
      await this.#index(latest);
      await this.#startJudge(latest);
    }
    return { ok: true, task: latest };
  }

  // The watchdog (set by run): every agent still not ended is ended as failed, so the race
  // finishes and the judge starts. Does nothing once every agent has ended.
  async alarm(): Promise<void> {
    const task = this.#task();
    if (task === undefined || task.status !== "running") return;
    for (const { agent, outcome } of stalledOutcomes(task)) await this.agentFinished(agent, outcome);
  }

  // Called by a sandbox with the steps its agent took since the last call.
  agentSteps(agent: string, steps: Step[]): void {
    const at = new Date().toISOString();
    const logged: LoggedStep[] = [];
    for (const step of steps) {
      const { seq } = this.ctx.storage.sql
        .exec<{ seq: number }>("INSERT INTO steps (agent, at, kind, text) VALUES (?, ?, ?, ?) RETURNING seq", agent, at, step.kind, step.text)
        .one();
      logged.push({ seq, agent, at, kind: step.kind, text: step.text });
    }
    const taskId = this.#task()?.id;
    if (taskId !== undefined && logged.length > 0) this.#broadcast({ kind: "steps", taskId, agent, steps: logged });
  }

  // Called by a sandbox once its agent has ended and its work is pushed: the agent's DONE.
  async agentFinished(agent: string, outcome: AgentOutcome): Promise<void> {
    const task = this.#task();
    if (task === undefined) return;
    const before = task.status;
    if (!applyOutcome(task, agent, outcome, new Date().toISOString())) return;
    this.agentSteps(agent, [{ kind: outcome.end === "done" ? "result" : "error", text: `DONE (${outcome.end})${outcome.pushed ? ` pushed ${outcome.commit}` : ", nothing pushed"}` }]);
    this.#save(task);
    this.#broadcast({ kind: "agent-end", taskId: task.id, agent, outcome, status: task.status });
    // An agent that ended frees its files. The history keeps its claims for the judge.
    const board = this.#board();
    if (releaseFiles(board, agent).length > 0) this.ctx.storage.kv.put(CLAIMS_KEY, board);
    if (justFinished(before, task)) {
      await this.#index(task);
      await this.#startJudge(task);
    }
  }

  // Called by the push Workflow for each push to a fork. build: the push needs a preview.
  recordPush(push: PushInput): PushRecordResult {
    const task = this.#task();
    const slot = task?.agents.find((candidate) => candidate.name === push.agent);
    if (task === undefined || slot === undefined) return { known: false, recorded: false, build: false };
    const recorded = applyPush(task, push, new Date().toISOString());
    if (recorded && slot.push !== undefined) {
      this.#save(task);
      const { seen: _seen, preview: _preview, ...state } = slot.push;
      this.#broadcast({ kind: "push", taskId: task.id, agent: push.agent, push: state });
    }
    return { known: true, recorded, build: needsPreview(task, push.agent, push.after) };
  }

  // Called by the push Workflow with a built preview. Saved only for the agent's newest head.
  savePreview(agent: string, preview: PreviewInput): boolean {
    const task = this.#task();
    if (task === undefined || !applyPreview(task, agent, preview, new Date().toISOString())) return false;
    this.#save(task);
    const saved = task.agents.find((candidate) => candidate.name === agent)?.push?.preview;
    if (saved !== undefined) this.#broadcast({ kind: "preview", taskId: task.id, agent, preview: saved });
    return true;
  }

  // Called by the push Workflow with the built base preview. Saved only for the task's base commit.
  saveBasePreview(preview: PreviewInput): boolean {
    const task = this.#task();
    if (task === undefined || !applyBasePreview(task, preview, new Date().toISOString())) return false;
    this.#save(task);
    if (task.basePreview !== undefined) this.#broadcast({ kind: "base-preview", taskId: task.id, preview: task.basePreview });
    return true;
  }

  // Called by the judge Workflow once it has decided and shipped. A verdict is saved once.
  async saveVerdict(verdict: Verdict): Promise<{ ok: true; task: Task } | { ok: false; status: number; error: string }> {
    const task = this.#task();
    if (task === undefined) return { ok: false, status: 404, error: "not found" };
    if (!recordVerdict(task, verdict)) return { ok: false, status: 409, error: "Task already has a verdict" };
    this.#save(task);
    this.#broadcast({ kind: "verdict", taskId: task.id, verdict });
    await this.#index(task);
    return { ok: true, task };
  }

  // Called by the judge Workflow with the (clipped) diff it scored. False when there is no
  // task or the agent is not one of its agents.
  async saveDiff(agent: string, saved: SavedDiff): Promise<boolean> {
    const task = this.#task();
    if (task === undefined || !task.agents.some((slot) => slot.name === agent)) return false;
    this.ctx.storage.kv.put(`${DIFF_KEY_PREFIX}${agent}`, { diff: saved.diff, clipped: saved.clipped });
    return true;
  }

  // The saved diff of an agent's fork, or null before the judge saved one.
  async forkDiff(agent: string): Promise<SavedDiff | null> {
    return this.ctx.storage.kv.get<SavedDiff>(`${DIFF_KEY_PREFIX}${agent}`) ?? null;
  }

  // Claims files for an agent. A file another agent holds is claimed as shared and returned as a clash.
  claim(agent: string, files: unknown, shared: boolean): ClaimResult {
    const task = this.#task();
    const refusal = claimRefusal(task, agent);
    if (refusal !== undefined) return { ok: false, ...refusal };
    const parsed = parseFiles(files);
    if (typeof parsed === "string") return { ok: false, status: 400, error: parsed };
    const board = this.#board();
    const result = claimFiles(board, agent, parsed, shared, new Date().toISOString());
    if (result.ok) this.ctx.storage.kv.put(CLAIMS_KEY, board);
    this.agentSteps(agent, [{ kind: "claim", text: describeClaim(result) }]);
    if (task !== undefined) this.#broadcast({ kind: "claim", taskId: task.id, agent, result });
    return result;
  }

  // Releases the given files, or all of the agent's files when files is undefined.
  release(agent: string, files?: unknown): { ok: true; released: string[] } | { ok: false; status: number; error: string } {
    const parsed = files === undefined ? undefined : parseFiles(files);
    if (typeof parsed === "string") return { ok: false, status: 400, error: parsed };
    const board = this.#board();
    const released = releaseFiles(board, agent, parsed);
    if (released.length > 0) {
      this.ctx.storage.kv.put(CLAIMS_KEY, board);
      this.agentSteps(agent, [{ kind: "claim", text: `released ${released.join(", ")}` }]);
      const taskId = this.#task()?.id;
      if (taskId !== undefined) this.#broadcast({ kind: "release", taskId, agent, released });
    }
    return { ok: true, released };
  }

  // Deletes the task's repos, then all of its state: task, tokens, claims, diffs and steps. A repo
  // that fails to delete keeps the state, so the purge can be run again.
  async purge(): Promise<{ ok: true; deleted: string[] } | { ok: false; error: string }> {
    const task = this.#task();
    const refusal = purgeRefusal(task);
    if (refusal !== undefined) return { ok: false, error: refusal };
    const repos = task === undefined ? [] : purgeRepos(task);
    const settled = await Promise.allSettled(repos.map((name) => deleteRepo(this.env.ARTIFACTS, name)));
    const failed = repos.filter((_name, i) => settled[i]?.status === "rejected");
    if (failed.length > 0) return { ok: false, error: `Deleting ${failed.join(", ")} failed` };
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.close(1000, "purged");
      } catch {
        // Already gone.
      }
    }
    await this.ctx.storage.deleteAll();
    return { ok: true, deleted: repos };
  }

  claimBoard(): ClaimBoard {
    return this.#board();
  }

  state(): Task | null {
    return this.#task() ?? null;
  }

  steps(after: number, limit: number): LoggedStep[] {
    return this.ctx.storage.sql
      .exec<LoggedStep>(
        "SELECT seq, agent, at, kind, text FROM steps WHERE seq > ? ORDER BY seq LIMIT ?",
        after,
        Math.min(Math.max(limit, 1), MAX_STEPS_PER_PAGE),
      )
      .toArray();
  }

  // What earlier races on the same app taught, for the agents. Never throws: no memory is fine.
  async #memory(task: Task): Promise<RaceMemory[]> {
    try {
      const races = await this.env.RACE_INDEX.getByName(RACE_INDEX_NAME).list(RACE_INDEX_MAX);
      return raceMemory(races, task);
    } catch (error) {
      console.error({ event: "race_index.memory_failed", taskId: task.id, error: String(error) });
      return [];
    }
  }

  // Records the task's summary in the race index. Never throws: a failed record is only logged.
  async #index(task: Task): Promise<void> {
    try {
      await this.env.RACE_INDEX.getByName(RACE_INDEX_NAME).record(summaryOf(task, this.claimBoard().history));
    } catch (error) {
      console.error({ event: "race_index.record_failed", taskId: task.id, error: String(error) });
    }
  }

  // Starts the judge with the same id and params as the manual route, retrying a failed
  // create. Never throws: a start that still fails is only logged.
  async #startJudge(task: Task): Promise<void> {
    try {
      await startWorkflow(this.env.JUDGE, judgeInstanceId(task.id), judgeInput(task, this.#board()));
    } catch (cause) {
      console.error({ event: "judge.start_failed", taskId: task.id, error: String(cause) });
    }
  }

  // Starts the base preview build when the task has a base commit, retrying a failed create.
  // Never throws: a start that still fails is only logged.
  async #startBasePreview(task: Task): Promise<void> {
    const request = baseRequest(task);
    if (request === undefined) return;
    try {
      await startWorkflow(this.env.PUSH, `${task.id}-base`, request);
    } catch (cause) {
      console.error({ event: "base_preview.start_failed", taskId: task.id, error: String(cause) });
    }
  }

  // Sends one change to every live socket. Never throws, so a send never breaks the change.
  #broadcast(event: LiveEvent): void {
    try {
      const message = JSON.stringify(event);
      for (const ws of this.ctx.getWebSockets()) this.#send(ws, message);
    } catch (cause) {
      console.error({ event: "live.broadcast_failed", kind: event.kind, error: String(cause) });
    }
  }

  // A socket whose send throws is closed, which drops it from getWebSockets().
  #send(ws: WebSocket, message: string): void {
    try {
      ws.send(message);
    } catch {
      try {
        ws.close(CLOSE_SEND_FAILED, "send failed");
      } catch {
        // Already gone.
      }
    }
  }

  #task(): Task | undefined {
    return this.ctx.storage.kv.get<Task>(TASK_KEY);
  }

  #board(): ClaimBoard {
    return this.ctx.storage.kv.get<ClaimBoard>(CLAIMS_KEY) ?? emptyBoard();
  }

  #save(task: Task): void {
    this.ctx.storage.kv.put(TASK_KEY, task);
  }
}
