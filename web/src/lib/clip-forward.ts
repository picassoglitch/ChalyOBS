/**
 * How to treat the answer to ChalyClip's 'ended'. ChalyClip clips again on
 * a repeat 'ended' (it resets a processed stream), so only a call that
 * certainly never reached it may be retried. Dependency-free for node --test.
 */
export type ClipEndedOutcome = "done" | "retry" | "unknown";

/** Errors raised before the request left this process. */
const NOT_DELIVERED = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH"]);

export function classifyClipEnded(r: { status?: number; errorCode?: string }): ClipEndedOutcome {
  if (r.status !== undefined) return r.status >= 500 ? "unknown" : "done";
  return r.errorCode && NOT_DELIVERED.has(r.errorCode) ? "retry" : "unknown";
}

/** The system error code behind a failed fetch (undici puts it on cause). */
export function fetchErrorCode(e: unknown): string | undefined {
  const cause = (e as { cause?: { code?: unknown } } | null)?.cause;
  return typeof cause?.code === "string" ? cause.code : undefined;
}
