import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { handleHubApi, type HubApiDeps } from "./handlers.ts";
import { HUB_API_AUD, HUB_PREVIEW_AUD, verifyHubBearer } from "./auth.ts";

const SECRET = "test-sso-secret";
const NOW = 1_800_000_000;

function mint(payload: Record<string, unknown>, secret = SECRET): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${sig}`;
}
const claims = (over: Record<string, unknown> = {}) => ({
  user_id: "u1",
  email: "a@b.co",
  tenant_id: "tenant-A",
  tier: "pro",
  exp: NOW + 120,
  aud: HUB_API_AUD,
  ...over,
});
const bearer = (over: Record<string, unknown> = {}) => `Bearer ${mint(claims(over))}`;

type Row = {
  id: string;
  tenant: string;
  platformId: string;
  channelHandle: string;
  streamTitle: string;
  ingestUrl: string;
  streamKey: string;
  oauthConnected: boolean;
  enabled: boolean;
  status?: { kind: "ok" };
};

function fakeDeps(over: Partial<HubApiDeps> = {}) {
  const calls: { fn: string; args: unknown[] }[] = [];
  const rows: Row[] = [
    { id: "dA", tenant: "tenant-A", platformId: "twitch", channelHandle: "a", streamTitle: "t", ingestUrl: "rtmp://live.twitch.tv/app", streamKey: "live_secret_A", oauthConnected: true, enabled: false, status: { kind: "ok" } },
    { id: "dA2", tenant: "tenant-A", platformId: "custom_rtmp", channelHandle: "", streamTitle: "", ingestUrl: "", streamKey: "", oauthConnected: false, enabled: false },
    { id: "dB", tenant: "tenant-B", platformId: "kick", channelHandle: "b", streamTitle: "t", ingestUrl: "rtmps://x/app", streamKey: "live_secret_B", oauthConnected: false, enabled: true },
  ];
  const tiers: Record<string, string | null> = { "tenant-A": "pro" };
  const rec = (fn: string) => async (...args: unknown[]) => {
    calls.push({ fn, args });
  };
  const provider = (pkce: boolean, configured = true) => ({
    platformId: pkce ? "kick" : "twitch",
    usesPkce: pkce,
    isConfigured: () => configured,
    buildAuthorizeUrl: (o: { redirectUri: string; state: string; codeChallenge?: string }) =>
      `https://plat.test/auth?redirect_uri=${encodeURIComponent(o.redirectUri)}&state=${o.state}${o.codeChallenge ? `&cc=${o.codeChallenge}` : ""}`,
    exchangeCode: async (o: { code: string }) => {
      calls.push({ fn: "exchangeCode", args: [o] });
      if (o.code === "bad") throw new Error("nope");
      return { accessToken: "AT", refreshToken: "RT", expiresAt: "2030-01-01T00:00:00Z", scopes: "s" };
    },
    refreshTokens: async () => ({ accessToken: "", refreshToken: "", expiresAt: "", scopes: "" }),
    fetchConnection: async () => ({ channelHandle: "h", ingestUrl: "rtmp://x/app", streamKey: "k" }),
  });
  const deps: HubApiDeps = {
    ssoSecret: SECRET,
    dbConfigured: true,
    relayRtmpUrl: "rtmp://ingest.test/live",
    relayInternalHls: "http://relay.internal:8888",
    publicOrigin: "https://obs.test",
    nowSeconds: () => NOW,
    getOrCreateSession: async (t) => {
      calls.push({ fn: "getOrCreateSession", args: [t] });
      return {
        title: "Mi show",
        isLive: false,
        clipsEnabled: true,
        streamKey: `ingest_${t}`,
        broadcastMeta: { title: "Mi show", description: "", category: "", tags: [], language: "", visibility: "public", madeForKids: false, mature: false },
      };
    },
    getStoredTier: async (t) => tiers[t] ?? null,
    saveTenantTier: rec("saveTenantTier"),
    updateSession: rec("updateSession"),
    getStreamKey: async (t) => `ingest_${t}`,
    regenerateStreamKey: async (t) => {
      calls.push({ fn: "regenerateStreamKey", args: [t] });
      return "new_key_value";
    },
    getDestinations: async (t) => {
      calls.push({ fn: "getDestinations", args: [t] });
      return rows.filter((r) => r.tenant === t).map((r) => { const { tenant, ...rest } = r; void tenant; return rest; }) as never;
    },
    addDestination: rec("addDestination"),
    updateDestination: rec("updateDestination"),
    toggleDestination: rec("toggleDestination"),
    removeDestination: rec("removeDestination"),
    publishBroadcastMeta: rec("publishBroadcastMeta"),
    pushBroadcastToConnectedPlatforms: rec("push"),
    listStreams: async (t) => [
      { streamId: `${t}__abc123`, startedAt: "2026-10-01T00:00:00Z", endedAt: "2026-10-01T01:00:00Z", durationS: 3600 },
    ],
    getOAuthProvider: (p) =>
      (p === "kick" ? provider(true) : p === "twitch" ? provider(false) : p === "youtube" ? provider(false, false) : null) as never,
    oauthAvailability: () => ({ kick: true, twitch: true, youtube: false }),
    connectOAuthDestination: rec("connectOAuthDestination"),
    ...over,
  };
  return { deps, calls };
}

async function call(
  deps: HubApiDeps,
  method: string,
  path: string,
  opts: { auth?: string | null; body?: unknown; search?: string } = {},
) {
  const res = await handleHubApi(
    {
      method,
      path: path.split("/").filter(Boolean),
      authorization: opts.auth === undefined ? bearer() : opts.auth,
      body: opts.body,
      search: opts.search,
      accept: null,
    },
    deps,
  );
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json: json as Record<string, unknown>, text, headers: res.headers };
}

// ── Auth ──────────────────────────────────────────────────────────────────

test("bearer: missing / malformed / forged / expired / no-aud / wrong-aud are 401", async () => {
  const { deps, calls } = fakeDeps();
  const cases: (string | null)[] = [
    null,
    "",
    "Basic abc",
    "Bearer ",
    `Bearer ${mint(claims(), "other-secret")}`, // forged
    bearer({ exp: NOW - 1 }), // expired
    `Bearer ${mint({ ...claims(), aud: undefined })}`, // launch token (no aud)
    bearer({ aud: "something-else" }),
    bearer({ aud: HUB_PREVIEW_AUD }), // preview token on the API
    bearer({ exp: NOW + 601 }), // too far in the future
    bearer({ tenant_id: "" }),
  ];
  for (const auth of cases) {
    const r = await call(deps, "GET", "state", { auth });
    assert.equal(r.status, 401, `auth=${auth}`);
    assert.deepEqual(r.json, { error: "unauthorized" });
  }
  assert.equal(calls.length, 0, "no data access without a valid token");
});

test("bearer: tampered payload with the original signature fails", async () => {
  const good = mint(claims());
  const [, sig] = good.split(".");
  const evil = Buffer.from(JSON.stringify(claims({ tenant_id: "tenant-B" }))).toString("base64url");
  const { deps } = fakeDeps();
  assert.equal((await call(deps, "GET", "state", { auth: `Bearer ${evil}.${sig}` })).status, 401);
});

test("bearer: no secret configured fails closed", async () => {
  const { deps } = fakeDeps({ ssoSecret: "" });
  assert.equal((await call(deps, "GET", "state")).status, 401);
  assert.equal(await verifyHubBearer(bearer(), { secret: undefined, aud: HUB_API_AUD, nowSeconds: NOW }), null);
});

test("preview: only preview tokens, with their own ceiling", async () => {
  let fetched = "";
  const { deps, calls } = fakeDeps({
    fetchImpl: (async (url: string) => {
      fetched = String(url);
      return new Response("#EXTM3U", { status: 200, headers: { "content-type": "application/vnd.apple.mpegurl" } });
    }) as typeof fetch,
  });
  assert.equal((await call(deps, "GET", "preview/index.m3u8")).status, 401, "api token refused on preview");
  assert.equal(
    (await call(deps, "GET", "preview/index.m3u8", { auth: bearer({ aud: HUB_PREVIEW_AUD, exp: NOW + 3601 }) })).status,
    401,
  );
  const r = await call(deps, "GET", "preview/index.m3u8", {
    auth: bearer({ aud: HUB_PREVIEW_AUD, exp: NOW + 1800 }),
    search: "?_HLS_msn=3",
  });
  assert.equal(r.status, 200);
  assert.equal(r.text, "#EXTM3U");
  assert.equal(fetched, "http://relay.internal:8888/live/ingest_tenant-A/index.m3u8?_HLS_msn=3");
  assert.equal(r.headers.get("cache-control"), "no-store");
  assert.equal(calls.length, 0);
});

test("preview: traversal and unconfigured", async () => {
  const pv = bearer({ aud: HUB_PREVIEW_AUD, exp: NOW + 1800 });
  const { deps } = fakeDeps({ fetchImpl: (async () => new Response("x")) as unknown as typeof fetch });
  for (const path of [["..", "x.m3u8"], ["../other"], ["a\\b"]]) {
    const res = await handleHubApi({ method: "GET", path: ["preview", ...path], authorization: pv }, deps);
    assert.equal(res.status, 400, path.join("/"));
  }
  const res = await handleHubApi({ method: "GET", path: ["preview"], authorization: pv }, deps);
  assert.equal(res.status, 400);
  const off = fakeDeps({ relayInternalHls: undefined }).deps;
  assert.equal((await call(off, "GET", "preview/index.m3u8", { auth: pv })).status, 503);
});

// ── State ─────────────────────────────────────────────────────────────────

test("GET state: own tenant only, no stream keys or tokens", async () => {
  const { deps, calls } = fakeDeps();
  const r = await call(deps, "GET", "state");
  assert.equal(r.status, 200);
  assert.ok(!r.text.includes("ingest_tenant-A"), "ingest key never in state");
  assert.ok(!r.text.includes("live_secret"), "destination keys never in state");
  assert.ok(!/"streamKey"|oauth_?token|refresh/i.test(r.text));
  const dests = r.json.destinations as { id: string; hasStreamKey: boolean; status: unknown }[];
  assert.deepEqual(dests.map((d) => d.id), ["dA", "dA2"]);
  assert.equal(dests[0].hasStreamKey, true);
  assert.equal(dests[1].hasStreamKey, false);
  assert.equal(dests[1].status, null);
  assert.equal(r.json.rtmpUrl, "rtmp://ingest.test/live");
  assert.equal(r.json.previewEnabled, true);
  assert.equal(r.json.isFullAccess, false);
  assert.deepEqual(r.json.oauthAvailable, { kick: true, twitch: true, youtube: false });
  assert.ok(calls.every((c) => c.args[0] === "tenant-A" || typeof c.args[0] !== "string"));
  assert.ok(!calls.some((c) => c.fn === "saveTenantTier"), "unchanged tier not rewritten");
});

test("GET state: persists the tier only when it changed", async () => {
  const { deps, calls } = fakeDeps();
  await call(deps, "GET", "state", { auth: bearer({ tier: "vip" }) });
  assert.deepEqual(calls.find((c) => c.fn === "saveTenantTier")?.args, ["tenant-A", "vip"]);
});

test("503 when Supabase isn't configured", async () => {
  const { deps } = fakeDeps({ dbConfigured: false });
  assert.deepEqual((await call(deps, "GET", "state")).json, { error: "service_not_configured" });
});

// ── Session ───────────────────────────────────────────────────────────────

test("PATCH session: title rules and full-access gate on clips", async () => {
  const { deps, calls } = fakeDeps();
  assert.equal((await call(deps, "PATCH", "session", { body: { title: "  " } })).status, 200);
  assert.deepEqual(calls.find((c) => c.fn === "updateSession")?.args, ["tenant-A", { title: "Mi transmisión en vivo" }]);
  assert.equal((await call(deps, "PATCH", "session", { body: { title: "x".repeat(201) } })).status, 400);
  assert.equal((await call(deps, "PATCH", "session", { body: { title: 5 } })).status, 400);
  assert.equal((await call(deps, "PATCH", "session", { body: {} })).status, 400);
  assert.equal((await call(deps, "PATCH", "session", { body: { clipsEnabled: "yes" } })).status, 400);

  const pro = await call(deps, "PATCH", "session", { body: { clipsEnabled: true } });
  assert.equal(pro.status, 403);
  assert.deepEqual(pro.json, { error: "full_access_required" });
  // Turning it OFF is always allowed.
  assert.equal((await call(deps, "PATCH", "session", { body: { clipsEnabled: false } })).status, 200);
  for (const tier of ["vip", "ALL_ACCESS", "partner"]) {
    const r = await call(deps, "PATCH", "session", { body: { clipsEnabled: true }, auth: bearer({ tier }) });
    assert.equal(r.status, 200, tier);
  }
});

test("stream key: read and regenerate (regenerate never returns the key)", async () => {
  const { deps, calls } = fakeDeps();
  const k = await call(deps, "GET", "stream-key");
  assert.deepEqual(k.json, { streamKey: "ingest_tenant-A" });
  assert.equal(k.headers.get("cache-control"), "no-store");
  const r = await call(deps, "POST", "stream-key/regenerate");
  assert.deepEqual(r.json, { ok: true });
  assert.ok(!r.text.includes("new_key_value"));
  assert.deepEqual(calls.find((c) => c.fn === "regenerateStreamKey")?.args, ["tenant-A"]);
});

// ── Destinations ──────────────────────────────────────────────────────────

test("POST destinations: only broadcast-capable platforms", async () => {
  const { deps, calls } = fakeDeps();
  assert.equal((await call(deps, "POST", "destinations", { body: { platformId: "kick" } })).status, 201);
  assert.deepEqual(calls.find((c) => c.fn === "addDestination")?.args, ["tenant-A", "kick"]);
  for (const platformId of ["instagram", "myspace", 3, undefined, "__proto__"]) {
    assert.equal((await call(deps, "POST", "destinations", { body: { platformId } })).status, 400, String(platformId));
  }
});

test("another tenant's destination is a 404 on every verb, and nothing is written", async () => {
  const { deps, calls } = fakeDeps();
  for (const [m, p] of [
    ["PATCH", "destinations/dB"],
    ["POST", "destinations/dB/toggle"],
    ["DELETE", "destinations/dB"],
    ["GET", "destinations/dB/stream-key"],
  ] as const) {
    const r = await call(deps, m, p, { body: { channelHandle: "x" } });
    assert.equal(r.status, 404, `${m} ${p}`);
    assert.ok(!r.text.includes("live_secret_B"));
  }
  assert.ok(!calls.some((c) => ["updateDestination", "toggleDestination", "removeDestination"].includes(c.fn)));
  assert.ok(calls.filter((c) => c.fn === "getDestinations").every((c) => c.args[0] === "tenant-A"));
});

test("PATCH destination: validation", async () => {
  const { deps, calls } = fakeDeps();
  const ok = await call(deps, "PATCH", "destinations/dA2", {
    body: { channelHandle: " me ", ingestUrl: "srt://srt.example.com:9000", streamKey: " k " },
  });
  assert.equal(ok.status, 200);
  assert.deepEqual(calls.find((c) => c.fn === "updateDestination")?.args, [
    "tenant-A",
    "dA2",
    { channelHandle: "me", ingestUrl: "srt://srt.example.com:9000", streamKey: "k" },
  ]);
  for (const body of [
    { ingestUrl: "file:///etc/passwd" },
    { ingestUrl: "http://169.254.169.254/" },
    { ingestUrl: "rtmp://" },
    { streamKey: "x".repeat(501) },
    { streamTitle: 7 },
    {},
  ]) {
    assert.equal((await call(deps, "PATCH", "destinations/dA2", { body })).status, 400, JSON.stringify(body));
  }
  // Clearing the URL is allowed.
  assert.equal((await call(deps, "PATCH", "destinations/dA2", { body: { ingestUrl: "" } })).status, 200);
});

test("toggle: 409 turning on an unconfigured destination; returns new state", async () => {
  const { deps } = fakeDeps();
  const bad = await call(deps, "POST", "destinations/dA2/toggle");
  assert.equal(bad.status, 409);
  assert.deepEqual(bad.json, { error: "not_configured" });
  const good = await call(deps, "POST", "destinations/dA/toggle");
  assert.deepEqual(good.json, { ok: true, enabled: true });
});

test("destination stream key + delete", async () => {
  const { deps, calls } = fakeDeps();
  assert.deepEqual((await call(deps, "GET", "destinations/dA/stream-key")).json, { streamKey: "live_secret_A" });
  assert.equal((await call(deps, "DELETE", "destinations/dA")).status, 200);
  assert.deepEqual(calls.find((c) => c.fn === "removeDestination")?.args, ["tenant-A", "dA"]);
});

// ── Broadcast / streams ───────────────────────────────────────────────────

test("broadcast: normalized, saved, pushed; junk refused", async () => {
  const { deps, calls } = fakeDeps();
  const r = await call(deps, "POST", "broadcast", {
    body: { meta: { title: "Hola", tags: ["a"], visibility: "weird", mature: true } },
  });
  assert.equal(r.status, 200);
  const saved = calls.find((c) => c.fn === "publishBroadcastMeta")?.args[1] as Record<string, unknown>;
  assert.equal(saved.title, "Hola");
  assert.equal(saved.visibility, "public");
  assert.equal(saved.mature, true);
  assert.ok(calls.some((c) => c.fn === "push" && c.args[0] === "tenant-A"));
  for (const meta of [undefined, "x", { title: 1 }, { tags: "a" }, { tags: Array(51).fill("t") }, { mature: "yes" }]) {
    assert.equal((await call(deps, "POST", "broadcast", { body: { meta } })).status, 400, JSON.stringify(meta));
  }
});

test("streams: only the random part of the stream id", async () => {
  const { deps } = fakeDeps();
  const r = await call(deps, "GET", "streams");
  assert.deepEqual(r.json, {
    streams: [{ id: "abc123", startedAt: "2026-10-01T00:00:00Z", endedAt: "2026-10-01T01:00:00Z", durationS: 3600 }],
  });
  assert.ok(!r.text.includes("tenant-A"));
});

// ── OAuth (hub-owned state + PKCE) ────────────────────────────────────────

const STATE = "hub.abcdefghijklmnop0123";
const CHALLENGE = "a".repeat(43);
const VERIFIER = "v".repeat(43);

test("oauth authorize: registered redirect URI, state/challenge validation", async () => {
  const { deps } = fakeDeps();
  const r = await call(deps, "POST", "oauth/kick/authorize", { body: { state: STATE, codeChallenge: CHALLENGE } });
  assert.equal(r.status, 200);
  const url = new URL(r.json.url as string);
  assert.equal(url.searchParams.get("redirect_uri"), "https://obs.test/api/oauth/kick/callback");
  assert.equal(url.searchParams.get("state"), STATE);
  assert.equal(url.searchParams.get("cc"), CHALLENGE);

  // Non-PKCE platform: a challenge is accepted but not used.
  const tw = await call(deps, "POST", "oauth/twitch/authorize", { body: { state: STATE, codeChallenge: CHALLENGE } });
  assert.equal(new URL(tw.json.url as string).searchParams.get("cc"), null);
  assert.equal((await call(deps, "POST", "oauth/twitch/authorize", { body: { state: STATE } })).status, 200);

  for (const body of [
    { state: "abcdefghijklmnop0123", codeChallenge: CHALLENGE }, // no hub. prefix
    { state: "hub.short", codeChallenge: CHALLENGE },
    { state: `${STATE}<script>`, codeChallenge: CHALLENGE },
    { state: STATE }, // PKCE platform without challenge
    { state: STATE, codeChallenge: "short" },
  ]) {
    assert.equal((await call(deps, "POST", "oauth/kick/authorize", { body })).status, 400, JSON.stringify(body));
  }
  assert.equal((await call(deps, "POST", "oauth/twitch/authorize", { body: { state: STATE, codeChallenge: "bad!" } })).status, 400);
  assert.equal((await call(deps, "POST", "oauth/myspace/authorize", { body: { state: STATE } })).status, 404);
  assert.deepEqual((await call(deps, "POST", "oauth/youtube/authorize", { body: { state: STATE } })).json, {
    error: "youtube_not_configured",
  });
});

test("oauth complete: connects for the token tenant; failures are 502", async () => {
  const { deps, calls } = fakeDeps();
  const r = await call(deps, "POST", "oauth/kick/complete", { body: { code: "c1", codeVerifier: VERIFIER } });
  assert.deepEqual(r.json, { ok: true, platform: "kick" });
  assert.deepEqual(calls.find((c) => c.fn === "exchangeCode")?.args[0], {
    code: "c1",
    codeVerifier: VERIFIER,
    redirectUri: "https://obs.test/api/oauth/kick/callback",
  });
  const conn = calls.find((c) => c.fn === "connectOAuthDestination")!;
  assert.equal(conn.args[0], "tenant-A");
  assert.equal(conn.args[1], "kick");

  // Non-PKCE: verifier ignored.
  await call(deps, "POST", "oauth/twitch/complete", { body: { code: "c2", codeVerifier: VERIFIER } });
  assert.equal((calls.filter((c) => c.fn === "exchangeCode")[1].args[0] as { codeVerifier?: string }).codeVerifier, undefined);

  assert.equal((await call(deps, "POST", "oauth/kick/complete", { body: { code: "c1" } })).status, 400);
  assert.equal((await call(deps, "POST", "oauth/kick/complete", { body: { codeVerifier: VERIFIER } })).status, 400);
  assert.deepEqual((await call(deps, "POST", "oauth/kick/complete", { body: { code: "bad", codeVerifier: VERIFIER } })).json, {
    error: "exchange_failed",
  });
});

test("unknown routes and methods are 404", async () => {
  const { deps } = fakeDeps();
  assert.equal((await call(deps, "DELETE", "state")).status, 404);
  assert.equal((await call(deps, "GET", "nope")).status, 404);
  assert.equal((await call(deps, "GET", "destinations/dA/extra/x")).status, 404);
});
