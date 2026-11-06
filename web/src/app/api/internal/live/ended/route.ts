/**
 * POST /api/internal/live/ended   { stream_id, duration_s? }
 *
 * Relay tells us the publisher disconnected. We recover the tenant from the
 * stream_id (<tenant>__<random>), flip the session back to offline, report
 * the session's stream.minutes to the Chalyb hub and settle its reservation
 * (durable outbox — see lib/usage), and — when the ChalyClip connection is on
 * AND the stored tier is still full-access — forward the end to ChalyClip,
 * which runs its auto-clip pipeline on the recording. Bearer-authed.
 */

import { NextRequest, NextResponse } from "next/server";
import { checkRelayBearer } from "@/lib/relay-auth";
import {
  claimClipForward,
  getClipsForwardingAllowed,
  markSessionOfflineIfCurrent,
  releaseClipForward,
  tenantFromStreamId,
} from "@/lib/data";
import { chalybclipEnded } from "@/lib/chalybclip";
import { finalizeStream } from "@/lib/usage/stream";

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!checkRelayBearer(request.headers.get("authorization"))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  let body: { stream_id?: string; duration_s?: number };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const streamId = body.stream_id;
  if (!streamId) return new NextResponse(null, { status: 204 });

  const tenantId = tenantFromStreamId(streamId);
  if (!tenantId) return new NextResponse(null, { status: 204 });

  // Only if the session is still live with THIS stream: a late or retried
  // 'ended' for an older stream must not take a newer one offline.
  await markSessionOfflineIfCurrent(tenantId, streamId);

  const durationS =
    typeof body.duration_s === "number" ? body.duration_s : undefined;

  let finalized = true;
  try {
    await finalizeStream({ tenantId, streamId, reportedDurationS: durationS });
  } catch (e) {
    finalized = false;
    // Usage/settle may be missing for this stream. Logged with what a
    // manual replay needs; 503 so the relay reports the webhook as failed.
    console.error(
      `[usage] FINALIZE FAILED — this stream may be unbilled/unsettled: stream=${streamId} tenant=${tenantId} duration_s=${durationS ?? "-"}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  // Re-check the tier, not just the toggle: a user downgraded after turning
  // the ChalyClip connection on keeps clips_enabled=true. Handed off once per
  // stream (a repeat 'ended' makes ChalyClip clip again); a ChalyClip 5xx or
  // outage releases the hand-off and answers 503 so the relay retries.
  let clipsOk = true;
  if (finalized && (await getClipsForwardingAllowed(tenantId))) {
    try {
      if (await claimClipForward(tenantId, streamId)) {
        clipsOk = await chalybclipEnded({ streamId, tenantId, durationS });
        if (!clipsOk) await releaseClipForward(tenantId, streamId);
      }
    } catch (e) {
      clipsOk = false;
      console.error(`[chalybclip] hand-off failed for ${streamId}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (!finalized) return NextResponse.json({ error: "finalize_failed" }, { status: 503 });
  if (!clipsOk) return NextResponse.json({ error: "clips_forward_failed" }, { status: 503 });
  return new NextResponse(null, { status: 204 });
}
