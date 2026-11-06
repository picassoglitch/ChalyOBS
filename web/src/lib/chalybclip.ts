import "server-only";

/**
 * ChalyClip handoff — when "Get Clips" is on, ChalyOBS forwards the stream's
 * lifecycle to ChalyClip's internal live webhooks so the recording runs
 * through ChalyClip's (already-tested) auto-clip pipeline.
 *
 * ChalyOBS plays the relay's role toward ChalyClip: same {stream_id,
 * tenant_id, recording_path} contract, same bearer
 * (CHALYBCLIP_INTERNAL_SIGNING_SECRET, shared across relay + ChalyClip +
 * ChalyOBS). ChalyClip pulls the recording from object storage by stream_id.
 *
 * Env:
 *   CHALYBCLIP_INTERNAL_URL   base of ChalyClip's internal API
 *                           (e.g. https://chalybclip.chalyb.com)
 *   CHALYBCLIP_INTERNAL_SECRET bearer == ChalyClip's signing secret
 */

function base(): string | null {
  const v = process.env.CHALYBCLIP_INTERNAL_URL;
  return v ? v.replace(/\/+$/, "") : null;
}

function secret(): string | null {
  return process.env.CHALYBCLIP_INTERNAL_SECRET ?? null;
}

export function isChalybclipConfigured(): boolean {
  return Boolean(base() && secret());
}

/** Register the live stream with ChalyClip so it creates its streams row.
 *  Hits the ChalyOBS-handoff endpoint, which maps external_user_id (our
 *  tenant_id = the Chalyb user id) to ChalyClip's own tenant. */
export async function chalybclipStarted(args: {
  streamId: string;
  tenantId: string;
  recordingPath: string;
  /** Operator's broadcast title; ChalyClip shows it as the stream name
   *  (falls back to an auto session tag when omitted/empty). */
  title?: string;
}): Promise<void> {
  const b = base();
  const s = secret();
  if (!b || !s) return;
  const title = args.title?.trim();
  try {
    await fetch(`${b}/api/internal/chalybobs/started`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${s}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        external_user_id: args.tenantId,
        stream_id: args.streamId,
        recording_path: args.recordingPath,
        ...(title ? { title } : {}),
      }),
      cache: "no-store",
    });
  } catch {
    // Best-effort — never block the relay webhook on a ChalyClip hiccup.
  }
}

/** Tell ChalyClip the stream ended → triggers its auto-clip pipeline. */
/** Forward the end to ChalyClip. Returns false when it should be retried
 *  (network error or 5xx); a 2xx, a 4xx (won't change on retry) or an
 *  unconfigured ChalyClip count as done. */
export async function chalybclipEnded(args: {
  streamId: string;
  tenantId: string;
  durationS?: number;
}): Promise<boolean> {
  const b = base();
  const s = secret();
  if (!b || !s) return true;
  try {
    const res = await fetch(`${b}/api/internal/chalybobs/ended`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${s}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        external_user_id: args.tenantId,
        stream_id: args.streamId,
        ...(args.durationS != null ? { duration_s: args.durationS } : {}),
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status >= 500) {
      console.error(`[chalybclip] ended for ${args.streamId} got ${res.status}; will retry`);
      return false;
    }
    if (!res.ok) console.error(`[chalybclip] ended for ${args.streamId} refused ${res.status}; not retrying`);
    return true;
  } catch (e) {
    console.error(`[chalybclip] ended for ${args.streamId} unreachable; will retry: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}
