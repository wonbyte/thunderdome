// Seeding the demo apps: a repo per app in demo/, pushed once from a sandbox.
import { isRepoName, latestCommit, openOrCreate, SAMPLE_REPO } from "./artifacts/repo";
import { DEFAULT_APP, DEMO_APPS } from "./generated/sample-files";
import type { OutboundProps } from "./sandbox/outbound";

function outboundFor(remote: string, token: string): OutboundProps {
  return { gitHost: new URL(remote).hostname, gitToken: token };
}

/** True when `app` is one of the demo apps packed from demo/. */
export function isDemoApp(app: string): boolean {
  return Object.hasOwn(DEMO_APPS, app);
}

/**
 * Creates a repo (thunderdome-sample by default) and pushes a demo app (demo/<app>) into it, once.
 * Seed a template repo here, then create tasks with { template } so races never change it.
 */
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
