/**
 * POST /api/internal/live/started   { stream_id, tenant_id, recording_path }
 *
 * Relay tells us the push went live. We flip the tenant's session to live so
 * the dashboard badge reflects reality, and — when the ChalyClip connection
 * is on — forward the start to ChalyClip so it records the stream for
 * clipping. Bearer-authed.
 *
 * stream_id is unique per session (<tenant>__<random>); tenant_id is echoed
 * from authorize but we also recover it from the stream_id as a fallback.
 */

import { NextRequest, NextResponse } from "next/server";
import { checkRelayBearer } from "@/lib/relay-auth";
import {
  getClipsForwardingAllowed,
  getOrCreateSession,
  markSessionLive,
  markStreamStarted,
  tenantFromStreamId,
} from "@/lib/data";
import { chalybclipStarted } from "@/lib/chalybclip";

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!checkRelayBearer(request.headers.get("authorization"))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  let body: { tenant_id?: string; stream_id?: string; recording_path?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const streamId = body.stream_id ?? "";
  const tenantId =
    body.tenant_id ?? (streamId ? tenantFromStreamId(streamId) : null);
  if (!tenantId || !streamId) {
    return new NextResponse(null, { status: 204 });
  }

  // An aborted or ended stream can't start: no live flag, no ChalyClip
  // hand-off; 409 tells the relay to drop the publish.
  let started: boolean;
  try {
    started = await markStreamStarted(tenantId, streamId);
  } catch (e) {
    console.error(`[relay] started failed for ${streamId}: ${e instanceof Error ? e.message : String(e)}`);
    return NextResponse.json({ error: "start_failed" }, { status: 503 });
  }
  if (!started) return NextResponse.json({ error: "stream_not_startable" }, { status: 409 });
  await markSessionLive(tenantId, streamId);

  // Hand off to ChalyClip's pipeline when the connection is on. Forward the
  // operator's broadcast title so ChalyClip shows the real stream name
  // instead of an auto-generated tag. The gate is the connection flag AND the
  // stored tier (a downgraded user keeps clips_enabled=true); its null-default
  // differs from getOrCreateSession's, so don't conflate them.
  if (await getClipsForwardingAllowed(tenantId)) {
    const session = await getOrCreateSession(tenantId);
    await chalybclipStarted({
      streamId,
      tenantId,
      recordingPath: body.recording_path ?? `live/${streamId}`,
      title: session.title,
    });
  }

  return new NextResponse(null, { status: 204 });
}
