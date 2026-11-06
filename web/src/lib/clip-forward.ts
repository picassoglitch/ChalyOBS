/**
 * How to treat the answer to ChalyClip's 'ended'. ChalyClip's 'ended' is
 * idempotent per stream (ChalyClip PR "Live 'ended' is idempotent per
 * stream"), so anything that may not have landed is retried: a 5xx, a
 * timeout, a reset or a refused connection. A 2xx or 4xx is final.
 * Dependency-free for node --test.
 */
export type ClipEndedOutcome = "done" | "retry";

export function classifyClipEnded(r: { status?: number }): ClipEndedOutcome {
  if (r.status === undefined) return "retry";
  return r.status >= 500 ? "retry" : "done";
}
