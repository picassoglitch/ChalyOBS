import { test } from "node:test";
import assert from "node:assert/strict";
import { createHubClient, getHubClient } from "./hub.ts";

type Call = { url: string; init: RequestInit };

function fakeFetch(response: () => Response | Promise<Response>) {
  const calls: Call[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return response();
  }) as typeof fetch;
  return { impl, calls };
}

test("admit posts to /api/engines/chalybobs/usage/admit with bearer", async () => {
  const { impl, calls } = fakeFetch(
    () => new Response(JSON.stringify({ ok: true, allowed: true, reservation_id: "r1" }), { status: 200 }),
  );
  const hub = createHubClient({ baseUrl: "https://hub.test/", token: "tok", fetchImpl: impl });
  const res = await hub.admit({
    external_user_id: "u",
    external_job_id: "u__x",
    class: "stream",
    operation: "live.stream",
    est_tokens: 1,
    upload_mb: 0,
    source_minutes: 0,
    storage_mb_after: 0,
    boost: false,
    ttl_seconds: 60,
  });
  assert.equal(calls[0].url, "https://hub.test/api/engines/chalybobs/usage/admit");
  assert.equal((calls[0].init.headers as Record<string, string>).Authorization, "Bearer tok");
  assert.equal(JSON.parse(calls[0].init.body as string).class, "stream");
  assert.ok(res.ok && res.data.reservation_id === "r1");
});

test("settle and usage hit their paths", async () => {
  const { impl, calls } = fakeFetch(() => new Response("{}", { status: 200 }));
  const hub = createHubClient({ baseUrl: "https://hub.test", token: "t", fetchImpl: impl });
  await hub.settle("r1", "succeeded");
  await hub.reportUsage({ external_user_id: "u", events: [] });
  assert.equal(calls[0].url, "https://hub.test/api/engines/chalybobs/usage/settle");
  assert.deepEqual(JSON.parse(calls[0].init.body as string), {
    reservation_id: "r1",
    outcome: "succeeded",
  });
  assert.equal(calls[1].url, "https://hub.test/api/engines/chalybobs/usage");
});

test("non-2xx and network errors resolve as failures with status", async () => {
  const http = createHubClient({
    baseUrl: "https://hub.test",
    token: "t",
    fetchImpl: fakeFetch(() => new Response("nope", { status: 422 })).impl,
  });
  const r1 = await http.settle("r", "succeeded");
  assert.deepEqual(r1, { ok: false, status: 422, message: "nope" });

  const net = createHubClient({
    baseUrl: "https://hub.test",
    token: "t",
    fetchImpl: (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch,
  });
  const r2 = await net.settle("r", "succeeded");
  assert.equal(r2.ok, false);
  assert.equal(!r2.ok && r2.status, undefined);
});

test("getHubClient: unset base = dev, base without token = misconfigured", () => {
  assert.deepEqual(getHubClient({}), { client: null, misconfigured: false });
  assert.deepEqual(getHubClient({ CHALYB_BASE_URL: "https://hub" }), {
    client: null,
    misconfigured: true,
  });
  const ok = getHubClient({
    CHALYB_BASE_URL: "https://hub",
    CHALYB_ADMIN_TOKEN: "t",
  });
  assert.ok(ok.client && !ok.misconfigured);
});
