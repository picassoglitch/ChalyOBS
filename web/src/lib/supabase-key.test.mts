import { test } from "node:test";
import assert from "node:assert/strict";
import { isLowPrivilegeKey, supabaseKeyKind } from "./supabase-key.ts";

const jwt = (role: string) =>
  `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ iss: "supabase", ref: "x", role })).toString("base64url")}.sig`;

test("new-format keys by prefix", () => {
  assert.equal(supabaseKeyKind("sb_secret_abc"), "secret");
  assert.equal(supabaseKeyKind("sb_publishable_abc"), "publishable");
  // Same length class as the key prod held on 2026-11-07 (46 chars).
  assert.equal(supabaseKeyKind(`sb_publishable_${"x".repeat(31)}`), "publishable");
});

test("legacy JWT keys by role claim", () => {
  assert.equal(supabaseKeyKind(jwt("service_role")), "service_role");
  assert.equal(supabaseKeyKind(jwt("anon")), "anon");
  assert.equal(supabaseKeyKind(jwt("authenticated")), "anon");
});

test("only anon-role keys are refused; elevated and unknown shapes pass", () => {
  assert.equal(isLowPrivilegeKey("sb_publishable_abc"), true);
  assert.equal(isLowPrivilegeKey(jwt("anon")), true);
  assert.equal(isLowPrivilegeKey("sb_secret_abc"), false);
  assert.equal(isLowPrivilegeKey(jwt("service_role")), false);
  assert.equal(isLowPrivilegeKey("not.a.jwt"), false);
  assert.equal(isLowPrivilegeKey("something-else"), false);
});

test("surrounding whitespace from a pasted secret doesn't hide the kind", () => {
  assert.equal(supabaseKeyKind(" sb_publishable_abc\n"), "publishable");
});
