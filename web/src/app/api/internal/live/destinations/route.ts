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
import { getFanoutDestinations, getStreamDestinationIds, tenantFromStreamId } from "@/lib/data";
import { lockedFanout } from "@/lib/usage/metering";

export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!checkRelayBearer(request.headers.get("authorization"))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const streamId = request.nextUrl.searchParams.get("stream_id");
  const tenant = streamId ? tenantFromStreamId(streamId) : null;
  if (!tenant) {
    return NextResponse.json({ destinations: [] });
  }

  // Only the set locked at authorize: a destination added mid-stream starts
  // on the next stream. A read error is a 503, and the relay then keeps its
  // current legs and polls again.
  let destinations;
  try {
    const [current, locked] = await Promise.all([
      getFanoutDestinations(tenant),
      getStreamDestinationIds(tenant, streamId as string),
    ]);
    destinations = lockedFanout(current, locked).map(({ platform, push_url }) => ({ platform, push_url }));
  } catch (e) {
    console.error(`[relay] destinations failed for ${streamId}: ${e instanceof Error ? e.message : String(e)}`);
    return NextResponse.json({ error: "destinations_unavailable" }, { status: 503 });
  }
  return NextResponse.json({ destinations });
}
