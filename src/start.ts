import { retry } from "./retry";

// Creates Workflow instance `id`, retrying a failed create (the service can answer
// "internal error"). An instance that already exists counts as started, so a retry
// after a create that did land is safe. Throws the last error when every attempt fails.
export async function startWorkflow<P>(
  binding: Pick<Workflow<P>, "create" | "get">,
  id: string,
  params: P,
  sleep?: (ms: number) => Promise<void>,
): Promise<void> {
  await retry(
    async () => {
      try {
        await binding.create({ id, params });
      } catch (cause) {
        if (!(await exists(binding, id))) throw cause;
      }
    },
    { attempts: START_ATTEMPTS, delayMs: START_DELAY_MS, shouldRetry: () => true },
    sleep,
  );
}

export const START_ATTEMPTS = 4;
const START_DELAY_MS = 2_000;

async function exists(binding: Pick<Workflow, "get">, id: string): Promise<boolean> {
  try {
    await binding.get(id);
    return true;
  } catch {
    return false;
  }
}
