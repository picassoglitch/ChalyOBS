/**
 * POST /api/internal/live/started   { stream_id, tenant_id, recording_path }
 *
 * Relay tells us the push went live. We flip the tenant's session to live so
 * the dashboard badge reflects reality, and — when the NexoClip connection
 * is on — forward the start to NexoClip so it records the stream for
 * clipping. Bearer-authed.
 *
 * stream_id is unique per session (<tenant>__<random>); tenant_id is echoed
 * from authorize but we also recover it from the stream_id as a fallback.
 */

import { NextRequest, NextResponse } from "next/server";
import { checkRelayBearer } from "@/lib/relay-auth";
import {
  getClipsEnabled,
  getOrCreateSession,
  tenantFromStreamId,
  updateSession,
} from "@/lib/data";
import { nexoclipStarted } from "@/lib/nexoclip";

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

  await updateSession(tenantId, { isLive: true });

  // Hand off to NexoClip's pipeline when the connection is on. Forward the
  // operator's broadcast title so NexoClip shows the real stream name
  // instead of an auto-generated tag. (getClipsEnabled stays the gate — its
  // null-default differs from getOrCreateSession's, so don't conflate them.)
  if (await getClipsEnabled(tenantId)) {
    const session = await getOrCreateSession(tenantId);
    await nexoclipStarted({
      streamId,
      tenantId,
      recordingPath: body.recording_path ?? `live/${streamId}`,
      title: session.title,
    });
  }

  return new NextResponse(null, { status: 204 });
}
