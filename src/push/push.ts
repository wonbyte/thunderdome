// Push events from Artifacts and the Workers Preview each push builds. Pure, so Node tests run it.
import { clip } from "../agents/events";
import { isAgentName, type AgentName } from "../agents/prompt";
import { forkName, isRepoName } from "../artifacts/repo";
import { isTaskId } from "../room/task";

/** The Artifacts event type for a push. */
export const PUSH_EVENT_TYPE = "cf.artifacts.repo.pushed";
/** The Artifacts namespace every Thunderdome repo lives in. */
export const THUNDERDOME_NAMESPACE = "thunderdome";
/** The only ref whose pushes are recorded and previewed. */
export const PUSH_REF = "refs/heads/main";
/** Where the preview's wrangler config is written in the sandbox. */
export const PREVIEW_CONFIG_PATH = "/workspace/preview.jsonc";
/** The preview's entry point, relative to PREVIEW_CONFIG_PATH's directory. */
export const PREVIEW_MAIN = "repo/src/index.ts";
/**
 * Longest preview name: leaves room for "-<worker>" (worker at most 30 characters) in one
 * 63-character DNS label.
 */
export const MAX_PREVIEW_NAME_LENGTH = 32;
/** The `kind` of a base preview request from the TaskRoom. */
export const BASE_REQUEST_KIND = "base";

const MAX_MESSAGE_LENGTH = 500;
const COMMIT_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const ZERO_COMMIT = /^0+$/;
const DNS_NAME = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/** A checked push to a fork: which task and agent, the new head, and how many commits it added. */
export interface PushEvent {
  taskId: string;
  agent: AgentName;
  fork: string;
  ref: string;
  after: string;
  commits: number;
  message?: string;
}

/** A request to preview the source repo at the commit the forks were made from. */
export interface BaseRequest {
  kind: "base";
  taskId: string;
  repo: string;
  commit: string;
}

/** Inverse of forkName: "<taskId>-<agent>". The agent name has no hyphen, so split at the last one. */
export function parseForkName(name: string): { taskId: string; agent: AgentName } | undefined {
  const cut = name.lastIndexOf("-");
  if (cut < 0) return undefined;
  const taskId = name.slice(0, cut);
  const agent = name.slice(cut + 1);
  if (!isTaskId(taskId) || !isAgentName(agent)) return undefined;
  try {
    return forkName(taskId, agent) === name ? { taskId, agent } : undefined;
  } catch {
    return undefined;
  }
}

/** The push to a task fork's main branch, or undefined for anything else. Never throws. */
export function parsePushEvent(event: unknown, namespace: string = THUNDERDOME_NAMESPACE): PushEvent | undefined {
  if (!isRecord(event) || event.type !== PUSH_EVENT_TYPE) return undefined;
  const { source, payload } = event;
  if (!isRecord(source) || !isRecord(payload)) return undefined;
  if (source.namespace !== namespace || typeof source.repoName !== "string") return undefined;
  const fork = parseForkName(source.repoName);
  if (fork === undefined || payload.ref !== PUSH_REF) return undefined;
  const { after } = payload;
  if (typeof after !== "string" || !COMMIT_PATTERN.test(after) || ZERO_COMMIT.test(after)) return undefined;
  const commits = commitsOf(payload);
  if (commits === undefined) return undefined;
  const message = newestMessage(commits.list, after);
  return {
    taskId: fork.taskId,
    agent: fork.agent,
    fork: source.repoName,
    ref: PUSH_REF,
    after,
    commits: commits.count,
    ...(message === undefined ? {} : { message }),
  };
}

/** The base preview request, or undefined for anything else (including an Artifacts push event). Never throws. */
export function parseBaseRequest(payload: unknown): BaseRequest | undefined {
  if (!isRecord(payload) || payload.kind !== BASE_REQUEST_KIND) return undefined;
  const { taskId, repo, commit } = payload;
  if (typeof taskId !== "string" || !isTaskId(taskId)) return undefined;
  if (typeof repo !== "string" || !isRepoName(repo)) return undefined;
  if (typeof commit !== "string" || !COMMIT_PATTERN.test(commit) || ZERO_COMMIT.test(commit)) return undefined;
  return { kind: BASE_REQUEST_KIND, taskId, repo, commit };
}

/** `${taskId}-${agent}`, checked to be a short lowercase DNS label. */
export function previewName(taskId: string, agent: AgentName): string {
  if (!isTaskId(taskId)) throw new Error(`Invalid task id: ${taskId}`);
  if (!isAgentName(agent)) throw new Error(`Invalid agent: ${String(agent)}`);
  const name = `${taskId}-${agent}`;
  if (name.length > MAX_PREVIEW_NAME_LENGTH || !DNS_NAME.test(name)) throw new Error(`Invalid preview name: ${name}`);
  return name;
}

/** `${taskId}-base`, checked like previewName. */
export function basePreviewName(taskId: string): string {
  if (!isTaskId(taskId)) throw new Error(`Invalid task id: ${taskId}`);
  const name = `${taskId}-base`;
  if (name.length > MAX_PREVIEW_NAME_LENGTH || !DNS_NAME.test(name)) throw new Error(`Invalid preview name: ${name}`);
  return name;
}

/** Thunderdome's own wrangler config, so forks need no Wrangler file. */
export function previewConfig(worker: string, compatibilityDate: string): string {
  return `${JSON.stringify({ name: worker, main: PREVIEW_MAIN, compatibility_date: compatibilityDate, previews: {} }, null, 2)}\n`;
}

/** The first preview URL from `wrangler preview --json`, only when it is https. Never throws. */
export function previewUrl(stdout: string): string | undefined {
  const output = parseJson(stdout);
  if (!isRecord(output) || !isRecord(output.preview) || !Array.isArray(output.preview.urls)) return undefined;
  const first: unknown = output.preview.urls[0];
  if (typeof first !== "string") return undefined;
  try {
    const url = new URL(first);
    return url.protocol === "https:" && url.hostname !== "" ? first : undefined;
  } catch {
    return undefined;
  }
}

/** The commit list and count. A missing list is fine only with a valid totalCommitsCount. */
function commitsOf(payload: Record<string, unknown>): { list: Record<string, unknown>[]; count: number } | undefined {
  const total = payload.totalCommitsCount;
  const validTotal = typeof total === "number" && Number.isSafeInteger(total) && total >= 0 ? total : undefined;
  if (payload.commits === undefined) return validTotal === undefined ? undefined : { list: [], count: validTotal };
  if (!Array.isArray(payload.commits) || !payload.commits.every(isRecord)) return undefined;
  const list = payload.commits;
  return { list, count: validTotal ?? list.length };
}

/** The subject (first paragraph) of the commit that is `after`, else of the last entry: the body and trailers stay in the commit. */
function newestMessage(commits: Record<string, unknown>[], after: string): string | undefined {
  const newest = commits.find((commit) => [commit.id, commit.hash, commit.sha].includes(after)) ?? commits[commits.length - 1];
  if (newest === undefined || typeof newest.message !== "string") return undefined;
  const message = clip(newest.message.trim().split(/\n\s*\n/)[0] ?? "", MAX_MESSAGE_LENGTH);
  return message === "" ? undefined : message;
}

function parseJson(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start < 0 || end <= start) return undefined;
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      return undefined;
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
