/**
 * /api/hub/v1/* — the JSON API the Chalyb hub calls server-to-server to run
 * En vivo inside www.chalyb.com (hub BFF, option B). One dispatcher, pure
 * apart from the injected deps, so node:test covers it end to end without
 * Supabase. The route file only wires the real deps (deps.ts).
 *
 * Every handler gets the tenant from the verified bearer and nothing else;
 * the deps (data.ts) scope every query by that tenant.
 */

import type { BroadcastMeta, DestinationConfig, PlatformId } from "../destinations";
import type { OAuthProvider } from "../oauth/flow";
import type { OAuthConnection, TenantSession } from "../data";
import { normalizeBroadcastMeta, PLATFORM_META, PLATFORM_ORDER } from "../destinations.ts";
import { isFullAccessTier } from "../tier.ts";
import { HUB_API_AUD, HUB_PREVIEW_AUD, type HubClaims, verifyHubBearer } from "./auth.ts";
import { proxyPreview } from "../preview-proxy.ts";

type Dest = DestinationConfig & { id: string };

export interface HubApiDeps {
  ssoSecret: string | null | undefined;
  /** Supabase configured — otherwise every data endpoint is a 503. */
  dbConfigured: boolean;
  relayRtmpUrl: string;
  relayInternalHls: string | null | undefined;
  /** Public origin of this engine — builds the registered OAuth redirect URI. */
  publicOrigin: string;

  getOrCreateSession(tenantId: string): Promise<TenantSession>;
  getStoredTier(tenantId: string): Promise<string | null>;
  saveTenantTier(tenantId: string, tier: string | null): Promise<void>;
  updateSession(tenantId: string, patch: Partial<TenantSession>): Promise<void>;
  getStreamKey(tenantId: string): Promise<string | null>;
  regenerateStreamKey(tenantId: string): Promise<string>;
  getDestinations(tenantId: string): Promise<Dest[]>;
  addDestination(tenantId: string, platformId: PlatformId): Promise<void>;
  updateDestination(
    tenantId: string,
    id: string,
    patch: { channelHandle?: string; streamTitle?: string; ingestUrl?: string; streamKey?: string },
  ): Promise<void>;
  toggleDestination(tenantId: string, id: string): Promise<void>;
  removeDestination(tenantId: string, id: string): Promise<void>;
  publishBroadcastMeta(tenantId: string, meta: BroadcastMeta): Promise<void>;
  pushBroadcastToConnectedPlatforms(tenantId: string, meta: BroadcastMeta): Promise<void>;
  listStreams(
    tenantId: string,
    limit: number,
  ): Promise<{ streamId: string; startedAt: string; endedAt: string | null; durationS: number | null }[]>;
  getOAuthProvider(platform: string): OAuthProvider | null;
  oauthAvailability(): Partial<Record<PlatformId, boolean>>;
  connectOAuthDestination(tenantId: string, platformId: PlatformId, conn: OAuthConnection): Promise<void>;
  fetchImpl?: typeof fetch;
  nowSeconds?: () => number;
}

export interface HubApiRequest {
  method: string;
  /** Segments after /api/hub/v1/. */
  path: string[];
  authorization: string | null;
  /** Parsed JSON body (undefined for none / unparseable). */
  body?: unknown;
  /** Raw query string with "?" (preview only). */
  search?: string;
  accept?: string | null;
}

const DEFAULT_TITLE = "Mi transmisión en vivo";
const MAX_TITLE = 200;
const MAX_FIELD = 500;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
const err = (code: string, status: number) => json({ error: code }, status);
const ok = (extra: Record<string, unknown> = {}, status = 200) => json({ ok: true, ...extra }, status);

function asObject(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** "" (cleared) or an rtmp/rtmps/srt URL with a host: the relay feeds this
 *  straight to ffmpeg, which would also open file:/http:/pipe:. */
export function isAllowedIngestUrl(url: string): boolean {
  const t = url.trim();
  if (t === "") return true;
  try {
    const u = new URL(t);
    return ["rtmp:", "rtmps:", "srt:"].includes(u.protocol.toLowerCase()) && u.hostname.length > 0;
  } catch {
    return false;
  }
}

export function isBroadcastPlatform(v: unknown): v is PlatformId {
  return (
    typeof v === "string" &&
    (PLATFORM_ORDER as string[]).includes(v) &&
    PLATFORM_META[v as PlatformId].supportsBroadcast
  );
}

const STATE_RE = /^hub\.[A-Za-z0-9_-]{16,128}$/;
const CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;
const VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/;

function isConfigured(d: { ingestUrl: string; streamKey: string }): boolean {
  return d.ingestUrl.trim().length > 0 && d.streamKey.trim().length > 0;
}

/** Persist the tier the hub vouched for, but only when it changed — relay
 *  callbacks (no cookie) re-check it before forwarding to ChalyClip. A token
 *  without a tier stores null, exactly like /auth/sso: a downgrade must never
 *  leave a stale full-access tier behind. */
async function syncTier(deps: HubApiDeps, c: HubClaims): Promise<void> {
  const tier = c.tier ?? null;
  try {
    const stored = await deps.getStoredTier(c.tenant_id);
    if (stored !== tier) await deps.saveTenantTier(c.tenant_id, tier);
  } catch {
    // best-effort, like the SSO path
  }
}

/** Public view of a destination: no stream key, no OAuth tokens. */
function publicDestination(d: Dest) {
  return {
    id: d.id,
    platformId: d.platformId,
    channelHandle: d.channelHandle,
    streamTitle: d.streamTitle,
    ingestUrl: d.ingestUrl,
    hasStreamKey: d.streamKey.trim().length > 0,
    oauthConnected: d.oauthConnected,
    enabled: d.enabled,
    status: d.status ?? null,
  };
}

function validBroadcastMeta(raw: unknown): boolean {
  const m = asObject(raw);
  if (!m) return false;
  const str = (k: string, max: number) =>
    m[k] === undefined || (typeof m[k] === "string" && (m[k] as string).length <= max);
  if (!str("title", MAX_TITLE) || !str("description", 5000) || !str("category", MAX_FIELD)) return false;
  if (!str("language", 16) || !str("visibility", 16)) return false;
  if (m.tags !== undefined) {
    if (!Array.isArray(m.tags) || m.tags.length > 50) return false;
    if (!m.tags.every((t) => typeof t === "string" && t.length <= 100)) return false;
  }
  for (const k of ["madeForKids", "mature"]) {
    if (m[k] !== undefined && typeof m[k] !== "boolean") return false;
  }
  return true;
}

export async function handleHubApi(req: HubApiRequest, deps: HubApiDeps): Promise<Response> {
  const now = deps.nowSeconds?.();
  const [head, ...rest] = req.path;

  // ── Preview: its own audience, nothing else accepts that token ──────────
  if (head === "preview") {
    if (req.method !== "GET") return err("method_not_allowed", 405);
    const claims = await verifyHubBearer(req.authorization, {
      secret: deps.ssoSecret,
      aud: HUB_PREVIEW_AUD,
      nowSeconds: now,
    });
    if (!claims) return err("unauthorized", 401);
    if (!deps.relayInternalHls) return err("preview_not_configured", 503);
    if (!deps.dbConfigured) return err("service_not_configured", 503);
    return proxyPreview({
      base: deps.relayInternalHls,
      streamKey: await deps.getStreamKey(claims.tenant_id),
      path: rest,
      search: req.search ?? "",
      accept: req.accept ?? null,
      fetchImpl: deps.fetchImpl,
    });
  }

  const c = await verifyHubBearer(req.authorization, {
    secret: deps.ssoSecret,
    aud: HUB_API_AUD,
    nowSeconds: now,
  });
  if (!c) return err("unauthorized", 401);
  if (!deps.dbConfigured) return err("service_not_configured", 503);
  const t = c.tenant_id;
  const body = asObject(req.body) ?? {};
  const route = `${req.method} ${req.path.map((p, i) => (i === 1 && head === "destinations" ? ":id" : i === 1 && head === "oauth" ? ":p" : p)).join("/")}`;

  switch (route) {
    case "GET state": {
      const [session, destinations] = await Promise.all([
        deps.getOrCreateSession(t),
        deps.getDestinations(t),
      ]);
      await syncTier(deps, c);
      return json({
        title: session.title,
        isLive: session.isLive,
        clipsEnabled: session.clipsEnabled,
        isFullAccess: isFullAccessTier(c.tier),
        broadcastMeta: session.broadcastMeta,
        rtmpUrl: deps.relayRtmpUrl,
        previewEnabled: Boolean(deps.relayInternalHls),
        oauthAvailable: deps.oauthAvailability(),
        destinations: destinations.map(publicDestination),
      });
    }

    case "PATCH session": {
      const patch: Partial<TenantSession> = {};
      if (body.title !== undefined) {
        if (typeof body.title !== "string" || body.title.length > MAX_TITLE) return err("bad_request", 400);
        patch.title = body.title.trim() || DEFAULT_TITLE;
      }
      if (body.clipsEnabled !== undefined) {
        if (typeof body.clipsEnabled !== "boolean") return err("bad_request", 400);
        // Turning the ChalyClip connection ON is full-access only.
        if (body.clipsEnabled && !isFullAccessTier(c.tier)) return err("full_access_required", 403);
        patch.clipsEnabled = body.clipsEnabled;
      }
      if (Object.keys(patch).length === 0) return err("bad_request", 400);
      await deps.getOrCreateSession(t); // the row may not exist yet
      await syncTier(deps, c);
      await deps.updateSession(t, patch);
      return ok();
    }

    case "GET stream-key": {
      await deps.getOrCreateSession(t);
      const key = await deps.getStreamKey(t);
      if (!key) return err("not_found", 404);
      return json({ streamKey: key });
    }

    case "POST stream-key/regenerate": {
      await deps.getOrCreateSession(t);
      await deps.regenerateStreamKey(t);
      return ok();
    }

    case "POST destinations": {
      if (!isBroadcastPlatform(body.platformId)) return err("bad_request", 400);
      await deps.addDestination(t, body.platformId);
      return ok({}, 201);
    }

    case "PATCH destinations/:id":
    case "POST destinations/:id/toggle":
    case "DELETE destinations/:id":
    case "GET destinations/:id/stream-key": {
      const id = req.path[1];
      // Existence is checked inside the tenant's own rows: another tenant's
      // id is indistinguishable from a missing one.
      const row = (await deps.getDestinations(t)).find((d) => d.id === id);
      if (!row) return err("not_found", 404);

      if (req.method === "GET") return json({ streamKey: row.streamKey });
      if (req.method === "DELETE") {
        await deps.removeDestination(t, id);
        return ok();
      }
      if (req.method === "POST") {
        if (!row.enabled && !isConfigured(row)) return err("not_configured", 409);
        await deps.toggleDestination(t, id);
        return ok({ enabled: !row.enabled });
      }
      const patch: { channelHandle?: string; streamTitle?: string; ingestUrl?: string; streamKey?: string } = {};
      for (const k of ["channelHandle", "streamTitle", "ingestUrl", "streamKey"] as const) {
        const v = body[k];
        if (v === undefined) continue;
        if (typeof v !== "string" || v.length > MAX_FIELD) return err("bad_request", 400);
        patch[k] = v.trim();
      }
      if (patch.ingestUrl !== undefined && !isAllowedIngestUrl(patch.ingestUrl)) return err("bad_request", 400);
      if (Object.keys(patch).length === 0) return err("bad_request", 400);
      await deps.updateDestination(t, id, patch);
      return ok();
    }

    case "POST broadcast": {
      if (!validBroadcastMeta(body.meta)) return err("bad_request", 400);
      const session = await deps.getOrCreateSession(t);
      const meta = normalizeBroadcastMeta(body.meta, session.title);
      await deps.publishBroadcastMeta(t, meta);
      // Best-effort by design — platform outages only surface as row status.
      await deps.pushBroadcastToConnectedPlatforms(t, meta);
      return ok();
    }

    case "GET streams": {
      const rows = await deps.listStreams(t, 50);
      return json({
        streams: rows.map((r) => {
          const i = r.streamId.lastIndexOf("__");
          return {
            id: i >= 0 ? r.streamId.slice(i + 2) : r.streamId,
            startedAt: r.startedAt,
            endedAt: r.endedAt,
            durationS: r.durationS,
          };
        }),
      });
    }

    case "POST oauth/:p/authorize":
    case "POST oauth/:p/complete": {
      const platform = req.path[1];
      const provider = deps.getOAuthProvider(platform);
      if (!provider) return err("not_found", 404);
      if (!provider.isConfigured()) return err(`${platform}_not_configured`, 503);
      const redirectUri = `${deps.publicOrigin}/api/oauth/${provider.platformId}/callback`;

      if (req.path[2] === "authorize") {
        const state = body.state;
        if (typeof state !== "string" || !STATE_RE.test(state)) return err("bad_request", 400);
        // The hub always sends a challenge (it doesn't know which platforms
        // use PKCE): validate it when present, use it only for PKCE ones.
        const ch = body.codeChallenge;
        if (ch !== undefined && (typeof ch !== "string" || !CHALLENGE_RE.test(ch)))
          return err("bad_request", 400);
        if (provider.usesPkce && ch === undefined) return err("bad_request", 400);
        const codeChallenge = provider.usesPkce ? (ch as string) : undefined;
        return json({ url: provider.buildAuthorizeUrl({ redirectUri, state, codeChallenge }) });
      }

      const code = body.code;
      if (typeof code !== "string" || code.length === 0 || code.length > 2048) return err("bad_request", 400);
      const v = body.codeVerifier;
      if (v !== undefined && (typeof v !== "string" || !VERIFIER_RE.test(v)))
        return err("bad_request", 400);
      if (provider.usesPkce && v === undefined) return err("bad_request", 400);
      const codeVerifier = provider.usesPkce ? (v as string) : undefined;
      try {
        const tokens = await provider.exchangeCode({ code, codeVerifier, redirectUri });
        const connection = await provider.fetchConnection(tokens.accessToken);
        await deps.connectOAuthDestination(t, provider.platformId, {
          ...connection,
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          expiresAt: tokens.expiresAt,
          scopes: tokens.scopes,
        });
      } catch {
        return err("exchange_failed", 502);
      }
      return ok({ platform: provider.platformId });
    }
  }
  return err("not_found", 404);
}
