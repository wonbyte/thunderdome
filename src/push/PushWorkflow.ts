// Thin Workflow around push.ts: record each fork push in its TaskRoom, then build and save its Workers Preview.
// A base request instead builds the preview of the source at the commit the forks were made from.
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";

import { retry } from "../retry";
import type { PreviewInput, PushInput, PushRecordResult } from "../room/task";
import { CommandError, REPO_DIR } from "../sandbox/ThunderdomeSandbox";
import type { OutboundProps } from "../sandbox/outbound";
import { basePreviewName, parseBaseRequest, parsePushEvent, PREVIEW_CONFIG_PATH, previewConfig, previewName, previewUrl, type BaseRequest } from "./push";

/** The compatibility date of every Workers Preview the push Workflow builds. */
export const PREVIEW_COMPATIBILITY_DATE = "2026-09-15";

// A build takes about 10 s; one that has not finished in 90 s is not coming in time for the judge.
const BUILD_STEP = {
  retries: { limit: 2, delay: "5 seconds", backoff: "constant" },
  timeout: "90 seconds",
} as const;
/** Pushes come in bursts: a build waits this long, then runs only if no newer push replaced its head. */
const PREVIEW_SETTLE = "3 seconds";
/** One build try gives up here, inside BUILD_STEP's timeout, so its failure is still recorded. */
const BUILD_TRY_MS = 80_000;
const TOKEN_TTL_S = 600;
const WORKSPACE = "/workspace";
/** wrangler needs a token; the Outbound Worker replaces the auth header with the real one. */
const API_TOKEN_PLACEHOLDER = "provided-by-worker";

type Sandbox = ReturnType<Env["SANDBOX"]["getByName"]>;

/** What the push Workflow did with one event. */
export type PushOutput =
  | { status: "ignored" }
  | { status: "recorded"; taskId: string; agent: string; after: string }
  | { status: "previewed"; taskId: string; agent: string; after: string; url: string; saved: boolean }
  | { status: "preview-failed"; taskId: string; agent: string; after: string; error: string }
  | { status: "base-previewed"; taskId: string; commit: string; url: string; saved: boolean }
  | { status: "base-preview-failed"; taskId: string; commit: string; error: string };

/** The TaskRoom calls this Workflow makes. */
interface PushRoom {
  recordPush(push: PushInput): Promise<PushRecordResult>;
  savePreview(agent: string, preview: PreviewInput): Promise<boolean>;
  previewFailed(agent: string, commit: string): Promise<boolean>;
  needsPreview(agent: string, commit: string): Promise<boolean>;
  saveBasePreview(preview: PreviewInput): Promise<boolean>;
}

/** What one preview build needs. */
interface PreviewBuild {
  repo: string;
  commit: string;
  name: string;
  sandboxName: string;
}

/**
 * The push Workflow: records each fork push in its TaskRoom and builds the push's Workers Preview.
 * The payload is the Artifacts event itself, or a base request from the TaskRoom for the source's preview.
 */
export class PushWorkflow extends WorkflowEntrypoint<Env> {
  /** Records one push, or a base request, and builds its preview. */
  override async run(event: WorkflowEvent<unknown>, step: WorkflowStep): Promise<PushOutput> {
    const base = parseBaseRequest(event.payload);
    if (base !== undefined) return this.#runBase(base, step);
    const push = parsePushEvent(event.payload);
    if (push === undefined) return { status: "ignored" };
    const { taskId, agent, after } = push;
    const build = await step.do("record push", async () => {
      const result = await room(this.env, taskId).recordPush({ agent, after, commits: push.commits, message: push.message });
      return result.build;
    });
    if (!build) return { status: "recorded", taskId, agent, after };
    // A build for a head a newer push already replaced is a wasted container start.
    await step.sleep("settle", PREVIEW_SETTLE);
    const still = await step.do("still the head", () => room(this.env, taskId).needsPreview(agent, after));
    if (!still) return { status: "recorded", taskId, agent, after };
    let url: string;
    try {
      url = await step.do("build preview", BUILD_STEP, async () => {
        // Each try gets its own sandbox, so a timed-out try still winding down cannot stop the next.
        const sandboxName = `preview-${push.fork}-${after.slice(0, 12)}-${crypto.randomUUID().slice(0, 8)}`;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const late = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`the build took longer than ${BUILD_TRY_MS / 1_000} seconds`)), BUILD_TRY_MS);
        });
        try {
          const building = buildPreview(this.env, { repo: push.fork, commit: after, name: previewName(taskId, agent), sandboxName });
          return await Promise.race([building, late]).catch(async (cause: unknown) => {
            // A timed-out build would keep its container running and might still deploy over a later one.
            await this.env.SANDBOX.getByName(sandboxName).stop().catch(() => undefined);
            throw cause;
          });
        } catch (cause) {
          // Tell the judge's look after the first failed try, not after every retry: it stops waiting.
          // A later try that works still saves the preview, which a look that has not run yet uses.
          await room(this.env, taskId).previewFailed(agent, after).catch(() => false);
          throw cause;
        } finally {
          clearTimeout(timer);
        }
      });
    } catch (cause) {
      // A failed preview must not fail the instance; the push is already recorded. The judge's look
      // is told, so it stops waiting for this preview.
      await step.do("note failed preview", () => room(this.env, taskId).previewFailed(agent, after)).catch(() => false);
      return { status: "preview-failed", taskId, agent, after, error: String(cause) };
    }
    const saved = await step.do("save preview", () => room(this.env, taskId).savePreview(agent, { url, commit: after }));
    return { status: "previewed", taskId, agent, after, url, saved };
  }

  /** Builds the base preview and saves it on the task. A failed build is returned, never thrown. */
  async #runBase(request: BaseRequest, step: WorkflowStep): Promise<PushOutput> {
    const { taskId, repo, commit } = request;
    let url: string;
    try {
      url = await step.do("build base preview", BUILD_STEP, () =>
        buildPreview(this.env, {
          repo,
          commit,
          name: basePreviewName(taskId),
          // The source repo can be shared across tasks, so the sandbox is per task.
          sandboxName: `preview-${taskId}-base-${commit.slice(0, 12)}`,
        }),
      );
    } catch (cause) {
      return { status: "base-preview-failed", taskId, commit, error: String(cause) };
    }
    const saved = await step.do("save base preview", () => room(this.env, taskId).saveBasePreview({ url, commit }));
    return { status: "base-previewed", taskId, commit, url, saved };
  }
}

function room(env: Env, taskId: string): PushRoom {
  return env.TASK_ROOM.getByName(taskId);
}

/**
 * Builds the preview of exactly `commit` in its own sandbox (one per build, so overlapping
 * builds never restart each other's container) and returns its URL.
 */
async function buildPreview(env: Env, build: PreviewBuild): Promise<string> {
  const { remote, token } = await forkAccess(env.ARTIFACTS, build.repo);
  const props: OutboundProps = {
    gitHost: new URL(remote).hostname,
    gitToken: token,
    previewApi: { accountId: env.CF_ACCOUNT_ID, worker: env.PREVIEW_WORKER },
  };
  const sandbox = env.SANDBOX.getByName(build.sandboxName);
  try {
    // A fork can refuse a clone for a short time.
    await retry(() => sandbox.clone(props, remote), { attempts: 5, delayMs: 2_000, shouldRetry: () => true });
    await must(sandbox, ["git", "checkout", "--quiet", "--detach", build.commit], REPO_DIR);
    const config = previewConfig(env.PREVIEW_WORKER, PREVIEW_COMPATIBILITY_DATE);
    await must(sandbox, ["/bin/sh", "-c", 'printf "%s" "$1" > "$2"', "write", config, PREVIEW_CONFIG_PATH], WORKSPACE);
    const stdout = await must(
      sandbox,
      ["wrangler", "preview", "-c", PREVIEW_CONFIG_PATH, "--name", build.name, "--json"],
      WORKSPACE,
      { CLOUDFLARE_API_TOKEN: API_TOKEN_PLACEHOLDER, CLOUDFLARE_ACCOUNT_ID: env.CF_ACCOUNT_ID, WRANGLER_SEND_METRICS: "false" },
    );
    const url = previewUrl(stdout);
    if (url === undefined) throw new Error(`wrangler preview printed no preview URL: ${stdout.slice(-500)}`);
    return url;
  } finally {
    // Best effort: a failed stop must not lose a built preview.
    await sandbox.stop().catch((cause: unknown) => console.error({ event: "preview.stop_failed", repo: build.repo, error: String(cause) }));
  }
}

/** The repo's remote and a short-lived read token for it. */
async function forkAccess(artifacts: Artifacts, name: string): Promise<{ remote: string; token: string }> {
  using repo = await artifacts.get(name);
  const info = await repo.info();
  const token = await repo.createToken("read", TOKEN_TTL_S);
  return { remote: info.remote, token: token.plaintext };
}

async function must(sandbox: Sandbox, argv: string[], cwd: string, env: Record<string, string> = {}): Promise<string> {
  const result = await sandbox.exec(argv, cwd, env);
  if (result.exitCode !== 0) throw new CommandError(argv, result);
  return result.stdout;
}
