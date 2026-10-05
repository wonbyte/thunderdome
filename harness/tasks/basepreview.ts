// "Before" preview at race start (PLAN.md Day 9). Graph: harness/tasks/basepreview.md.
import type { NodeSpec, TaskGraph } from "../graph.ts";

const nodes: NodeSpec[] = [
  {
    id: "N2",
    title: "base request core",
    owns: ["src/push/push.ts", "test/push.test.ts"],
    tests: ["test/push.test.ts"],
    required: ["B1", "B2"],
    maxAttempts: 4,
    brief:
      "In src/push/push.ts (pure, no cloudflare:workers import): `basePreviewName(taskId)` returns `<taskId>-base`, checked like previewName (valid task id, DNS label, at most MAX_PREVIEW_NAME_LENGTH); throws on a bad task id. " +
      "Export `BaseRequest` = `{ kind: \"base\"; taskId: string; repo: string; commit: string }` and `parseBaseRequest(payload)`: the request when kind is \"base\", taskId passes isTaskId, repo passes isRepoName (src/artifacts/repo.ts), and commit matches the same commit pattern parsePushEvent uses (not all zeros); undefined for anything else; never throws. " +
      "parsePushEvent must return undefined for a base request (it already requires the event type; add a test), and parseBaseRequest must return undefined for an Artifacts push event. Keep every existing export and test unchanged.",
  },
  {
    id: "N3",
    title: "task state",
    owns: ["src/room/task.ts", "test/task.test.ts"],
    tests: ["test/task.test.ts"],
    required: ["B3", "B4", "B5"],
    maxAttempts: 4,
    brief:
      "In src/room/task.ts: makeForks also returns `base`, the source repo's head commit hash, read with latestCommit (src/artifacts/repo.ts) after the agent forks are made, for both a repo task and a template task (the fresh source); if reading it fails or there is no commit, base is undefined and makeForks still succeeds (log nothing here; the caller decides). Update existing makeForks tests for the new return field; the fake repo's log mock (test/fakes.ts, not yours to edit) returns [] by default, so override it per test with `fakeRepo({ log: vi.fn(async () => [{ hash: ... }]) })` as needed. " +
      "Task gets `baseCommit?: string` and `basePreview?: Preview`. `applyBasePreview(task, preview: PreviewInput, now)`: saves `{ url, commit, at: now }` and returns true only when task.baseCommit is set and equals preview.commit; else returns false and leaves the task unchanged. " +
      "`baseRequest(task)`: `{ kind: \"base\", taskId: task.id, repo: task.repo, commit: task.baseCommit }` as the BaseRequest type from src/push/push.ts, or undefined when baseCommit is not set. Import the type only (`import type`), so task.ts keeps no runtime import of push.ts.",
  },
  {
    id: "N4",
    title: "workflow + room",
    owns: ["src/push/PushWorkflow.ts", "src/room/TaskRoom.ts", "README.md"],
    tests: ["test"],
    required: [],
    maxAttempts: 4,
    brief:
      "PushWorkflow.run: first try parseBaseRequest(event.payload); for a base request, step `build base preview` (same BUILD_STEP options) builds the preview of request.repo at request.commit named basePreviewName(taskId), then step `save base preview` calls the room's saveBasePreview({ url, commit }); a failed build returns a `base-preview-failed` output and never throws. Otherwise keep today's push path exactly. " +
      "Refactor buildPreview to take `{ repo, commit, name, sandboxName }` so both paths share it (the agent path passes push.fork, push.after, previewName(...), and today's sandbox name; the base path uses repo, commit, basePreviewName(...), and `preview-<repo>-<commit first 12>`); forkAccess already works for any repo name. Extend the PushOutput union and the PushRoom interface; remove the TODO cast only if TaskRoom's methods now type-check without it, otherwise keep it. " +
      "TaskRoom.create: store `task.baseCommit = base` from makeForks when it is defined. TaskRoom.run: after the agents are started and the task is saved, if baseRequest(task) is defined, `await this.env.PUSH.create({ id: `${task.id}-base`, params: request })` inside try/catch that only logs (console.error with event \"base_preview.start_failed\"); never fail or delay the run's result on it. " +
      "TaskRoom.saveBasePreview(preview: PreviewInput): applyBasePreview; on true save the task and broadcast `{ kind: \"base-preview\", taskId, preview: task.basePreview }` (add the variant to LiveEvent); return the boolean. " +
      "README: in the previews section, one or two sentences: each race also gets a base preview of the source at the start (`basePreview` in GET /tasks/:id, `base-preview` on the live socket), the \"before\" picture next to the agents' previews. The check for this step is the full test suite.",
  },
];

export const task: TaskGraph = {
  branch: "harness/basepreview",
  nodes,
  planTask:
    "Plan Thunderdome's base (\"before\") preview at race start (PLAN.md Day 9). " +
    "Read harness/tasks/basepreview.md, src/push/push.ts, src/push/PushWorkflow.ts, src/room/task.ts, src/room/TaskRoom.ts, src/artifacts/repo.ts, test/push.test.ts, test/task.test.ts, test/fakes.ts, and the README previews section, then call submit_plan.",
  extraAllowed: [],
};
