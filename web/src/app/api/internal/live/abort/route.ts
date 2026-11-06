/** lint:allow-long-comment — relay contract, same as the sibling live/* routes.
 * POST /api/internal/live/abort   { path, stream_id?, attempt_key? }
 *
 * The relay authorized a publish, but the publisher was gone (or the relay
 * couldn't confirm it) before 'started'. Releases the hold — the hub
 * reservation is settled 'cancelled', no usage is reported — and marks the
 * stream aborted + ended so nothing can bill or reuse it. Only for a stream
 * that never started. Identified by stream_id, or by the relay's attempt_key
 * when the authorize answer never arrived.
 *
 *   204  aborted, or nothing to abort (idempotent)
 *   409  { error: "already_started" }  — use live/ended
 *   503  admission still running or a DB error — the relay retries
 *   400/401/403 as the other relay routes
 */

import { NextRequest, NextResponse } from "next/server";
import { checkRelayBearer } from "@/lib/relay-auth";
import {
  abortUnstartedStream,
  findStreamByAttemptKey,
  getTenantByStreamKey,
  tenantFromStreamId,
} from "@/lib/data";
import { parseAttemptKey } from "@/lib/usage/metering";
import { drainUsageOutbox, enqueueOutbox } from "@/lib/usage/outbox";
import { resolveLostHold } from "@/lib/usage/stream";

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!checkRelayBearer(request.headers.get("authorization"))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  let body: { path?: unknown; stream_id?: unknown; attempt_key?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  try {
    // The publisher's stream key names the tenant; a stream_id must belong to it.
    const path = typeof body.path === "string" ? body.path : "";
    const key = path.includes("/") ? path.slice(path.lastIndexOf("/") + 1) : path;
    const tenantId = key ? await getTenantByStreamKey(key) : null;
    if (!tenantId) return NextResponse.json({ error: "unknown_stream_key" }, { status: 403 });

    let streamId: string | null;
    if (typeof body.stream_id === "string" && body.stream_id) {
      if (tenantFromStreamId(body.stream_id) !== tenantId) {
        return NextResponse.json({ error: "stream_not_yours" }, { status: 403 });
      }
      streamId = body.stream_id;
    } else {
      const attemptKey = parseAttemptKey(body.attempt_key);
      if (!attemptKey) {
        return NextResponse.json({ error: "stream_id_or_attempt_key_required" }, { status: 400 });
      }
      streamId = await findStreamByAttemptKey(tenantId, attemptKey);
      if (!streamId) return new NextResponse(null, { status: 204 }); // never admitted
    }

    const result = await abortUnstartedStream(tenantId, streamId);
    if (result.kind === "started") {
      return NextResponse.json({ error: "already_started" }, { status: 409 });
    }
    if (result.kind === "authorizing") {
      return NextResponse.json({ error: "authorize_in_progress" }, { status: 503 });
    }
    let reservationId = result.kind === "aborted" ? result.reservationId : null;
    if (result.kind === "aborted" && !reservationId && result.admitUnknown) {
      // The admit answer was lost: find the hold by job id (idempotent admit).
      reservationId = await resolveLostHold(tenantId, streamId);
    }
    if (result.kind === "aborted" && reservationId) {
      const queued = await enqueueOutbox([
        {
          tenantId,
          kind: "settle",
          dedupeKey: `settle:${reservationId}:cancelled`,
          reservationId,
          payload: { reservation_id: reservationId, outcome: "cancelled" },
        },
      ]);
      if (!queued) {
        // The stream stays aborted; the relay's retry re-queues the (deduped) release.
        return NextResponse.json({ error: "release_not_queued" }, { status: 503 });
      }
      await drainUsageOutbox();
      console.warn(`[usage] aborted never-started stream ${streamId}; hold ${reservationId} released`);
    }
    return new NextResponse(null, { status: 204 });
  } catch (e) {
    console.error(`[usage] abort failed: ${e instanceof Error ? e.message : String(e)}`);
    return NextResponse.json({ error: "abort_failed" }, { status: 503 });
  }
}
