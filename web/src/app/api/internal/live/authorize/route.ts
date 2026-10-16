/**
 * POST /api/internal/live/authorize
 *
 * Called by the chalybclip-live relay's on_ready hook when an encoder pushes
 * RTMP to live/<stream_key>. We validate the key against chalybobs_sessions,
 * ask the Chalyb hub to admit the stream (class "stream": tier, balance,
 * concurrency and monthly stream caps live there), and return the tenant so
 * the relay can register + fan out.
 *
 * Contract (matches chalybclip-live/scripts/on_ready.sh):
 *   Auth:  Authorization: Bearer <CHALYBOBS_RELAY_SECRET>
 *   Body:  { path: "live/<key>", action: "publish", ip }
 *   200:   { stream_id, tenant_id, recording_path }
 *   401/403: rejected → relay ignores the push (ages out)
 *     403 { error: "usage_refused", reason }      hub said no (caps/balance)
 *     403 { error: "usage_unavailable", reason }  hub unreachable → fail closed
 */

import { after, NextRequest, NextResponse } from "next/server";
import { checkRelayBearer } from "@/lib/relay-auth";
import { getTenantByStreamKey, mintStreamId } from "@/lib/data";
import { admitStream } from "@/lib/usage/stream";
import { drainUsageOutbox } from "@/lib/usage/outbox";

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!checkRelayBearer(request.headers.get("authorization"))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: { path?: string };
  try {
    body = (await request.json()) as { path?: string };
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  // path = "live/<stream_key>" — take everything after the last slash.
  const path = body.path ?? "";
  const key = path.includes("/") ? path.slice(path.lastIndexOf("/") + 1) : path;
  if (!key) {
    return NextResponse.json({ error: "missing_key" }, { status: 400 });
  }

  const tenantId = await getTenantByStreamKey(key);
  if (!tenantId) {
    // Unknown key → reject. Relay records then ages out the local copy.
    return NextResponse.json({ error: "unknown_stream_key" }, { status: 403 });
  }

  // Fresh, unique stream id per session — encodes the tenant
  // (<tenant>__<random>) so the recording prefix is tenant-namespaced and
  // every session is its own recording/clip set. The relay echoes this back
  // on destinations/started/ended; we recover the tenant from it. It is also
  // the hub's external_job_id for this session's reservation.
  const streamId = mintStreamId(tenantId);

  const admission = await admitStream(tenantId, streamId);
  // Flush any usage left over from earlier sessions without delaying the relay.
  after(() => drainUsageOutbox());
  if (!admission.allow) {
    return NextResponse.json(
      { error: admission.error, reason: admission.reason },
      { status: 403 },
    );
  }

  return NextResponse.json({
    stream_id: streamId,
    tenant_id: tenantId,
    recording_path: `live/${streamId}`,
  });
}
