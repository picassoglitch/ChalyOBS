import { test } from "node:test";
import assert from "node:assert/strict";
import {
  backoffSeconds,
  buildStreamAdmitRequest,
  buildStreamMinutesEvent,
  decideAdmission,
  drainOutbox,
  isPermanentFailure,
  STREAM_COST_USD_MICROS_PER_MINUTE,
  STREAM_RESERVATION_TTL_SECONDS,
  streamDurationSeconds,
  streamMinutes,
  type OutboxRow,
  type OutboxStore,
} from "./metering.ts";

test("admit request: stream class, stable job id, no boost", () => {
  const req = buildStreamAdmitRequest({ tenantId: "u1", streamId: "u1__abc" });
  assert.equal(req.class, "stream");
  assert.equal(req.operation, "live.stream");
  assert.equal(req.external_user_id, "u1");
  assert.equal(req.external_job_id, "u1__abc");
  assert.equal(req.boost, false);
  assert.equal(req.ttl_seconds, STREAM_RESERVATION_TTL_SECONDS);
  assert.ok(Number.isInteger(req.est_tokens) && req.est_tokens > 0);
});

test("decideAdmission: dev (no hub) allows unmetered", () => {
  assert.deepEqual(decideAdmission("disabled"), {
    allow: true,
    reservationId: null,
    lane: null,
    metered: false,
  });
});

test("decideAdmission: fails closed when hub misconfigured or unreachable", () => {
  const mis = decideAdmission("misconfigured");
  assert.equal(mis.allow, false);
  const net = decideAdmission({ ok: false, message: "ECONNREFUSED" });
  assert.equal(net.allow, false);
  assert.equal(!net.allow && net.error, "usage_unavailable");
  const http = decideAdmission({ ok: false, status: 502, message: "bad gateway" });
  assert.equal(http.allow, false);
});

test("decideAdmission: hub refusal passes the reason through", () => {
  const d = decideAdmission({
    ok: true,
    status: 200,
    data: { ok: true, allowed: false, reason: "concurrency" },
  });
  assert.deepEqual(d, { allow: false, error: "usage_refused", reason: "concurrency" });
});

test("decideAdmission: admitted returns reservation; missing id fails closed", () => {
  const ok = decideAdmission({
    ok: true,
    status: 200,
    data: { allowed: true, reservation_id: "r1", lane: "standard" },
  });
  assert.deepEqual(ok, { allow: true, reservationId: "r1", lane: "standard", metered: true });
  const noId = decideAdmission({ ok: true, status: 200, data: { allowed: true } });
  assert.equal(noId.allow, false);
});

test("streamMinutes rounds up whole minutes", () => {
  assert.equal(streamMinutes(0), 0);
  assert.equal(streamMinutes(-5), 0);
  assert.equal(streamMinutes(Number.NaN), 0);
  assert.equal(streamMinutes(1), 1);
  assert.equal(streamMinutes(60), 1);
  assert.equal(streamMinutes(61), 2);
  assert.equal(streamMinutes(3600), 60);
});

test("streamDurationSeconds prefers relay duration, falls back to start time", () => {
  const now = new Date("2026-10-03T12:00:00Z");
  assert.equal(streamDurationSeconds({ reportedS: 125, startedAt: null, now }), 125);
  assert.equal(
    streamDurationSeconds({ reportedS: undefined, startedAt: "2026-10-03T11:30:00Z", now }),
    1800,
  );
  assert.equal(streamDurationSeconds({ reportedS: -1, startedAt: null, now }), 0);
  assert.equal(streamDurationSeconds({ startedAt: "garbage", now }), 0);
});

test("stream.minutes event: amount, cost, idempotent source_id, reservation", () => {
  const ev = buildStreamMinutesEvent({
    streamId: "u1__abc",
    durationS: 61,
    reservationId: "r1",
    occurredAt: new Date("2026-10-03T12:00:00Z"),
  });
  assert.equal(ev.kind, "stream.minutes");
  assert.equal(ev.amount, 2);
  assert.equal(ev.cost_usd_micros, 2 * STREAM_COST_USD_MICROS_PER_MINUTE);
  assert.ok(Number.isInteger(ev.cost_usd_micros));
  assert.equal(ev.source_id, "u1__abc");
  assert.equal(ev.reservation_id, "r1");
  assert.equal(ev.occurred_at, "2026-10-03T12:00:00.000Z");

  const unmetered = buildStreamMinutesEvent({
    streamId: "s",
    durationS: 0,
    reservationId: null,
    occurredAt: new Date(),
  });
  assert.equal(unmetered.amount, 0);
  assert.equal(unmetered.cost_usd_micros, 0);
  assert.equal("reservation_id" in unmetered, false);
});

test("isPermanentFailure: 4xx except 408/429; network and 5xx retry", () => {
  assert.equal(isPermanentFailure(400), true);
  assert.equal(isPermanentFailure(422), true);
  assert.equal(isPermanentFailure(404), true);
  assert.equal(isPermanentFailure(408), false);
  assert.equal(isPermanentFailure(429), false);
  assert.equal(isPermanentFailure(500), false);
  assert.equal(isPermanentFailure(undefined), false);
});

test("backoff grows and caps at 1h", () => {
  assert.equal(backoffSeconds(1), 30);
  assert.equal(backoffSeconds(2), 60);
  assert.equal(backoffSeconds(3), 120);
  assert.equal(backoffSeconds(100), 3600);
});

// ── drainOutbox ─────────────────────────────────────────────────────────────

function memStore(rows: OutboxRow[]) {
  const state = new Map<number, { status: string; attempts: number; next?: Date; error?: string }>();
  const store: OutboxStore = {
    async listPending(limit) {
      return rows.filter((r) => !state.has(r.id) || state.get(r.id)!.status === "pending").slice(0, limit);
    },
    async markSent(id, attempts) {
      state.set(id, { status: "sent", attempts });
    },
    async markRetry(id, attempts, next, error) {
      state.set(id, { status: "pending", attempts, next, error });
    },
    async markDead(id, attempts, error) {
      state.set(id, { status: "dead", attempts, error });
    },
  };
  return { store, state };
}

const NOW = new Date("2026-10-03T12:00:00Z");
const due = "2026-10-03T11:00:00Z";
const usageRow = (id: number, res: string | null): OutboxRow => ({
  id,
  kind: "usage",
  reservation_id: res,
  payload: { id },
  attempts: 0,
  next_attempt_at: due,
});
const settleRow = (id: number, res: string): OutboxRow => ({
  id,
  kind: "settle",
  reservation_id: res,
  payload: { reservation_id: res, outcome: "succeeded" },
  attempts: 0,
  next_attempt_at: due,
});

test("drain: delivers usage then settle in order", async () => {
  const { store, state } = memStore([usageRow(1, "r1"), settleRow(2, "r1")]);
  const sent: number[] = [];
  const stats = await drainOutbox(
    store,
    async (row) => {
      sent.push(row.id);
      return { ok: true };
    },
    { now: NOW, log: () => {} },
  );
  assert.deepEqual(sent, [1, 2]);
  assert.deepEqual(stats, { sent: 2, retried: 0, dead: 0, skipped: 0 });
  assert.equal(state.get(1)!.status, "sent");
  assert.equal(state.get(2)!.attempts, 1);
});

test("drain: transient usage failure holds back the settle and schedules a retry", async () => {
  const { store, state } = memStore([usageRow(1, "r1"), settleRow(2, "r1"), settleRow(3, "r2")]);
  const sent: number[] = [];
  const logs: string[] = [];
  const stats = await drainOutbox(
    store,
    async (row) => {
      sent.push(row.id);
      return row.id === 1 ? { ok: false, status: 503, message: "down" } : { ok: true };
    },
    { now: NOW, log: (m) => logs.push(m) },
  );
  assert.deepEqual(sent, [1, 3]); // r1's settle skipped, r2's unaffected
  assert.deepEqual(stats, { sent: 1, retried: 1, dead: 0, skipped: 1 });
  const r1 = state.get(1)!;
  assert.equal(r1.status, "pending");
  assert.equal(r1.attempts, 1);
  assert.equal(r1.next!.getTime(), NOW.getTime() + 30_000);
  assert.equal(state.has(2), false);
  assert.ok(logs.some((l) => l.includes("delivery failed")));
});

test("drain: not-yet-due usage row blocks its settle", async () => {
  const later = { ...usageRow(1, "r1"), next_attempt_at: "2026-10-03T13:00:00Z" };
  const { store } = memStore([later, settleRow(2, "r1")]);
  let calls = 0;
  const stats = await drainOutbox(
    store,
    async () => {
      calls++;
      return { ok: true };
    },
    { now: NOW, log: () => {} },
  );
  assert.equal(calls, 0);
  assert.equal(stats.skipped, 2);
});

test("drain: permanent 4xx marks dead loudly and does not block the settle", async () => {
  const { store, state } = memStore([usageRow(1, "r1"), settleRow(2, "r1")]);
  const logs: string[] = [];
  const stats = await drainOutbox(
    store,
    async (row) => (row.id === 1 ? { ok: false, status: 422, message: "occurred_at too old" } : { ok: true }),
    { now: NOW, log: (m) => logs.push(m) },
  );
  assert.deepEqual(stats, { sent: 1, retried: 0, dead: 1, skipped: 0 });
  assert.equal(state.get(1)!.status, "dead");
  assert.ok(logs.some((l) => l.includes("DEAD")));
});

test("drain: thrown sender errors are retried, not fatal", async () => {
  const { store, state } = memStore([usageRow(1, null)]);
  const stats = await drainOutbox(
    store,
    async () => {
      throw new Error("boom");
    },
    { now: NOW, log: () => {} },
  );
  assert.equal(stats.retried, 1);
  assert.equal(state.get(1)!.error, "network boom");
});
