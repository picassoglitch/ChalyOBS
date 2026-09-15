/**
 * GET /api/internal/live/destinations?stream_id=<tenant>__<random>
 *
 * Called by the chalybclip-live relay's on_ready hook to fan the single
 * ingest out to every enabled + configured platform. Returns each as a
 * complete RTMP push URL (ingest + key) the relay feeds to
 * `ffmpeg -c copy -f flv`.
 *
 * Contract (matches chalybclip-live/scripts/on_ready.sh):
 *   Auth:  Authorization: Bearer <CHALYBOBS_RELAY_SECRET>
 *   200:   { destinations: [{ platform, push_url }] }
 */

import { NextRequest, NextResponse } from "next/server";
import { checkRelayBearer } from "@/lib/relay-auth";
import { getFanoutDestinations, tenantFromStreamId } from "@/lib/data";

export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!checkRelayBearer(request.headers.get("authorization"))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const streamId = request.nextUrl.searchParams.get("stream_id");
  const tenant = streamId ? tenantFromStreamId(streamId) : null;
  if (!tenant) {
    return NextResponse.json({ destinations: [] });
  }

  const destinations = await getFanoutDestinations(tenant);
  return NextResponse.json({ destinations });
}
