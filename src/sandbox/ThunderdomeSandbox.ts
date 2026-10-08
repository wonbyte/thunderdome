// The ThunderdomeSandbox container Durable Object: clones a fork, runs an agent in the background
// and reports its steps, and runs git and tests for the judge, the fusion round and shipping.

import { Files, SandboxFileError } from "@cloudflare/sandbox";
import { DurableObject } from "cloudflare:workers";

import { clip, parseEvent, resultOf, splitLines, stepsOf, type RunResult, type Step } from "../agents/events";
import { agentCommand, gitIdentity, POLL_INTERVAL_MS, type AgentOutcome, type AgentSpec } from "../agents/runner";
import type { AgentName } from "../agents/prompt";
import { retry } from "../retry";
import { coloOf, traceColo } from "../room/regions";
import type { Outbound, OutboundProps } from "./outbound";
import { thunderdomeApiBase } from "./policy";

/** Where a sandbox clones the repo it works on. */
export const REPO_DIR = "/workspace/repo";
// Every step stops its container when done; this only limits a leak after a failed step.
const INACTIVITY_TIMEOUT_MS = 10 * 60 * 1_000;
const PROPS_KEY = "outbound-props";
const CA_PATH = "/etc/cloudflare/certs/cloudflare-containers-ca.crt";

/** Agent run files live outside the repo, so they stay out of the diff. */
const RUN_DIR = "/workspace/run";
const EVENTS_PATH = `${RUN_DIR}/events.jsonl`;
const STDERR_PATH = `${RUN_DIR}/stderr.log`;
const EXIT_PATH = `${RUN_DIR}/exit-code`;
const PID_PATH = `${RUN_DIR}/pid`;
const RUN_KEY = "agent-run";
/** Prints the colo the Thunderdome API answers for this container; 5 s at most. */
const WHERE_SCRIPT = `fetch(process.argv[1], { signal: AbortSignal.timeout(5000) }).then((r) => r.json()).then((b) => process.stdout.write(String(b.colo ?? "")))`;
/** Any Cloudflare-served host answers this with the colo that served it. */
const TRACE_URL = "https://www.cloudflare.com/cdn-cgi/trace";
const READ_CHUNK_BYTES = 1 << 20;
/**
 * Output goes to files, so the agent keeps running after the request that started it ends.
 * setsid gives the agent its own process group, so a timeout stops it and its children.
 */
const RUN_SCRIPT = `echo $$ > ${PID_PATH}
"$@" > ${EVENTS_PATH} 2> ${STDERR_PATH}
printf '%s\\n' "$?" > ${EXIT_PATH}.tmp && mv ${EXIT_PATH}.tmp ${EXIT_PATH}`;

/** What the alarm needs to follow one agent run. */
interface AgentRun {
  taskId: string;
  agent: AgentName;
  defaultBranch: string;
  deadline: number;
  /** The fork head before the agent started. */
  base: string;
  /** Bytes of EVENTS_PATH already turned into steps. */
  offset: number;
  result?: RunResult;
}

/** exec() does not inherit start() env. Intercepted HTTPS is signed by this CA. */
const TRUST_ENV = {
  NODE_EXTRA_CA_CERTS: CA_PATH,
  GIT_SSL_CAINFO: CA_PATH,
  CURL_CA_BUNDLE: CA_PATH,
  SSL_CERT_FILE: CA_PATH,
};

/** The exit code and output of one command in the container. */
export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** A command that exited non-zero, with its argv and output. */
export class CommandError extends Error {
  constructor(
    readonly argv: string[],
    readonly result: CommandResult,
  ) {
    super(`${argv.join(" ")} exited with ${result.exitCode}: ${result.stderr.slice(-1_000)}`);
    this.name = "CommandError";
  }
}

interface ThunderdomeSandboxState extends DurableObjectState {
  readonly exports: Cloudflare.Exports & { readonly Outbound: LoopbackForExport<typeof Outbound> };
}

/** One sandbox per agent fork. It can reach only that fork's git host, plus the model API when it runs an agent. */
export class ThunderdomeSandbox extends DurableObject<Env> {
  readonly #state: ThunderdomeSandboxState;
  readonly #container: Container;
  readonly #files: Files;

  constructor(ctx: ThunderdomeSandboxState, env: Env) {
    super(ctx, env);
    this.#state = ctx;
    if (ctx.container === undefined) throw new Error("Container attachment is unavailable");
    this.#container = ctx.container;
    this.#files = new Files(this.#container);
    // Each Durable Object instance must set the timeout again; a new instance does not inherit it.
    if (this.#container.running) {
      void ctx.blockConcurrencyWhile(() => this.#container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS));
    }
  }

  /**
   * Starts the container for one git host and token. A new token restarts the container,
   * because outbound intercepts last for one container run.
   */
  async ensureStarted(props: OutboundProps): Promise<void> {
    const same = JSON.stringify(this.ctx.storage.kv.get(PROPS_KEY)) === JSON.stringify(props);
    if (this.#container.running && same) return;
    if (this.#container.running) await this.#container.destroy();
    this.#container.start({
      image: this.#container.images.sandbox!,
      instance: "standard-1",
      enableInternet: false,
      labels: { app: "thunderdome" },
    });
    const outbound = this.#state.exports.Outbound({ props });
    await this.#container.interceptAllOutboundHttp(outbound);
    await this.#container.interceptOutboundHttps("*", outbound);
    await this.#container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);
    this.ctx.storage.kv.put(PROPS_KEY, props);
  }

  /** Makes the first commit of a new repo from a set of files and pushes it. */
  async seed(props: OutboundProps, remote: string, files: Record<string, string>): Promise<string> {
    await this.ensureStarted(props);
    await this.#files.remove(REPO_DIR, { recursive: true, force: true });
    await this.#files.mkdir(REPO_DIR, { recursive: true });
    for (const [path, content] of Object.entries(files)) {
      const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
      if (parent !== "") await this.#files.mkdir(parent, { cwd: REPO_DIR, recursive: true });
      await this.#files.writeFile(path, content, { cwd: REPO_DIR });
    }
    await this.#must(["git", "init", "--initial-branch=main"]);
    await this.#must(["git", "add", "--all"]);
    await this.#must(["git", "commit", "--message", "Seed sample app"]);
    await this.#must(["git", "remote", "add", "origin", remote]);
    await this.#must(["git", "push", "--set-upstream", "origin", "main"]);
    return (await this.#must(["git", "rev-parse", "HEAD"])).stdout.trim();
  }

  /** Clones a fork into REPO_DIR, replacing any earlier clone. */
  async clone(props: OutboundProps, remote: string): Promise<void> {
    await this.ensureStarted(props);
    await this.#files.remove(REPO_DIR, { recursive: true, force: true });
    await this.#must(["git", "clone", "--", remote, REPO_DIR], "/workspace");
  }

  /** Writes a file; a relative path is under the repo clone. */
  async writeFile(path: string, content: string): Promise<void> {
    await this.#files.writeFile(path, content, { cwd: REPO_DIR });
  }

  /** Commits every change in REPO_DIR and pushes it. Returns the new commit hash. */
  async commitAndPush(message: string): Promise<string> {
    await this.#must(["git", "add", "--all"]);
    await this.#must(["git", "commit", "--message", message]);
    await this.#must(["git", "push", "origin", "HEAD"]);
    return (await this.#must(["git", "rev-parse", "HEAD"])).stdout.trim();
  }

  /** Clones the fork and starts the agent in the background. The alarm follows it from here. */
  async startAgent(spec: AgentSpec): Promise<{ base: string; colo?: string }> {
    if (this.ctx.storage.kv.get(RUN_KEY) !== undefined) throw new Error(`An agent already runs in ${spec.fork}`);
    const props: OutboundProps = {
      gitHost: new URL(spec.remote).hostname,
      gitToken: spec.token,
      modelApi: true,
      taskId: spec.taskId,
      agent: spec.agent,
    };
    await retry(() => this.clone(props, spec.remote), {
      attempts: 10,
      delayMs: 2_000,
      // A fresh fork can refuse a clone for a short time.
      shouldRetry: () => true,
    });
    const base = (await this.#must(["git", "rev-parse", "HEAD"])).stdout.trim();
    const colo = await this.#where(props, spec.fork);
    await this.#files.remove(RUN_DIR, { recursive: true, force: true });
    await this.#files.mkdir(RUN_DIR, { recursive: true });
    const { argv, env } = agentCommand(spec);
    await this.#container.exec(["setsid", "--wait", "/bin/sh", "-c", RUN_SCRIPT, "agent", ...argv], {
      cwd: REPO_DIR,
      env: { ...TRUST_ENV, ...env },
      stdout: "ignore",
      stderr: "ignore",
    });
    const run: AgentRun = {
      taskId: spec.taskId,
      agent: spec.agent,
      defaultBranch: spec.defaultBranch,
      deadline: spec.deadline,
      base,
      offset: 0,
    };
    this.ctx.storage.kv.put(RUN_KEY, run);
    await this.ctx.storage.setAlarm(Date.now() + POLL_INTERVAL_MS);
    return colo === undefined ? { base } : { base, colo };
  }

  /**
   * Where the container runs: the data center the Thunderdome API saw its request at. Asked from
   * inside the container, before the agent starts. A failed answer never fails the start.
   */
  async #where(props: OutboundProps, fork: string): Promise<string | undefined> {
    try {
      const out = await this.#execRaw(["node", "-e", WHERE_SCRIPT, `${thunderdomeApiBase(props.gitHost)}/where`], REPO_DIR, {});
      const container = coloOf(out.stdout);
      // Day-one check: a container may start away from its Durable Object; the log shows both.
      const object = traceColo(await (await fetch(TRACE_URL, { signal: AbortSignal.timeout(5_000) })).text());
      console.log({ event: "sandbox.where", fork, container, object });
      return container;
    } catch (error) {
      console.error({ event: "sandbox.where_failed", fork, error: String(error).slice(0, 200) });
      return undefined;
    }
  }

  /** Sends new steps to the TaskRoom, and ends the run when the agent exits or time runs out. */
  override async alarm(): Promise<void> {
    const run = this.ctx.storage.kv.get<AgentRun>(RUN_KEY);
    if (run === undefined) return;
    const room = this.env.TASK_ROOM.getByName(run.taskId);
    if (!this.#container.running) {
      await room.agentFinished(run.agent, { end: "failed", pushed: false, error: "The sandbox stopped before the agent finished" });
      this.ctx.storage.kv.delete(RUN_KEY);
      return;
    }
    await this.#flushSteps(run);
    const state = await this.#agentState();
    if (state === "running" && Date.now() < run.deadline) {
      await this.ctx.storage.setAlarm(Date.now() + POLL_INTERVAL_MS);
      return;
    }
    if (state === "running") await this.#killAgent();
    await this.#flushSteps(run);
    const outcome = await this.#endRun(run, state === "running" ? "timeout" : undefined);
    await room.agentFinished(run.agent, outcome);
    this.ctx.storage.kv.delete(RUN_KEY);
    await this.stop();
  }

  /**
   * Runs argv in the container and returns its exit code and output. A non-zero exit is not an
   * error here.
   */
  async exec(argv: string[], cwd: string = REPO_DIR, env: Record<string, string> = {}): Promise<CommandResult> {
    const output = await this.#execRaw(argv, cwd, env);
    const decoder = new TextDecoder();
    return {
      exitCode: output.exitCode,
      stdout: decoder.decode(output.stdout),
      stderr: decoder.decode(output.stderr),
    };
  }

  /** Forgets the outbound props and stops the container. */
  async stop(): Promise<void> {
    this.ctx.storage.kv.delete(PROPS_KEY);
    if (this.#container.running) await this.#container.destroy();
  }

  async #execRaw(argv: string[], cwd: string, env: Record<string, string>): Promise<ExecOutput> {
    const process = await this.#container.exec(argv, { cwd, env: { ...TRUST_ENV, ...env } });
    return process.output();
  }

  async #must(argv: string[], cwd: string = REPO_DIR, env: Record<string, string> = {}): Promise<CommandResult> {
    const result = await this.exec(argv, cwd, env);
    if (result.exitCode !== 0) throw new CommandError(argv, result);
    return result;
  }

  /** Reads the complete new lines of the agent's output and sends their steps to the TaskRoom. */
  async #flushSteps(run: AgentRun): Promise<void> {
    const steps: Step[] = [];
    for (;;) {
      const output = await this.#execRaw(
        ["/bin/sh", "-c", 'tail -c +"$1" "$2" 2>/dev/null | head -c "$3"', "read", String(run.offset + 1), EVENTS_PATH, String(READ_CHUNK_BYTES)],
        "/",
        {},
      );
      const { lines, consumed } = splitLines(new Uint8Array(output.stdout));
      for (const line of lines) {
        const event = parseEvent(line);
        run.result = resultOf(event) ?? run.result;
        steps.push(...stepsOf(event));
      }
      // A full chunk with no newline is one line longer than a chunk: skip past it, or the reader
      // would stop on it forever. The rest of that line fails to parse and adds no steps.
      const oversized = consumed === 0 && output.stdout.byteLength >= READ_CHUNK_BYTES;
      run.offset += oversized ? output.stdout.byteLength : consumed;
      if ((consumed === 0 && !oversized) || output.stdout.byteLength < READ_CHUNK_BYTES) break;
    }
    this.ctx.storage.kv.put(RUN_KEY, run);
    if (steps.length > 0) await this.env.TASK_ROOM.getByName(run.taskId).agentSteps(run.agent, steps);
  }

  async #agentState(): Promise<"running" | "exited" | "lost"> {
    if ((await this.#readText(EXIT_PATH)) !== undefined) return "exited";
    const pid = await this.#readText(PID_PATH);
    // The pid file is written as the agent starts; without it, give the agent one more poll.
    if (pid === undefined) return "running";
    // kill is a shell builtin; the slim image has no kill binary.
    const probe = await this.exec(["/bin/sh", "-c", 'kill -0 "$1"', "probe", pid.trim()], "/");
    if (probe.exitCode === 0) return "running";
    // The agent can exit after the first read; its wrapper writes the exit code first.
    return (await this.#readText(EXIT_PATH)) !== undefined ? "exited" : "lost";
  }

  async #killAgent(): Promise<void> {
    const pid = await this.#readText(PID_PATH);
    if (pid === undefined) return;
    await this.exec(["bash", "-c", 'kill -TERM -- -"$1"; sleep 2; kill -KILL -- -"$1" 2>/dev/null; true', "stop", pid.trim()], "/");
  }

  /** Commits what the agent left, pushes the fork, and says how the run ended. */
  async #endRun(run: AgentRun, forced?: "timeout"): Promise<AgentOutcome> {
    const outcome: AgentOutcome = { end: forced ?? "done", pushed: false, costUsd: run.result?.costUsd, turns: run.result?.turns };
    if (run.result !== undefined) outcome.summary = clip(run.result.text, 2_000);
    if (forced === undefined && (run.result === undefined || run.result.isError)) {
      outcome.end = "failed";
      const stderr = (await this.#readText(STDERR_PATH)) ?? "";
      outcome.error = clip(run.result?.text ?? `The agent exited without a result: ${stderr.slice(-1_000)}`, 2_000);
    }
    try {
      const identity = gitIdentity(run.agent);
      await this.#must(["git", "add", "--all"], REPO_DIR, identity);
      const staged = await this.exec(["git", "diff", "--cached", "--quiet"], REPO_DIR, identity);
      if (staged.exitCode !== 0) {
        await this.#must(["git", "commit", "--message", `Thunderdome ${run.agent}: work left at the end of the run`], REPO_DIR, identity);
      }
      outcome.commit = (await this.#must(["git", "rev-parse", "HEAD"])).stdout.trim();
      if (outcome.commit !== run.base) {
        await this.#must(["git", "push", "origin", `HEAD:refs/heads/${run.defaultBranch}`]);
        outcome.pushed = true;
      }
    } catch (cause) {
      outcome.end = "failed";
      outcome.error = clip(`${outcome.error ?? ""} Saving the work failed: ${String(cause)}`, 2_000);
    }
    return outcome;
  }

  async #readText(path: string): Promise<string | undefined> {
    try {
      return await (await this.#files.readFile(path)).text();
    } catch (cause) {
      if (SandboxFileError.is(cause) && cause.code === "ENOENT") return undefined;
      throw cause;
    }
  }
}
