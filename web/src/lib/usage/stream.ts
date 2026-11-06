import "server-only";
import {
  getStreamRecord,
  markStreamEnded,
  recordStreamAdmission,
  getFanoutDestinations,
  claimAuthorizeAttempt,
  dropPendingStream,
  getAttemptState,
  markAttemptFailed,
  mintStreamId,
  takeOverAdmittedStream,
  takeOverStaleClaim,
} from "@/lib/data";
import { getHubClient } from "./hub";
import {
  buildStreamAdmitRequest,
  AUTHORIZE_LEASE_SECONDS,
  AUTHORIZE_WAIT_MS,
  billedDestinations,
  buildStreamMinutesEvent,
  decideAdmission,
  streamDurationSeconds,
  withRetries,
  type AdmissionDecision,
} from "./metering";
import { drainUsageOutbox, enqueueOutbox, type OutboxInsert } from "./outbox";

/**
 * Live-stream consumption lifecycle against the Chalyb hub:
 *   live/authorize → admitStream()    (class "stream", refuses over caps)
 *   live/ended     → finalizeStream() (stream.minutes + settle succeeded)
 */

let warnedDevUnmetered = false;

type Authorized = { streamId: string; decision: AdmissionDecision; reused: boolean };
type Admit = (tenantId: string, streamId: string) => Promise<AdmissionDecision>;

const refuse = (streamId: string, reason: string): Authorized => ({
  streamId,
  decision: { allow: false, error: "usage_unavailable", reason },
  reused: false,
});

/** Admit a claimed row. A throw releases the claim (authorize_error) so a
 *  retry can take it over; a refusal drops the row. */
async function admitClaimed(tenantId: string, streamId: string, admit: Admit): Promise<Authorized> {
  let decision: AdmissionDecision;
  try {
    decision = await admit(tenantId, streamId);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[usage] admission threw for stream ${streamId}; claim released for a retry: ${msg}`);
    await markAttemptFailed(tenantId, streamId, msg);
    return refuse(streamId, "authorize_failed");
  }
  if (!decision.allow) await dropPendingStream(tenantId, streamId);
  return { streamId, decision, reused: false };
}

/** live/authorize. Without an attempt key: mint a stream and admit it.
 *  With the relay's attempt key (stable across its retries for ONE publish):
 *  the first call claims (tenant, key) atomically and admits. A retry with
 *  the same key gets that same stream and hold, once, after it's admitted;
 *  if the admission threw or its lease ran out, ONE retry takes the claim
 *  over and admits again with the same stream_id (hub admit is idempotent
 *  per external_job_id: no second hold). A different key is a different
 *  publish, admitted on its own. Holds are never cancelled here. */
export async function authorizeStream(
  tenantId: string,
  attemptKey: string | null,
  opts: { waitMs?: number; leaseSeconds?: number; admit?: Admit } = {},
): Promise<Authorized> {
  const admit = opts.admit ?? admitStream;
  const newId = mintStreamId(tenantId);
  if (!attemptKey) return { streamId: newId, decision: await admit(tenantId, newId), reused: false };

  const deadline = Date.now() + (opts.waitMs ?? AUTHORIZE_WAIT_MS);
  const leaseMs = (opts.leaseSeconds ?? AUTHORIZE_LEASE_SECONDS) * 1000;
  let existing = newId;
  try {
    for (;;) {
      const held = await claimAuthorizeAttempt(tenantId, attemptKey, newId);
      if (held === null) return await admitClaimed(tenantId, newId, admit);
      existing = held;

      const state = await getAttemptState(tenantId, existing);
      if (state === undefined) {
        // The first call was refused and dropped its row: claim afresh.
        if (Date.now() >= deadline) break;
        continue;
      }
      if (!state.authorizing && !state.failed) {
        const taken = await takeOverAdmittedStream(tenantId, existing);
        if (!taken) return refuse(existing, "authorize_attempt_used");
        console.warn(`[usage] authorize retry reuses stream ${existing} (reservation ${taken.reservationId ?? "-"})`);
        return {
          streamId: existing,
          decision: { allow: true, reservationId: taken.reservationId, lane: taken.lane, metered: taken.reservationId !== null },
          reused: true,
        };
      }
      const staleBefore = new Date(Date.now() - leaseMs);
      if (state.failed || Date.parse(state.admittedAt) < staleBefore.getTime()) {
        if (await takeOverStaleClaim(tenantId, existing, staleBefore)) {
          console.warn(`[usage] authorize retry takes over ${state.failed ? "failed" : "stale"} claim ${existing}`);
          return await admitClaimed(tenantId, existing, admit);
        }
      }
      if (Date.now() >= deadline) break;
      await new Promise((r) => setTimeout(r, 250));
    }
  } catch (e) {
    console.error(`[usage] authorize claim failed for ${tenantId}: ${e instanceof Error ? e.message : String(e)}`);
    return refuse(existing, "authorize_claim_failed");
  }
  return refuse(existing, "authorize_in_progress");
}

/** Ask the hub whether this tenant may go live, and persist the reservation
 *  on the stream row. Fails closed when the hub is configured but
 *  unreachable; allows unmetered only when CHALYB_BASE_URL is unset (dev). */
export async function admitStream(
  tenantId: string,
  streamId: string,
): Promise<AdmissionDecision> {
  const { client, misconfigured } = getHubClient();
  // Destinations and price locked at authorize: the relay only gets this set
  // for the stream, and live/ended bills this count. Unreadable = refuse.
  let destinationIds: string[];
  try {
    destinationIds = (await getFanoutDestinations(tenantId)).map((d) => d.id);
  } catch (e) {
    console.error(
      `[usage] refusing stream ${streamId}: ${e instanceof Error ? e.message : String(e)}`,
    );
    return { allow: false, error: "usage_unavailable", reason: "destinations_unavailable" };
  }
  const destinations = destinationIds.length;
  let decision: AdmissionDecision;
  if (!client) {
    decision = decideAdmission(misconfigured ? "misconfigured" : "disabled");
    if (!misconfigured && !warnedDevUnmetered) {
      warnedDevUnmetered = true;
      console.warn("[usage] CHALYB_BASE_URL unset — live streams are NOT admitted or metered (dev mode)");
    }
  } else {
    const res = await client.admit(buildStreamAdmitRequest({ tenantId, streamId, destinations }));
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
      destinations,
      destinationIds,
    });
    if (!stored) {
      // Without the row the relay gets no destinations and live/ended can't
      // bill: refuse, and hand the hold back instead of letting it sit 8 h.
      console.error(
        `[usage] refusing stream ${streamId}: could not persist its admission (reservation ${decision.reservationId ?? "-"})`,
      );
      if (client && decision.reservationId) {
        const released = await client.settle(decision.reservationId, "cancelled");
        if (!released.ok) {
          console.error(
            `[usage] could not release reservation ${decision.reservationId}: ${released.status ?? "network"} ${released.message}`,
          );
        }
      }
      return { allow: false, error: "usage_unavailable", reason: "admission_not_stored" };
    }
  }
  return decision;
}

/** Report the finished stream's minutes and close its reservation. Writes
 *  both to the durable outbox, then drains. Idempotent per stream_id.
 *  Throws when the stream row can't be read (after retries): nothing is
 *  enqueued and the stream isn't marked ended, so a later live/ended can
 *  still bill it with its reservation. */
export async function finalizeStream(args: {
  tenantId: string;
  streamId: string;
  reportedDurationS?: number;
}): Promise<void> {
  const now = new Date();
  const record = await withRetries(
    () => getStreamRecord(args.tenantId, args.streamId),
    [250, 1000],
  );
  if (!record) {
    // Every admitted stream has a row (admission refuses otherwise): a
    // missing one can't be priced or settled, so don't guess one copy.
    throw new Error(`live/ended for unknown stream ${args.streamId}: no admission row`);
  }
  if (record.endedAt) {
    // Relay retried live/ended — already enqueued; just nudge delivery.
    await drainUsageOutbox();
    return;
  }

  const durationS = streamDurationSeconds({
    reportedS: args.reportedDurationS,
    startedAt: record.startedAt ?? record.admittedAt ?? null,
    now,
  });
  const reservationId = record.reservationId;
  // The copies locked at authorize, not today's destination list. Rows
  // admitted before 0027 have no count and bill one copy.
  const destinations = billedDestinations(record.destinations);

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
