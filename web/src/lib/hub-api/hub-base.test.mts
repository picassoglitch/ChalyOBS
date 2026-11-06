import { test } from "node:test";
import assert from "node:assert/strict";
import { hubOAuthForwardUrl, hubPageRedirect, resolveHubBase } from "./hub-base.ts";
import { safePreviewPath } from "../preview-proxy.ts";
import { createHmac } from "node:crypto";
import { verifySsoToken } from "../sso.ts";

test("hub base comes from env only", () => {
  assert.equal(resolveHubBase({ CHALYB_BASE_URL: "https://www.chalyb.com/" }), "https://www.chalyb.com");
  assert.equal(resolveHubBase({ CHALYB_LOGIN_URL: "https://hub.test/login" }), "https://hub.test");
  assert.equal(resolveHubBase({}), "https://chalyb.com");
  assert.equal(resolveHubBase({ CHALYB_BASE_URL: "not a url" }), "https://chalyb.com");
});

test("OAuth callback: only hub. states are forwarded, to the env hub base", () => {
  const hub = "https://www.chalyb.com";
  const p = new URLSearchParams({ code: "C", state: "hub.abc", scope: "x", next: "https://evil.test" });
  const to = hubOAuthForwardUrl("kick", p, hub)!;
  assert.equal(to.origin, hub);
  assert.equal(to.pathname, "/api/tools/chalybobs/oauth/callback");
  assert.deepEqual(Object.fromEntries(to.searchParams), { platform: "kick", code: "C", state: "hub.abc" });

  const denied = hubOAuthForwardUrl("twitch", new URLSearchParams({ error: "access_denied", state: "hub.z" }), hub)!;
  assert.equal(denied.searchParams.get("error"), "access_denied");
  assert.equal(denied.searchParams.has("code"), false);

  assert.equal(hubOAuthForwardUrl("kick", new URLSearchParams({ code: "C", state: "abc" }), hub), null);
  assert.equal(hubOAuthForwardUrl("kick", new URLSearchParams({ code: "C" }), hub), null);
});

test("user-page redirect: off by default", () => {
  for (const p of ["/", "/dashboard", "/settings", "/analytics", "/login"]) {
    assert.equal(hubPageRedirect(p, {}), null);
    assert.equal(hubPageRedirect(p, { CHALYBOBS_REDIRECT_TO_HUB: "0" }), null);
  }
});

test("user-page redirect: mapping when on, APIs untouched", () => {
  const env = { CHALYBOBS_REDIRECT_TO_HUB: "1", CHALYB_BASE_URL: "https://www.chalyb.com" };
  const m: Record<string, string | null> = {
    "/": "https://www.chalyb.com/app/en-vivo",
    "/dashboard": "https://www.chalyb.com/app/en-vivo",
    "/dashboard/x": "https://www.chalyb.com/app/en-vivo",
    "/login": "https://www.chalyb.com/app/en-vivo",
    "/settings": "https://www.chalyb.com/app/en-vivo/ajustes",
    "/analytics": "https://www.chalyb.com/app/en-vivo/transmisiones",
    "/dashboardx": null,
    "/api/hub/v1/state": null,
    "/api/oauth/kick/callback": null,
    "/api/preview/index.m3u8": null,
    "/api/internal/live/started": null,
    "/auth/sso": null,
    "/oauth/done": null,
  };
  for (const [path, want] of Object.entries(m)) assert.equal(hubPageRedirect(path, env), want, path);
});

test("preview path guard", () => {
  assert.equal(safePreviewPath(["index.m3u8"]), "index.m3u8");
  assert.equal(safePreviewPath(["abc_seg1.mp4"]), "abc_seg1.mp4");
  assert.equal(safePreviewPath([".."]), null);
  assert.equal(safePreviewPath(["../x"]), null);
  assert.equal(safePreviewPath(["a/b"]), null);
  assert.equal(safePreviewPath([]), null);
});

test("sso: aud is surfaced (so /auth/sso can refuse hub-scoped tokens)", async () => {
  const mint = (p: Record<string, unknown>) => {
    const b = Buffer.from(JSON.stringify(p)).toString("base64url");
    return `${b}.${createHmac("sha256", "s").update(b).digest("base64url")}`;
  };
  const base = { user_id: "u", email: "a@b.co", tenant_id: "t", exp: 4_000_000_000 };
  assert.equal((await verifySsoToken(mint(base), { secret: "s" })).aud, undefined);
  assert.equal((await verifySsoToken(mint({ ...base, aud: "chalybobs-hub-preview" }), { secret: "s" })).aud, "chalybobs-hub-preview");
  await assert.rejects(verifySsoToken(mint({ ...base, aud: 5 }), { secret: "s" }));
});
