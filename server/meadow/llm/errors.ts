export type ProviderErrorType = "AUTH" | "RATE_LIMIT" | "QUOTA" | "INVALID_MODEL" | "NETWORK" | "UNSUPPORTED" | "SERVER" | "CONFIG" | "BAD_REQUEST" | "CANCELLED";

export type ProviderErrorDetails = { type?: ProviderErrorType; provider?: string; retryable?: boolean; retryAfterMs?: number };

/** Normalised provider error. Callers branch on `type` and `retryable`, never on provider-specific text. */
export class LlmError extends Error {
  readonly type: ProviderErrorType;
  readonly provider: string;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;

  constructor(message: string, readonly status?: number, details: ProviderErrorDetails = {}) {
    super(message);
    this.type = details.type ?? (status ? typeFromStatus(status, "") : "SERVER");
    this.provider = details.provider ?? "llm";
    this.retryable = details.retryable ?? ["RATE_LIMIT", "NETWORK", "SERVER"].includes(this.type);
    this.retryAfterMs = details.retryAfterMs;
  }
}

export { LlmError as ProviderError };

function typeFromStatus(status: number, body: string): ProviderErrorType {
  const text = body.toLowerCase();
  if (status === 401 || status === 403) return /quota|billing|credit/.test(text) ? "QUOTA" : "AUTH";
  if (status === 402) return "QUOTA";
  if (status === 429) return /quota|insufficient|exceeded your current|billing|credit/.test(text) ? "QUOTA" : "RATE_LIMIT";
  if (status === 404 || (status === 400 && /model/.test(text) && /not.?found|does not exist|invalid|unknown|unsupported/.test(text))) return "INVALID_MODEL";
  if (status >= 500) return "SERVER";
  return "BAD_REQUEST";
}

const HINT: Record<ProviderErrorType, string> = {
  AUTH: "The API key was rejected. Check it in Runtime settings → Agent model.",
  RATE_LIMIT: "The provider is rate limiting requests. Meadow will back off and retry.",
  QUOTA: "The provider says the quota or credit is used up.",
  INVALID_MODEL: "The selected model doesn't exist for this provider.",
  NETWORK: "The provider could not be reached.",
  UNSUPPORTED: "This provider doesn't support that feature.",
  SERVER: "The provider returned a server error.",
  CONFIG: "The provider is not configured.",
  BAD_REQUEST: "The provider rejected the request.",
  CANCELLED: "The request was cancelled.",
};

export function httpError(provider: string, name: string, status: number, body: string, retryAfter: string | null): LlmError {
  const type = typeFromStatus(status, body);
  const seconds = retryAfter ? Number(retryAfter) : NaN;
  return new LlmError(`${name} ${status}: ${HINT[type]} ${body.replace(/\s+/g, " ").slice(0, 300)}`.trim(), status, { type, provider, retryAfterMs: Number.isFinite(seconds) ? Math.min(seconds * 1000, 60_000) : undefined });
}

export const unsupported = (provider: string, message: string) => new LlmError(message, undefined, { type: "UNSUPPORTED", provider, retryable: false });
export const configError = (provider: string, message: string) => new LlmError(message, undefined, { type: "CONFIG", provider, retryable: false });
