import { test } from "node:test";
import assert from "node:assert/strict";
import { settleSessionInsert, SessionCreateError } from "./session-create.ts";

const fresh = { streamKey: "chalyb_live_fresh" };
const stored = { streamKey: "chalyb_live_stored" };

test("insert ok: the fresh row (now stored) is returned", () => {
  assert.equal(settleSessionInsert({ tenantId: "t", insertError: null, stored: null, fresh }), fresh);
});

test("lost the first-access race: the stored row wins", () => {
  const out = settleSessionInsert({ tenantId: "t", insertError: { message: "duplicate key" }, stored, fresh });
  assert.equal(out, stored);
});

test("insert refused and nothing stored (RLS / publishable key): throws, never an unsaved key", () => {
  assert.throws(
    () =>
      settleSessionInsert({
        tenantId: "af9b50a6",
        insertError: { message: 'new row violates row-level security policy for table "chalybobs_sessions"' },
        stored: null,
        fresh,
      }),
    (e: unknown) => e instanceof SessionCreateError && /af9b50a6/.test(e.message) && !/chalyb_live_/.test(e.message),
  );
});
