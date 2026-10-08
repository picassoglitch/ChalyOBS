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
 * Relay egress per streamed minute, per fan-out destination, in USD micros.
 *
 * The relay (GCE e2-small `chalyb-relay`, us-central1, Standard network
 * tier) copies each stream to every destination with `ffmpeg -c copy`, so
 * egress — not compute — is what scales with use. GCP billing catalog
 * (2026-10-03): "Network Standard Data Transfer Out to Internet from Iowa"
 * = $0.085/GiB (first 200 GiB/month free; ingress free). At a nominal
 * 6 Mbps: 6e6/8 × 60 B = 0.0419 GiB/min × $0.085 = $0.00356/min/destination.
 * The VM (~$12/mo) and its IP (~$4/mo) are fixed and not metered.
 */
export const RELAY_EGRESS_USD_PER_GIB = 0.085;
export const NOMINAL_STREAM_BITRATE_MBPS = 6;
export const STREAM_COST_USD_MICROS_PER_MINUTE = Math.round(
  ((NOMINAL_STREAM_BITRATE_MBPS * 1e6) / 8 * 60 / 2 ** 30) * RELAY_EGRESS_USD_PER_GIB * 1e6,
);

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

/** The hub's JSON error body (`{ error, reason }`) out of a failed call's
 *  message (hub.ts keeps the first 500 chars of the body). {} when it isn't
 *  JSON — e.g. an HTML 404 page from a wrong CHALYB_BASE_URL. */
export function hubErrorBody(message: string | undefined): { error?: string; reason?: string } {
  if (!message) return {};
  try {
    const v: unknown = JSON.parse(message);
    if (!v || typeof v !== "object") return {};
    const o = v as Record<string, unknown>;
    return {
      error: typeof o.error === "string" ? o.error : undefined,
      reason: typeof o.reason === "string" ? o.reason : undefined,
    };
  } catch {
    return {};
  }
}

/**
 * Turn a hub admit result into an authorize decision.
 *   hub === "disabled"      → CHALYB_BASE_URL unset (dev): allow, unmetered.
 *   hub === "misconfigured" → base URL set, bearer missing: fail closed.
 *   transport / 5xx         → fail closed as hub_unreachable.
 *   4xx with a `reason`     → refuse with that reason, like allowed=false.
 *   404 "unknown user_id"   → refuse as unknown_user (the account, not the hub).
 *   other 4xx (401/403 bearer, 404 unknown engine, 400) → fail closed as
 *                             hub_rejected: our config, not an outage.
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
    if (hub.status !== undefined && hub.status >= 400 && hub.status < 500 && hub.status !== 408 && hub.status !== 429) {
      const body = hubErrorBody(hub.message);
      if (body.reason) return { allow: false, error: "usage_refused", reason: body.reason };
      if (hub.status === 404 && body.error === "unknown user_id") {
        return { allow: false, error: "usage_refused", reason: "unknown_user" };
      }
      return { allow: false, error: "usage_unavailable", reason: "hub_rejected" };
    }
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

/** Egress for `destinations` copies of the stream. At least one: the
 *  stream is still received and served even with no destination enabled. */
export function streamCostUsdMicros(minutes: number, destinations = 1): number {
  const copies = Math.max(1, Math.floor(destinations));
  return Math.min(
    MAX_COST_USD_MICROS,
    Math.max(0, Math.round(minutes)) * copies * STREAM_COST_USD_MICROS_PER_MINUTE,
  );
}

export function buildStreamMinutesEvent(args: {
  streamId: string;
  durationS: number;
  reservationId: string | null;
  occurredAt: Date;
  /** Fan-out destinations the relay pushed to. */
  destinations?: number;
}): UsageEvent {
  const minutes = streamMinutes(args.durationS);
  const destinations = Math.max(1, Math.floor(args.destinations ?? 1));
  const event: UsageEvent = {
    kind: STREAM_METER_KIND,
    provider: STREAM_METER_PROVIDER,
    amount: minutes,
    cost_usd_micros: streamCostUsdMicros(minutes, destinations),
    // Idempotent on the hub: (engine, source_id) is unique.
    source_id: args.streamId,
    occurred_at: args.occurredAt.toISOString(),
    operation: STREAM_OPERATION,
    metadata: {
      stream_id: args.streamId,
      duration_s: Math.round(args.durationS),
      rate_usd_micros_per_minute: STREAM_COST_USD_MICROS_PER_MINUTE,
      destinations,
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
  /** Atomically take a due pending row for this drain: push its
   *  next_attempt_at to `leaseUntil` only if it is still pending and due
   *  at `now`. False = another drain took it first (or it changed). */
  claim(id: number, now: Date, leaseUntil: Date): Promise<boolean>;
  markSent(id: number, attempts: number): Promise<void>;
  markRetry(id: number, attempts: number, nextAttemptAt: Date, error: string): Promise<void>;
  markDead(id: number, attempts: number, error: string): Promise<void>;
}

export type OutboxSend = (
  row: OutboxRow,
) => Promise<{ ok: true } | { ok: false; status?: number; message: string }>;

/** Statuses the hub uses to reject what we SENT: POST /usage validation
 *  (400 bad field, 413 too many events, 422 out of range), a closed
 *  reservation's 409. */
const PAYLOAD_REJECTIONS = new Set([400, 409, 413, 422]);

/**
 * Is this failure a permanent rejection of THIS row (mark it dead)?
 * Only when the hub rejected the payload itself. 401/403 (a rotated or
 * mismatched token), 404 (unknown engine/user, a wrong base URL's 404 page),
 * "engine not registered" and any other 4xx are our config: the same row
 * goes through once it's fixed, so it is retried with backoff instead —
 * dead-lettering it would mean that usage is never billed.
 */
export function isPermanentFailure(
  status: number | undefined,
  message = "",
  kind: OutboxKind = "usage",
): boolean {
  if (status === undefined || status < 400 || status >= 500) return false;
  const error = (hubErrorBody(message).error ?? "").toLowerCase();
  if (error.includes("engine")) return false;
  if (kind === "settle" && status === 404) return error === "unknown reservation";
  return PAYLOAD_REJECTIONS.has(status);
}

/** A 4xx that isn't about the row: auth / config. Retried, logged loudly. */
function isConfigFailure(status: number | undefined): boolean {
  return status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 429;
}

/** How long a drain holds a claimed row before another may retry it. */
const LEASE_SECONDS = 120;

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

    const leaseUntil = new Date(now.getTime() + LEASE_SECONDS * 1000);
    if (!(await store.claim(row.id, now, leaseUntil))) {
      // Another drain (live/ended on another instance, the scheduler) is
      // delivering it right now.
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
    if (isPermanentFailure(result.status, result.message, row.kind)) {
      // Do not drop: keep the row as 'dead' for inspection and alert.
      log(
        `[usage-outbox] DEAD row id=${row.id} kind=${row.kind} reservation=${res ?? "-"} — hub rejected permanently: ${detail}`,
      );
      await store.markDead(row.id, attempts, detail);
      stats.dead++;
      continue;
    }
    const next = new Date(now.getTime() + backoffSeconds(attempts) * 1000);
    const hint = !isConfigFailure(result.status)
      ? ""
      : result.status === 401 || result.status === 403
        ? " — hub refused our credentials (config, not the row): check CHALYBOBS_ADMIN_TOKEN / CHALYB_ADMIN_TOKEN"
        : " — hub refused the request (config, not the row): check CHALYB_BASE_URL, the engine registration and the tenant's Chalyb user";
    log(
      `[usage-outbox] delivery failed id=${row.id} kind=${row.kind} attempt=${attempts} — retry at ${next.toISOString()}: ${detail}${hint}`,
    );
    await store.markRetry(row.id, attempts, next, detail);
    if (row.kind === "usage" && res) blocked.add(res);
    stats.retried++;
  }
  return stats;
}
