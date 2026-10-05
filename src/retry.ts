// Runs fn until it succeeds, or until attempts run out. Retries only errors that
// shouldRetry accepts.
export async function retry<T>(
  fn: () => Promise<T>,
  options: { attempts: number; delayMs: number; shouldRetry: (cause: unknown) => boolean },
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (cause) {
      if (attempt >= options.attempts || !options.shouldRetry(cause)) throw cause;
      await sleep(options.delayMs);
    }
  }
}
