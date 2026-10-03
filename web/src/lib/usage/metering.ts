/**
 * Live-stream metering — pure logic (no I/O), so it unit-tests under plain
 * `node --test`. The Supabase-backed outbox and the route wiring live in
 * outbox.ts / stream.ts.
 *
 * Contract: chalyb docs/engines/consumption-contract.md.
 */

import type { AdmitRequest, AdmitResponse, HubResult, UsageEvent } from "./hub";

export const STREAM_OPERATION = "live.stream";
export const STREAM_METER_KIND = "stream.minutes";
/** Who incurs the cost: the chalybclip-live relay's egress/compute on GCP. */
export const STREAM_METER_PROVIDER = "gcp";

/**
 * Reservation TTL for a live stream. The relay exposes NO periodic callback
 * while a stream is live (only authorize → destinations → started → ended),
 * so nothing can send `outcome: "heartbeat"`. The TTL therefore has to cover
 * a long session on its own. 8 h covers the vast majority of streams; a
 * longer one keeps streaming fine (the relay never re-asks), its reservation
 * just stops counting toward concurrency after 8 h. The cost is still
 * metered in full on live/ended. Trade-off: if the relay dies without
 * calling live/ended, the stale reservation holds a concurrency slot for up
 * to 8 h.
 */
export const STREAM_RESERVATION_TTL_SECONDS = 8 * 60 * 60;

/**
 * Relay + egress cost per streamed minute, in USD micros.
 *
 * TODO(pricing): conservative PLACEHOLDER ($0.002/min = $0.12/h). Replace
 * with the real figure from the chalybclip-live relay's GCP billing export
 * (Cloud Run/GCE instance-seconds of the MediaMTX + ffmpeg fan-out host,
 * plus network egress × number of fan-out destinations, plus the recording
 * write to object storage), divided by streamed minutes.
 */
export const STREAM_COST_USD_MICROS_PER_MINUTE = 2000;

/** Admission estimate: reserve one hour's worth up front. Actual spend is
 *  reported on live/ended. */
export const STREAM_EST_MINUTES = 60;

/** Contract: billable_tokens = ceil(cost_usd_micros / 4). */
export const MICROS_PER_BILLABLE_TOKEN = 4;

/** Contract caps: 0 ≤ cost_usd_micros ≤ 10^9 per event. */
const MAX_COST_USD_MICROS = 1_000_000_000;

export function streamEstTokens(): number {
  return Math.ceil(
    (STREAM_EST_MINUTES * STREAM_COST_USD_MICROS_PER_MINUTE) /
      MICROS_PER_BILLABLE_TOKEN,
  );
}

export function buildStreamAdmitRequest(args: {
  tenantId: string;
  streamId: string;
}): AdmitRequest {
  return {
    external_user_id: args.tenantId,
    // Stable per stream session (minted once in live/authorize), so a relay
    // retry of the same session re-admits to the same reservation.
    external_job_id: args.streamId,
    class: "stream",
    operation: STREAM_OPERATION,
    est_tokens: streamEstTokens(),
    upload_mb: 0,
    source_minutes: 0,
    storage_mb_after: 0,
    // Streams never run on the boost lane; false also guarantees no boost
    // fee is charged on settle.
    boost: false,
    ttl_seconds: STREAM_RESERVATION_TTL_SECONDS,
  };
}

export type AdmissionDecision =
  | { allow: true; reservationId: string | null; lane: string | null; metered: boolean }
  | { allow: false; error: string; reason?: string };

/**
 * Turn a hub admit result into an authorize decision.
 *   hub === "disabled"      → CHALYB_BASE_URL unset (dev): allow, unmetered.
 *   hub === "misconfigured" → base URL set, bearer missing: fail closed.
 *   transport/HTTP failure  → fail closed (never stream unmetered in prod).
 *   allowed=false           → refuse with the hub's reason.
 */
export function decideAdmission(
  hub: "disabled" | "misconfigured" | HubResult<AdmitResponse>,
): AdmissionDecision {
  if (hub === "disabled") {
    return { allow: true, reservationId: null, lane: null, metered: false };
  }
  if (hub === "misconfigured") {
    return { allow: false, error: "usage_unavailable", reason: "hub_token_missing" };
  }
  if (!hub.ok) {
    return { allow: false, error: "usage_unavailable", reason: "hub_unreachable" };
  }
  if (hub.data.allowed !== true) {
    return {
      allow: false,
      error: "usage_refused",
      reason: hub.data.reason ?? "refused",
    };
  }
  if (!hub.data.reservation_id) {
    // Admitted without a reservation would leave nothing to settle — treat
    // as a hub contract violation and fail closed.
    return { allow: false, error: "usage_unavailable", reason: "no_reservation" };
  }
  return {
    allow: true,
    reservationId: hub.data.reservation_id,
    lane: hub.data.lane ?? null,
    metered: true,
  };
}

/**
 * Duration of a finished stream in seconds. Prefer the relay's reported
 * duration_s; fall back to wall time since started (or admitted).
 */
export function streamDurationSeconds(args: {
  reportedS?: number | null;
  startedAt?: string | null;
  now: Date;
}): number {
  if (
    typeof args.reportedS === "number" &&
    Number.isFinite(args.reportedS) &&
    args.reportedS >= 0
  ) {
    return args.reportedS;
  }
  if (args.startedAt) {
    const t = Date.parse(args.startedAt);
    if (Number.isFinite(t)) return Math.max(0, (args.now.getTime() - t) / 1000);
  }
  return 0;
}

/** Whole minutes, rounded up (a 61 s stream bills 2 minutes). */
export function streamMinutes(durationS: number): number {
  if (!Number.isFinite(durationS) || durationS <= 0) return 0;
  return Math.ceil(durationS / 60);
}

export function streamCostUsdMicros(minutes: number): number {
  return Math.min(
    MAX_COST_USD_MICROS,
    Math.max(0, Math.round(minutes)) * STREAM_COST_USD_MICROS_PER_MINUTE,
  );
}

export function buildStreamMinutesEvent(args: {
  streamId: string;
  durationS: number;
  reservationId: string | null;
  occurredAt: Date;
}): UsageEvent {
  const minutes = streamMinutes(args.durationS);
  const event: UsageEvent = {
    kind: STREAM_METER_KIND,
    provider: STREAM_METER_PROVIDER,
    amount: minutes,
    cost_usd_micros: streamCostUsdMicros(minutes),
    // Idempotent on the hub: (engine, source_id) is unique.
    source_id: args.streamId,
    occurred_at: args.occurredAt.toISOString(),
    operation: STREAM_OPERATION,
    metadata: {
      stream_id: args.streamId,
      duration_s: Math.round(args.durationS),
      rate_usd_micros_per_minute: STREAM_COST_USD_MICROS_PER_MINUTE,
    },
  };
  if (args.reservationId) event.reservation_id = args.reservationId;
  return event;
}

// ── Outbox drain ────────────────────────────────────────────────────────────

export type OutboxKind = "usage" | "settle";

export interface OutboxRow {
  id: number;
  kind: OutboxKind;
  reservation_id: string | null;
  payload: unknown;
  attempts: number;
  next_attempt_at: string;
}

export interface OutboxStore {
  /** Pending rows in insertion order (id asc), due or not. */
  listPending(limit: number): Promise<OutboxRow[]>;
  markSent(id: number, attempts: number): Promise<void>;
  markRetry(id: number, attempts: number, nextAttemptAt: Date, error: string): Promise<void>;
  markDead(id: number, attempts: number, error: string): Promise<void>;
}

export type OutboxSend = (
  row: OutboxRow,
) => Promise<{ ok: true } | { ok: false; status?: number; message: string }>;

/** Contract: a 4xx other than 408/429 is permanent (includes 422). */
export function isPermanentFailure(status: number | undefined): boolean {
  return (
    status !== undefined &&
    status >= 400 &&
    status < 500 &&
    status !== 408 &&
    status !== 429
  );
}

/** 30 s, 60 s, 2 min, … capped at 1 h. Never gives up (contract: don't drop). */
export function backoffSeconds(attempts: number): number {
  const n = Math.max(1, attempts);
  return Math.min(3600, 30 * 2 ** Math.min(n - 1, 20));
}

export interface DrainStats {
  sent: number;
  retried: number;
  dead: number;
  skipped: number;
}

/**
 * Deliver due outbox rows. Ordering rule: a reservation's `settle` row is
 * held back while a `usage` row for the same reservation is still pending,
 * so the hub always sees the spend before the reservation closes.
 */
export async function drainOutbox(
  store: OutboxStore,
  send: OutboxSend,
  opts: { now?: Date; limit?: number; log?: (msg: string) => void } = {},
): Promise<DrainStats> {
  const now = opts.now ?? new Date();
  const log = opts.log ?? ((m: string) => console.error(m));
  const stats: DrainStats = { sent: 0, retried: 0, dead: 0, skipped: 0 };
  const blocked = new Set<string>();

  const rows = await store.listPending(opts.limit ?? 50);
  for (const row of rows) {
    const res = row.reservation_id;
    if (row.kind === "settle" && res && blocked.has(res)) {
      stats.skipped++;
      continue;
    }
    if (Date.parse(row.next_attempt_at) > now.getTime()) {
      if (row.kind === "usage" && res) blocked.add(res);
      stats.skipped++;
      continue;
    }

    const attempts = row.attempts + 1;
    let result: Awaited<ReturnType<OutboxSend>>;
    try {
      result = await send(row);
    } catch (e) {
      result = { ok: false, message: e instanceof Error ? e.message : String(e) };
    }

    if (result.ok) {
      await store.markSent(row.id, attempts);
      stats.sent++;
      continue;
    }
    const detail = `${result.status ?? "network"} ${result.message}`.trim();
    if (isPermanentFailure(result.status)) {
      // Do not drop: keep the row as 'dead' for inspection and alert.
      log(
        `[usage-outbox] DEAD row id=${row.id} kind=${row.kind} reservation=${res ?? "-"} — hub rejected permanently: ${detail}`,
      );
      await store.markDead(row.id, attempts, detail);
      stats.dead++;
      continue;
    }
    const next = new Date(now.getTime() + backoffSeconds(attempts) * 1000);
    log(
      `[usage-outbox] delivery failed id=${row.id} kind=${row.kind} attempt=${attempts} — retry at ${next.toISOString()}: ${detail}`,
    );
    await store.markRetry(row.id, attempts, next, detail);
    if (row.kind === "usage" && res) blocked.add(res);
    stats.retried++;
  }
  return stats;
}
