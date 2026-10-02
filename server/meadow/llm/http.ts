import { assertEndpointAllowed, type ResolvedProvider } from "./catalog";
import { httpError, LlmError } from "./errors";

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** POST/GET with endpoint policy, timeout, cancellation and bounded retries for rate limits, network and server errors. */
export async function providerFetch(resolved: ResolvedProvider, url: string, init: RequestInit, attempts = 4): Promise<Response> {
  assertEndpointAllowed(resolved, url);
  const id = resolved.def.id;
  let lastError: LlmError | null = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), resolved.timeoutMs);
    const outer = init.signal;
    const onAbort = () => controller.abort();
    outer?.addEventListener("abort", onAbort, { once: true });
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      if (response.ok) return response;
      const error = httpError(id, resolved.name, response.status, await response.text(), response.headers.get("retry-after"));
      if (!error.retryable) throw error;
      lastError = error;
    } catch (error) {
      if (error instanceof LlmError && !error.retryable) throw error;
      if (outer?.aborted) throw new LlmError("Request cancelled", undefined, { type: "CANCELLED", provider: id, retryable: false });
      if (error instanceof LlmError) lastError = error;
      else if ((error as Error).name === "AbortError") lastError = new LlmError(`${resolved.name} request timed out after ${Math.round(resolved.timeoutMs / 1000)}s`, undefined, { type: "NETWORK", provider: id });
      else lastError = new LlmError(`Cannot reach ${resolved.name} at ${new URL(url).origin}. Is it running? (${(error as Error).message})`, undefined, { type: "NETWORK", provider: id });
    } finally {
      clearTimeout(timer);
      outer?.removeEventListener("abort", onAbort);
    }
    if (attempt < attempts - 1) await sleep(lastError?.retryAfterMs ?? Math.min(8000, 600 * 2 ** attempt));
  }
  throw lastError ?? new LlmError(`${resolved.name} request failed`, undefined, { provider: id });
}
