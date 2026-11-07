import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";
import { writeTenantTier } from "./tenant-tier.ts";

// Records what the real supabase-js client sends to PostgREST.
function recordingDb(rowsMatched: number) {
  const sent: { method: string; url: URL; body: unknown }[] = [];
  const db = createClient("http://supabase.test", "sb_secret_test", {
    auth: { persistSession: false },
    global: {
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
        sent.push({ method: init?.method ?? "GET", url, body });
        return new Response(null, { status: 204, headers: { "content-range": `0-${rowsMatched - 1}/*` } });
      },
    },
  });
  return { db, sent };
}

test("hub provisioning of a new tenant (2026-11-07): the tier save never creates the session row", async () => {
  const { db, sent } = recordingDb(0);
  await writeTenantTier(() => db, "tenant-A", "vip");
  assert.ok(sent.length > 0, "the tier is written");
  assert.ok(
    sent.every((r) => r.method === "PATCH"),
    `only updates, no insert: ${sent.map((r) => r.method).join(",")}`,
  );
});

test("existing row: one update of tier + tier_updated_at, scoped to the tenant", async () => {
  const { db, sent } = recordingDb(1);
  await writeTenantTier(() => db, "tenant-A", null);
  assert.equal(sent.length, 1);
  const [r] = sent;
  assert.equal(r.method, "PATCH");
  assert.equal(r.url.pathname, "/rest/v1/chalybobs_sessions");
  assert.equal(r.url.searchParams.get("tenant_id"), "eq.tenant-A");
  const body = r.body as { tier: unknown; tier_updated_at: unknown };
  assert.equal(body.tier, null, "a downgrade stores null, never a stale tier");
  assert.equal(typeof body.tier_updated_at, "string");
  assert.deepEqual(Object.keys(body).sort(), ["tier", "tier_updated_at"], "title untouched");
});

test("no admin client (bad key / missing env): logged, never thrown", async () => {
  const errors: unknown[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => errors.push(a.join(" "));
  try {
    await writeTenantTier(() => { throw new Error("SUPABASE_URL missing"); }, "tenant-A", "pro");
  } finally {
    console.error = orig;
  }
  assert.equal(errors.length, 1);
  assert.match(String(errors[0]), /\[tier\] save failed: SUPABASE_URL missing/);
});

test("a failed write is logged, never thrown (login and provisioning must not break)", async () => {
  const db = createClient("http://supabase.test", "sb_secret_test", {
    auth: { persistSession: false },
    global: { fetch: async () => { throw new TypeError("fetch failed"); } },
  });
  const errors: unknown[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => errors.push(a.join(" "));
  try {
    await writeTenantTier(() => db, "tenant-A", "pro");
  } finally {
    console.error = orig;
  }
  assert.equal(errors.length, 1);
  assert.match(String(errors[0]), /\[tier\] save failed/);
});
