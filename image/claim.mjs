#!/usr/bin/env node
// claim: the Thunderdome claim board CLI for agents. Installed in the sandbox image as /usr/local/bin/claim.
//
//   claim <file>...            claim files before you edit them
//   claim --shared <file>...   claim files as shared on purpose
//
// A file another agent already holds is claimed as shared and reported as a clash. Changing a
// file you hold only as shared lowers your score when another agent solves the task without it.
//   claim --release [<file>...] release files, or all of your files
//   claim --list               show who holds what
//
// Exit codes: 0 done, 2 usage or server error.

const USAGE = "usage: claim [--shared] <file>... | claim --release [<file>...] | claim --list";
const api = process.env.THUNDERDOME_API;

async function call(method, path, body) {
  const init = body === undefined ? { method } : { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
  const response = await fetch(`${api}/${path}`, init);
  let data;
  try {
    data = await response.json();
  } catch {
    data = { error: `HTTP ${response.status}` };
  }
  return { status: response.status, data };
}

function fail(message, code = 2) {
  console.error(message);
  process.exit(code);
}

async function main(args) {
  if (!api) fail("claim: THUNDERDOME_API is not set; this sandbox runs no agent");
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) fail(USAGE);

  if (args[0] === "--list") {
    const { status, data } = await call("GET", "claims");
    if (status !== 200) fail(`claim: ${data.error ?? `HTTP ${status}`}`);
    if (data.active.length === 0) return console.log("No files are claimed.");
    for (const claim of data.active) console.log(`${claim.file}\t${claim.agent}${claim.shared ? " (shared)" : ""}`);
    return;
  }

  if (args[0] === "--release") {
    const files = args.slice(1);
    const { status, data } = await call("POST", "release", files.length === 0 ? {} : { files });
    if (status !== 200) fail(`claim: ${data.error ?? `HTTP ${status}`}`);
    return console.log(data.released.length === 0 ? "Released nothing." : `Released: ${data.released.join(", ")}`);
  }

  const shared = args[0] === "--shared";
  const files = shared ? args.slice(1) : args;
  if (files.length === 0 || files.some((file) => file.startsWith("--"))) fail(USAGE);
  const { status, data } = await call("POST", "claims", { files, shared });
  if (status !== 200) fail(`claim: ${data.error ?? `HTTP ${status}`}`);
  const own = data.claimed.filter((file) => !data.shared.includes(file));
  if (own.length > 0) console.log(`Claimed: ${own.join(", ")}`);
  if (data.shared.length > 0) console.log(`Shared claim: ${data.shared.join(", ")}`);
  if (data.clashes.length > 0) {
    console.error("Clash: other agents already hold these files, so your claim on them is shared:");
    for (const clash of data.clashes) console.error(`  ${clash.file}: ${clash.heldBy.join(", ")}`);
    console.error("You may still edit them, but changing a shared file lowers your score when another agent solves the task without it. Prefer other files if you can.");
  }
  if (data.already.length > 0) console.log(`Already yours: ${data.already.join(", ")}`);
}

main(process.argv.slice(2)).catch((cause) => fail(`claim: ${cause.message ?? cause}`));
