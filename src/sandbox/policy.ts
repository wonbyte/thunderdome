// The outbound policy for sandboxes. Pure, so the tests run it: which hosts a sandbox may reach,
// and which token each request carries. Sandboxes never hold the tokens.

/** The model API host that agent sandboxes may reach with the Worker's key. */
export const MODEL_API_HOST = "api.anthropic.com";
/** The Cloudflare API host; preview sandboxes may reach only the previews API on it. */
export const CLOUDFLARE_API_HOST = "api.cloudflare.com";

/** Lets a preview sandbox call the Workers Previews API for one Worker in one account. */
export interface PreviewApiGrant {
  accountId: string; // 32 lowercase hex chars, else the grant is ignored (refused)
  worker: string; // DNS-label Worker name, else refused
}

/** What one sandbox may reach. The Worker holds the tokens; the sandbox never sees them. */
export interface OutboundProps {
  gitHost: string;
  gitToken: string;
  /**
   * Tokens for single repos on the git host, keyed by repo path "<namespace>/<repo>" (see gitRepoPath).
   * A repo token is sent only for requests to its own repo; every other git request gets gitToken.
   */
  repoTokens?: Record<string, string>;
  /** True for agent sandboxes: they may call the model API with the Worker's key. */
  modelApi?: boolean;
  /** Set for agent sandboxes: who the agent is, for the Thunderdome API (claims). */
  taskId?: string;
  agent?: string;
  /** Set only for preview sandboxes: wrangler preview may call the previews API with the Worker's preview token. */
  previewApi?: PreviewApiGrant;
}

/**
 * Agents reach the Thunderdome API at this path on their git host. The git host resolves in the
 * sandbox (a made-up host name may not), and the Outbound Worker answers these calls itself.
 */
export const THUNDERDOME_API_PREFIX = "/_thunderdome/";

/** True when a request is for the Thunderdome API. Such requests are never forwarded to the git host. */
export function isThunderdomeApi(url: URL, props: OutboundProps): boolean {
  return url.hostname === props.gitHost && url.pathname.startsWith(THUNDERDOME_API_PREFIX);
}

/** The Thunderdome API base URL an agent's claim CLI calls, on its git host. */
export function thunderdomeApiBase(gitHost: string): string {
  return `https://${gitHost}${THUNDERDOME_API_PREFIX.slice(0, -1)}`;
}

/** Whether a sandbox request may go out, with the headers to add, or why it is refused. */
export type OutboundDecision =
  | { allow: true; headers: Record<string, string> }
  | { allow: false; status: number; reason: string };

/** Bearer auth confirmed against a real Artifacts remote (Day 1 spike, Oct 4). */
export function gitAuthHeader(token: string): string {
  return `Bearer ${token}`;
}

/**
 * A segment the git host might read differently than we do: percent-encoded (x%2Egit),
 * with path parameters (x.git;a), or in another case (x.GIT).
 */
function ambiguousSegment(segment: string): boolean {
  return segment.includes("%") || segment.includes(";") || (segment.toLowerCase().endsWith(".git") && !segment.endsWith(".git"));
}

/**
 * "<namespace>/<repo>" for a git URL path: the first segment ending in ".git" (without ".git")
 * and the segment before it. "/git/thunderdome/x.git/info/refs" -> "thunderdome/x"; "/thunderdome/x.git" -> "thunderdome/x".
 * undefined when an ambiguous segment comes first, so a repo token never goes to a path the host
 * may route to another repo.
 */
export function gitRepoPath(url: URL): string | undefined {
  const segments = url.pathname.split("/");
  const i = segments.findIndex((s) => s.endsWith(".git") || ambiguousSegment(s));
  if (i < 1) return undefined;
  const segment = segments[i] ?? "";
  if (ambiguousSegment(segment)) return undefined;
  const repo = segment.slice(0, -".git".length);
  const namespace = segments[i - 1] ?? "";
  if (repo === "" || namespace === "") return undefined;
  return `${namespace}/${repo}`;
}

/** The token for a git host request: its own repo's token when given, else gitToken. */
function gitTokenFor(url: URL, props: OutboundProps): string {
  const path = gitRepoPath(url);
  const tokens = props.repoTokens;
  if (path !== undefined && tokens !== undefined && Object.hasOwn(tokens, path)) {
    return tokens[path] ?? props.gitToken;
  }
  return props.gitToken;
}

const ACCOUNT_ID = /^[0-9a-f]{32}$/;
const WORKER_NAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

function validGrant(grant: PreviewApiGrant): boolean {
  return ACCOUNT_ID.test(grant.accountId) && WORKER_NAME.test(grant.worker);
}

/** "/client/v4/accounts/<accountId>/workers/workers/<worker>/previews" */
export function previewApiPrefix(grant: PreviewApiGrant): string {
  return `/client/v4/accounts/${grant.accountId}/workers/workers/${grant.worker}/previews`;
}

/**
 * A path the API might read differently than we do: encoded, with parameters, backslashes,
 * empty segments ("//") or dot segments. A single trailing "/" is fine.
 */
function ambiguousPath(path: string): boolean {
  if (path.includes("%") || path.includes(";") || path.includes("\\") || path.includes("//")) return true;
  return path.split("/").some((s) => s === "." || s === "..");
}

/** True only for the grant's previews prefix itself or a path under it. */
export function isPreviewApiPath(url: URL, grant: PreviewApiGrant): boolean {
  if (!validGrant(grant)) return false;
  const path = url.pathname;
  const prefix = previewApiPrefix(grant);
  if (path !== prefix && !path.startsWith(`${prefix}/`)) return false;
  return !ambiguousPath(path);
}

/** The previews API for a preview sandbox; everything else to the Cloudflare API is refused. */
function decideCloudflareApi(url: URL, props: OutboundProps, method?: string, previewToken?: string): OutboundDecision {
  const grant = props.previewApi;
  const allowed =
    grant !== undefined && url.port === "" && (method === "GET" || method === "POST") && isPreviewApiPath(url, grant);
  if (!allowed) return { allow: false, status: 403, reason: `${url.hostname}${url.pathname} is not reachable from this sandbox` };
  // A pasted secret can carry a trailing newline.
  const token = previewToken?.trim() ?? "";
  if (token === "") return { allow: false, status: 503, reason: "CLOUDFLARE_PREVIEW_TOKEN is not set on the Worker" };
  return { allow: true, headers: { authorization: `Bearer ${token}` } };
}

/**
 * The policy for one sandbox request: the git host with the right token, the model API for agents,
 * the previews API for preview sandboxes, and nothing else.
 */
export function decideOutbound(
  url: URL,
  props: OutboundProps,
  modelApiKey?: string,
  method?: string,
  previewToken?: string,
): OutboundDecision {
  // A token sent over plain HTTP would cross the Internet unencrypted.
  if (url.protocol !== "https:") {
    return { allow: false, status: 403, reason: `${url.hostname} is reachable only over HTTPS` };
  }
  // Checked first, so the preview token reaches this host only through the preview rule.
  if (url.hostname === CLOUDFLARE_API_HOST) return decideCloudflareApi(url, props, method, previewToken);
  // The Outbound Worker answers Thunderdome API calls itself; they never go to the git host.
  if (isThunderdomeApi(url, props)) return { allow: false, status: 404, reason: "The Thunderdome API is not a git path" };
  if (url.hostname === props.gitHost) {
    return { allow: true, headers: { authorization: gitAuthHeader(gitTokenFor(url, props)) } };
  }
  if (url.hostname === MODEL_API_HOST && props.modelApi === true) {
    // A pasted secret can carry a trailing newline.
    const key = modelApiKey?.trim() ?? "";
    if (key === "") return { allow: false, status: 503, reason: "ANTHROPIC_API_KEY is not set on the Worker" };
    // Replaces the placeholder key the agent starts with.
    return { allow: true, headers: { "x-api-key": key } };
  }
  return { allow: false, status: 403, reason: `${url.hostname} is not reachable from this sandbox` };
}
