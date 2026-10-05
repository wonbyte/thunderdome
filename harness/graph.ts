// The shape of one build task. run.ts is generic; each task is harness/tasks/<name>.ts + <name>.md.

export interface NodeSpec {
  id: string;
  title: string;
  owns: string[]; // the only files this node may write; a failure in one of them comes back here
  tests: string[];
  required: string[];
  maxAttempts: number;
  brief: string;
  regenTypes?: boolean; // code runs `npm run types` before the check
}

export interface TaskGraph {
  branch: string; // the run must start on this branch, with a clean tree
  nodes: NodeSpec[]; // build nodes, run in order
  planTask: string; // first line of the N1 prompt: what to plan and which files to read
  extraAllowed: string[]; // files outside node ownership the done check allows
}
