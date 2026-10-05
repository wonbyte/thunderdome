// Who may call a route. Pure, so the tests run it without the Workers runtime.
import { isTaskId } from "../room/task";

// public: no auth. page: a page served from assets. admin: Bearer ADMIN_TOKEN.
export type Access = "public" | "page" | "admin";

const PUBLIC_ACTIONS = new Set(["steps", "claims", "live", "judge"]);

// An agent name in a fork path: lowercase letters only.
export function isForkAgent(name: string): boolean {
  return /^[a-z]+$/.test(name);
}

// GET /tasks/:id/forks/:agent/diff with a valid id and agent name.
function isDiffPath(pathname: string): boolean {
  const parts = pathname.split("/");
  const [empty, root, id = "", forks, agent = "", diff] = parts;
  return parts.length === 6 && empty === "" && root === "tasks" && isTaskId(id) && forks === "forks" && isForkAgent(agent) && diff === "diff";
}

export function accessFor(method: string, pathname: string): Access {
  if (pathname === "/play" && method === "POST") return "public";
  if (method !== "GET") return "admin";
  if (pathname === "/" || pathname === "/tasks" || pathname === "/play/quota") return "public";
  if (pathname === "/races" || pathname === "/play") return "page";
  if (isDiffPath(pathname)) return "public";
  const [empty, root, id = "", action, ...rest] = pathname.split("/");
  if (empty !== "" || rest.length > 0 || !isTaskId(id)) return "admin";
  if (root === "race" && action === undefined) return "page";
  if (root === "tasks" && (action === undefined || PUBLIC_ACTIONS.has(action))) return "public";
  return "admin";
}

// The asset for a page path: the race page for /race/:id, the gallery for /races, the play form for /play.
export function pageAsset(pathname: string): string | undefined {
  if (pathname === "/races") return "/races.html";
  if (pathname === "/play") return "/play.html";
  const [empty, root, id = "", ...rest] = pathname.split("/");
  if (empty === "" && root === "race" && rest.length === 0 && isTaskId(id)) return "/race.html";
  return undefined;
}
