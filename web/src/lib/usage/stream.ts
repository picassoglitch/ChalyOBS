import "server-only";
import {
  getStreamRecord,
  markStreamEnded,
  recordStreamAdmission,
  getFanoutDestinations,
} from "@/lib/data";
import { getHubClient } from "./hub";
import {
  buildStreamAdmitRequest,
  buildStreamMinutesEvent,
  decideAdmission,
  streamDurationSeconds,
  type AdmissionDecision,
} from "./metering";
import { drainUsageOutbox, enqueueOutbox, type OutboxInsert } from "./outbox";

/**
 * Live-stream consumption lifecycle against the Chalyb hub:
 *   live/authorize → admitStream()    (class "stream", refuses over caps)
 *   live/ended     → finalizeStream() (stream.minutes + settle succeeded)
 */

let warnedDevUnmetered = false;

/** Ask the hub whether this tenant may go live, and persist the reservation
 *  on the stream row. Fails closed when the hub is configured but
 *  unreachable; allows unmetered only when CHALYB_BASE_URL is unset (dev). */
export async function admitStream(
  tenantId: string,
  streamId: string,
): Promise<AdmissionDecision> {
  const { client, misconfigured } = getHubClient();
  let decision: AdmissionDecision;
  if (!client) {
    decision = decideAdmission(misconfigured ? "misconfigured" : "disabled");
    if (!misconfigured && !warnedDevUnmetered) {
      warnedDevUnmetered = true;
      console.warn("[usage] CHALYB_BASE_URL unset — live streams are NOT admitted or metered (dev mode)");
    }
  } else {
    const res = await client.admit(buildStreamAdmitRequest({ tenantId, streamId }));
    if (!res.ok) {
      console.error(
        `[usage] admit failed for stream ${streamId} (failing closed): ${res.status ?? "network"} ${res.message}`,
      );
    }
    decision = decideAdmission(res);
  }

  if (decision.allow) {
    const stored = await recordStreamAdmission({
      streamId,
      tenantId,
      reservationId: decision.reservationId,
      lane: decision.lane,
    });
    if (!stored && decision.reservationId) {
      // The stream still goes out (the hub admitted it), but live/ended
      // won't find the reservation: usage is reported without it and the
      // reservation lapses at its TTL.
      console.error(
        `[usage] could not persist reservation ${decision.reservationId} for stream ${streamId}`,
      );
    }
  }
  return decision;
}

/** Report the finished stream's minutes and close its reservation. Writes
 *  both to the durable outbox, then drains. Idempotent per stream_id. */
export async function finalizeStream(args: {
  tenantId: string;
  streamId: string;
  reportedDurationS?: number;
}): Promise<void> {
  const now = new Date();
  const record = await getStreamRecord(args.tenantId, args.streamId);
  if (record?.endedAt) {
    // Relay retried live/ended — already enqueued; just nudge delivery.
    await drainUsageOutbox();
    return;
  }

  const durationS = streamDurationSeconds({
    reportedS: args.reportedDurationS,
    startedAt: record?.startedAt ?? record?.admittedAt ?? null,
    now,
  });
  const reservationId = record?.reservationId ?? null;
  // Egress scales with fan-out: one copy per enabled destination.
  const destinations = await getFanoutDestinations(args.tenantId)
    .then((d) => d.length)
    .catch(() => 1);
  if (!record) {
    console.warn(
      `[usage] live/ended for unknown stream ${args.streamId} — reporting without reservation`,
    );
  }

  const rows: OutboxInsert[] = [
    {
      tenantId: args.tenantId,
      kind: "usage",
      dedupeKey: `stream.minutes:${args.streamId}`,
      reservationId,
      payload: {
        external_user_id: args.tenantId,
        events: [
          buildStreamMinutesEvent({
            streamId: args.streamId,
            durationS,
            reservationId,
            occurredAt: now,
            destinations,
          }),
        ],
      },
    },
  ];
  if (reservationId) {
    rows.push({
      tenantId: args.tenantId,
      kind: "settle",
      dedupeKey: `settle:${reservationId}:succeeded`,
      reservationId,
      payload: { reservation_id: reservationId, outcome: "succeeded" },
    });
  }

  if (await enqueueOutbox(rows)) {
    await markStreamEnded(args.tenantId, args.streamId, Math.round(durationS));
    await drainUsageOutbox();
    return;
  }
  // DB unavailable: nothing durable. Deliver directly, once, in order; the
  // full rows were already logged by enqueueOutbox for manual replay.
  const { client } = getHubClient();
  if (!client) return;
  for (const row of rows) {
    const res =
      row.kind === "settle"
        ? await client.settle(reservationId as string, "succeeded")
        : await client.reportUsage(row.payload as Parameters<typeof client.reportUsage>[0]);
    if (!res.ok) {
      console.error(
        `[usage] DIRECT DELIVERY FAILED (no outbox) ${row.kind} ${row.dedupeKey}: ${res.status ?? "network"} ${res.message}`,
      );
      if (row.kind === "usage") break; // never settle before the spend lands
    }
  }
}
