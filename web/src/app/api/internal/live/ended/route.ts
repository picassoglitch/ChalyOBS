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
  getClipsForwardingAllowed,
  tenantFromStreamId,
  updateSession,
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

  await updateSession(tenantId, { isLive: false });

  const durationS =
    typeof body.duration_s === "number" ? body.duration_s : undefined;

  try {
    await finalizeStream({ tenantId, streamId, reportedDurationS: durationS });
  } catch (e) {
    // Never fail the relay webhook; the outbox/logs carry the detail.
    console.error(
      `[usage] finalize failed for stream ${streamId}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  // Re-check the tier, not just the toggle: a user downgraded after turning
  // the ChalyClip connection on keeps clips_enabled=true.
  if (await getClipsForwardingAllowed(tenantId)) {
    await chalybclipEnded({ streamId, tenantId, durationS });
  }

  return new NextResponse(null, { status: 204 });
}
