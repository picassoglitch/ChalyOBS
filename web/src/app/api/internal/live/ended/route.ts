/**
 * POST /api/internal/live/ended   { stream_id, duration_s? }
 *
 * Relay tells us the publisher disconnected. We recover the tenant from the
 * stream_id (<tenant>__<random>), flip the session back to offline, and —
 * when the ChalyClip connection is on — forward the end to ChalyClip, which
 * runs its auto-clip pipeline on the recording. Bearer-authed.
 */

import { NextRequest, NextResponse } from "next/server";
import { checkRelayBearer } from "@/lib/relay-auth";
import { getClipsEnabled, tenantFromStreamId, updateSession } from "@/lib/data";
import { chalybclipEnded } from "@/lib/chalybclip";

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

  if (await getClipsEnabled(tenantId)) {
    await chalybclipEnded({
      streamId,
      tenantId,
      durationS: typeof body.duration_s === "number" ? body.duration_s : undefined,
    });
  }

  return new NextResponse(null, { status: 204 });
}
