// Day 1 spike: prove that a Worker can fork an Artifacts repo and a sandbox can push to the fork.
import { forkFor, isRepoName, latestCommit, notReady, openOrCreate, SAMPLE_REPO } from "./artifacts/repo";
import { DEFAULT_APP, DEMO_APPS } from "./generated/sample-files";
import { retry } from "./retry";
import type { OutboundProps } from "./sandbox/outbound";

function outboundFor(remote: string, token: string): OutboundProps {
  return { gitHost: new URL(remote).hostname, gitToken: token };
}

export function isDemoApp(app: string): boolean {
  return Object.hasOwn(DEMO_APPS, app);
}

// Creates a repo (thunderdome-sample by default) and pushes a demo app (demo/<app>) into it, once.
// Seed a template repo here, then create tasks with { template } so races never change it.
export async function seedSample(env: Env, name = SAMPLE_REPO, app = DEFAULT_APP) {
  if (!isRepoName(name)) throw new Error(`Invalid repo name: ${name}`);
  const files = DEMO_APPS[app];
  if (files === undefined) throw new Error(`Unknown demo app: ${app}`);
  const repo = await openOrCreate(env.ARTIFACTS, name, "Thunderdome sample app");
  const existing = repo.created ? undefined : await latestCommit(env.ARTIFACTS, name);
  if (existing !== undefined) return { repo: name, app, head: existing.hash, seeded: false };
  const head = await env.SANDBOX.getByName("seed").seed(
    outboundFor(repo.remote, repo.token),
    repo.remote,
    files,
  );
  return { repo: name, app, head, seeded: true };
}

// Seed (if needed) → fork → clone in a sandbox → commit → push → read the commit back.
export async function runDay1(env: Env) {
  const seed = await seedSample(env);
  const name = `spike-${Date.now().toString(36)}`;
  const fork = await forkFor(env.ARTIFACTS, SAMPLE_REPO, name, "Thunderdome Day 1 spike fork");
  const sandbox = env.SANDBOX.getByName(name);
  try {
    await retry(() => sandbox.clone(outboundFor(fork.remote, fork.token), fork.remote), {
      attempts: 10,
      delayMs: 2_000,
      // A fresh fork can refuse a clone for a short time.
      shouldRetry: () => true,
    });
    await sandbox.writeFile("SPIKE.md", `Pushed from sandbox ${name} at ${new Date().toISOString()}\n`);
    const pushed = await sandbox.commitAndPush(`Day 1 spike push from ${name}`);
    const seen = await retry(() => latestCommit(env.ARTIFACTS, name), {
      attempts: 5,
      delayMs: 1_000,
      shouldRetry: notReady,
    });
    return {
      ok: seen?.hash === pushed,
      seed,
      fork: { name, remote: fork.remote },
      pushedCommit: pushed,
      commitSeenByBinding: seen ?? null,
    };
  } finally {
    await sandbox.stop();
  }
}
