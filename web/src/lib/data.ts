import "server-only";
import { getSupabaseAdmin } from "./supabase";
import {
  BroadcastMeta,
  DestinationConfig,
  DestinationStatus,
  normalizeBroadcastMeta,
  PLATFORM_META,
  PlatformId,
} from "./destinations";

/**
 * Per-tenant data layer. Every function takes a tenantId (from the verified
 * session cookie) and scopes all queries to it — the service-role client
 * bypasses RLS, so this code is the tenant boundary.
 *
 * Tables (see chalyb migration 0023):
 *   chalybobs_sessions      1 row per tenant — title, flags, ingest stream key
 *   chalybobs_destinations  N rows per tenant — one per connected platform
 */

export interface TenantSession {
  title: string;
  isLive: boolean;
  clipsEnabled: boolean;
  streamKey: string;
  /** Full broadcast-metadata composer state (title/description/category/…). */
  broadcastMeta: BroadcastMeta;
}

const DEFAULT_TITLE = "Mi transmisión en vivo";

/** Generate a fresh ingest stream key. Format mirrors the mock so the UI
 *  reads the same. Crypto-random, server-side. */
function freshStreamKey(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `chalyb_live_${hex}`;
}

/** Load the tenant's session row, creating a default one (with a freshly
 *  generated stream key) on first access. */
export async function getOrCreateSession(
  tenantId: string,
): Promise<TenantSession> {
  const db = getSupabaseAdmin();
  const { data } = await db
    .from("chalybobs_sessions")
    .select("title, is_live, clips_enabled, stream_key, broadcast_meta")
    .eq("tenant_id", tenantId)
    .maybeSingle();

  if (data) {
    const title = data.title as string;
    return {
      title,
      isLive: data.is_live as boolean,
      clipsEnabled: (data.clips_enabled as boolean | null) ?? true,
      streamKey: data.stream_key as string,
      broadcastMeta: normalizeBroadcastMeta(data.broadcast_meta, title),
    };
  }

  const fresh: TenantSession = {
    title: DEFAULT_TITLE,
    isLive: false,
    clipsEnabled: true,
    streamKey: freshStreamKey(),
    broadcastMeta: normalizeBroadcastMeta(null, DEFAULT_TITLE),
  };
  // record_enabled is omitted on insert — the column keeps its DB default
  // (true). Recording isn't a user-facing toggle anymore (ChalybClip drives it).
  await db.from("chalybobs_sessions").insert({
    tenant_id: tenantId,
    title: fresh.title,
    is_live: fresh.isLive,
    clips_enabled: fresh.clipsEnabled,
    stream_key: fresh.streamKey,
    broadcast_meta: fresh.broadcastMeta,
  });
  return fresh;
}

/** Read-only: is the ChalybClip connection on for this tenant? Source of truth
 *  for the bidirectional switch (ChalybOBS header ↔ ChalybClip Live page) and the
 *  started/ended forwarding gate. */
export async function getClipsEnabled(tenantId: string): Promise<boolean> {
  const db = getSupabaseAdmin();
  const { data } = await db
    .from("chalybobs_sessions")
    .select("clips_enabled")
    .eq("tenant_id", tenantId)
    .maybeSingle();
  return (data?.clips_enabled as boolean | null) ?? false;
}

/** Set the connection flag, creating the session row if the tenant hasn't
 *  opened ChalybOBS yet (so the switch works from the ChalybClip side too). */
export async function setClipsEnabled(
  tenantId: string,
  enabled: boolean,
): Promise<void> {
  await getOrCreateSession(tenantId); // ensure row exists
  await updateSession(tenantId, { clipsEnabled: enabled });
}

/** Read-only stream-key lookup (no create). Used by the preview proxy on
 *  every segment request, so it must stay a single cheap select. */
export async function getStreamKey(tenantId: string): Promise<string | null> {
  const db = getSupabaseAdmin();
  const { data } = await db
    .from("chalybobs_sessions")
    .select("stream_key")
    .eq("tenant_id", tenantId)
    .maybeSingle();
  return (data?.stream_key as string | undefined) ?? null;
}

export async function updateSession(
  tenantId: string,
  patch: Partial<TenantSession>,
): Promise<void> {
  const db = getSupabaseAdmin();
  const row: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (patch.title !== undefined) row.title = patch.title;
  if (patch.isLive !== undefined) row.is_live = patch.isLive;
  if (patch.clipsEnabled !== undefined) row.clips_enabled = patch.clipsEnabled;
  if (patch.streamKey !== undefined) row.stream_key = patch.streamKey;
  if (patch.broadcastMeta !== undefined) row.broadcast_meta = patch.broadcastMeta;
  await db.from("chalybobs_sessions").update(row).eq("tenant_id", tenantId);
}

export async function regenerateStreamKey(tenantId: string): Promise<string> {
  const key = freshStreamKey();
  await updateSession(tenantId, { streamKey: key });
  return key;
}

// ── Destinations ───────────────────────────────────────────────────────────

interface DestinationRow {
  id: string;
  platform_id: string;
  channel_handle: string;
  stream_title: string;
  ingest_url: string;
  stream_key: string;
  oauth_refresh_token: string | null;
  enabled: boolean;
  status_kind: string | null;
  status_platform_name: string | null;
}

function rowToConfig(r: DestinationRow): DestinationConfig & { id: string } {
  let status: DestinationStatus | undefined;
  switch (r.status_kind) {
    case "ok":
      status = { kind: "ok" };
      break;
    case "offline":
      status = { kind: "offline" };
      break;
    case "expired":
      status = { kind: "expired", action: "reconnect" };
      break;
    case "pending_approval":
      status = {
        kind: "pending_approval",
        platformName: r.status_platform_name ?? "Plataforma",
      };
      break;
    default:
      status = undefined;
  }
  return {
    id: r.id,
    platformId: r.platform_id as PlatformId,
    channelHandle: r.channel_handle,
    streamTitle: r.stream_title,
    ingestUrl: r.ingest_url,
    streamKey: r.stream_key,
    // Only a boolean crosses to the client — tokens never leave the server.
    oauthConnected: (r.oauth_refresh_token ?? "").length > 0,
    enabled: r.enabled,
    status,
  };
}

export async function getDestinations(
  tenantId: string,
): Promise<(DestinationConfig & { id: string })[]> {
  const db = getSupabaseAdmin();
  const { data, error } = await db
    .from("chalybobs_destinations")
    .select(
      "id, platform_id, channel_handle, stream_title, ingest_url, stream_key, oauth_refresh_token, enabled, status_kind, status_platform_name",
    )
    .eq("tenant_id", tenantId)
    .order("created_at", { ascending: true });
  if (!error) return (data ?? []).map((r) => rowToConfig(r as DestinationRow));

  // Schema-drift guard: before migration 0025 lands, oauth_refresh_token
  // doesn't exist and the select above 400s. Retry with the legacy column
  // set so the channels panel keeps working (rows just read as not
  // OAuth-connected). Remove once 0025 is applied everywhere.
  const legacy = await db
    .from("chalybobs_destinations")
    .select(
      "id, platform_id, channel_handle, stream_title, ingest_url, stream_key, enabled, status_kind, status_platform_name",
    )
    .eq("tenant_id", tenantId)
    .order("created_at", { ascending: true });
  return (legacy.data ?? []).map((r) =>
    rowToConfig({ ...(r as Omit<DestinationRow, "oauth_refresh_token">), oauth_refresh_token: null }),
  );
}

export async function addDestination(
  tenantId: string,
  platformId: PlatformId,
): Promise<void> {
  const db = getSupabaseAdmin();
  // Seed the ingest URL from the platform's known hint so named platforms
  // (Twitch/YouTube/Kick/Facebook) are pre-filled; the user only adds the
  // stream key. custom_rtmp / custom_srt start empty for manual entry.
  const ingestUrl = PLATFORM_META[platformId]?.ingestHint ?? "";
  await db.from("chalybobs_destinations").insert({
    tenant_id: tenantId,
    platform_id: platformId,
    ingest_url: ingestUrl,
    enabled: false,
    status_kind: "offline",
  });
}

/** Update editable fields on a destination. Marks status 'offline' once a
 *  stream key is present (configured but not live) so the row reads as ready
 *  rather than erroring. Scoped by tenant. */
export async function updateDestination(
  tenantId: string,
  id: string,
  patch: {
    channelHandle?: string;
    streamTitle?: string;
    ingestUrl?: string;
    streamKey?: string;
  },
): Promise<void> {
  const db = getSupabaseAdmin();
  const row: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (patch.channelHandle !== undefined) row.channel_handle = patch.channelHandle;
  if (patch.streamTitle !== undefined) row.stream_title = patch.streamTitle;
  if (patch.ingestUrl !== undefined) row.ingest_url = patch.ingestUrl;
  if (patch.streamKey !== undefined) row.stream_key = patch.streamKey;
  await db
    .from("chalybobs_destinations")
    .update(row)
    .eq("tenant_id", tenantId)
    .eq("id", id);
}

/** Whether a destination has the minimum config to broadcast: an ingest URL
 *  and a stream key. Used to gate the enabled toggle. */
export function isDestinationConfigured(d: {
  ingestUrl: string;
  streamKey: string;
}): boolean {
  return d.ingestUrl.trim().length > 0 && d.streamKey.trim().length > 0;
}

export async function toggleDestination(
  tenantId: string,
  id: string,
): Promise<void> {
  const db = getSupabaseAdmin();
  const { data } = await db
    .from("chalybobs_destinations")
    .select("enabled")
    .eq("tenant_id", tenantId)
    .eq("id", id)
    .maybeSingle();
  if (!data) return;
  await db
    .from("chalybobs_destinations")
    .update({ enabled: !data.enabled, updated_at: new Date().toISOString() })
    .eq("tenant_id", tenantId)
    .eq("id", id);
}

/** Persist the full broadcast-metadata composer state for a tenant, then mirror
 *  the (sanitized) title onto the session and every destination so the relay
 *  fan-out and the channel-row UI stay in sync. The non-title fields live in
 *  the session's broadcast_meta blob; each platform consumes the subset it
 *  supports (see PLATFORM_FIELD_SUPPORT) at publish time. */
export async function publishBroadcastMeta(
  tenantId: string,
  meta: BroadcastMeta,
): Promise<void> {
  const db = getSupabaseAdmin();
  const title = meta.title.trim() || DEFAULT_TITLE;
  const clean: BroadcastMeta = {
    ...meta,
    title,
    description: meta.description.trim(),
    category: meta.category.trim(),
    tags: meta.tags.map((t) => t.trim()).filter((t) => t.length > 0),
  };
  const now = new Date().toISOString();
  await db
    .from("chalybobs_sessions")
    .update({ title, broadcast_meta: clean, updated_at: now })
    .eq("tenant_id", tenantId);
  await db
    .from("chalybobs_destinations")
    .update({ stream_title: title, updated_at: now })
    .eq("tenant_id", tenantId);
}

// ── OAuth auto-connect (Restream-style) ─────────────────────────────────────

/** Everything the platform's OAuth callback learned: identity, the stream
 *  endpoint (this is what replaces manual entry), and the token set. */
export interface OAuthConnection {
  channelHandle: string;
  ingestUrl: string;
  streamKey: string;
  accessToken: string;
  refreshToken: string;
  /** ISO timestamp of access-token expiry. */
  expiresAt: string;
  /** Space-separated scopes actually granted. */
  scopes: string;
}

/** Upsert the tenant's destination for a platform from a completed OAuth
 *  flow. A fresh connection arrives fully configured, so a NEW row starts
 *  enabled (that's the auto-connect promise); a RE-connection keeps the
 *  user's existing on/off choice and just refreshes credentials + status. */
export async function connectOAuthDestination(
  tenantId: string,
  platformId: PlatformId,
  conn: OAuthConnection,
): Promise<void> {
  const db = getSupabaseAdmin();
  const row = {
    channel_handle: conn.channelHandle,
    ingest_url: conn.ingestUrl,
    stream_key: conn.streamKey,
    oauth_token: conn.accessToken,
    oauth_refresh_token: conn.refreshToken,
    oauth_expires_at: conn.expiresAt,
    oauth_scopes: conn.scopes,
    status_kind: "ok",
    status_platform_name: null,
    updated_at: new Date().toISOString(),
  };
  const { data } = await db
    .from("chalybobs_destinations")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("platform_id", platformId)
    .limit(1);
  const existing = data?.[0];
  if (existing) {
    await db
      .from("chalybobs_destinations")
      .update(row)
      .eq("tenant_id", tenantId)
      .eq("id", existing.id as string);
  } else {
    await db.from("chalybobs_destinations").insert({
      tenant_id: tenantId,
      platform_id: platformId,
      enabled: true,
      ...row,
    });
  }
}

/** Server-side token view of a destination — never crosses to the client. */
export interface OAuthTokenRow {
  id: string;
  platformId: PlatformId;
  accessToken: string;
  refreshToken: string;
  expiresAt: string | null;
}

/** OAuth-connected destinations of a tenant (rows with a refresh token). */
export async function getOAuthConnections(
  tenantId: string,
): Promise<OAuthTokenRow[]> {
  const db = getSupabaseAdmin();
  const { data } = await db
    .from("chalybobs_destinations")
    .select("id, platform_id, oauth_token, oauth_refresh_token, oauth_expires_at")
    .eq("tenant_id", tenantId)
    .neq("oauth_refresh_token", "");
  return (data ?? []).map((r) => ({
    id: r.id as string,
    platformId: r.platform_id as PlatformId,
    accessToken: (r.oauth_token as string | null) ?? "",
    refreshToken: (r.oauth_refresh_token as string | null) ?? "",
    expiresAt: (r.oauth_expires_at as string | null) ?? null,
  }));
}

/** Persist a rotated token set (platforms rotate the refresh token too). */
export async function saveOAuthTokens(
  tenantId: string,
  id: string,
  tokens: { accessToken: string; refreshToken: string; expiresAt: string },
): Promise<void> {
  const db = getSupabaseAdmin();
  await db
    .from("chalybobs_destinations")
    .update({
      oauth_token: tokens.accessToken,
      oauth_refresh_token: tokens.refreshToken,
      oauth_expires_at: tokens.expiresAt,
      status_kind: "ok",
      updated_at: new Date().toISOString(),
    })
    .eq("tenant_id", tenantId)
    .eq("id", id);
}

/** Flag a destination's health (e.g. 'expired' when a token refresh fails —
 *  the row then shows the Reconnect banner). */
export async function markDestinationStatus(
  tenantId: string,
  id: string,
  kind: "ok" | "offline" | "expired",
): Promise<void> {
  const db = getSupabaseAdmin();
  await db
    .from("chalybobs_destinations")
    .update({ status_kind: kind, updated_at: new Date().toISOString() })
    .eq("tenant_id", tenantId)
    .eq("id", id);
}

export async function removeDestination(
  tenantId: string,
  id: string,
): Promise<void> {
  const db = getSupabaseAdmin();
  await db
    .from("chalybobs_destinations")
    .delete()
    .eq("tenant_id", tenantId)
    .eq("id", id);
}

// ── Relay integration (called by the chalybclip-live MediaMTX hooks) ──────────

/** Resolve a publish stream key → tenant. Used by /api/internal/live/authorize
 *  so the relay knows whether to accept the push + whose destinations to fan
 *  out to. Returns null for an unknown key (relay rejects). */
export async function getTenantByStreamKey(
  streamKey: string,
): Promise<string | null> {
  const db = getSupabaseAdmin();
  const { data } = await db
    .from("chalybobs_sessions")
    .select("tenant_id")
    .eq("stream_key", streamKey)
    .maybeSingle();
  return (data?.tenant_id as string | undefined) ?? null;
}

const STREAM_ID_SEP = "__";

/** Mint a unique-per-session stream id that ALSO encodes the tenant:
 *  `<tenant_id>__<random>`. This gives both properties at once:
 *   - tenant binding: the relay's storage prefix (live/<stream_id>/) is
 *     namespaced per tenant, so no user can reach another's recording.
 *   - per-stream uniqueness: the random suffix means every session is its
 *     own recording + clip set (no more reopening the previous stream).
 *  Tenant ids are UUIDs (no '__'), so the tenant is recoverable by splitting
 *  on the last separator. */
export function mintStreamId(tenantId: string): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  const rand = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `${tenantId}${STREAM_ID_SEP}${rand}`;
}

/** Recover the tenant from a stream id minted by mintStreamId(). Returns
 *  null if the id isn't in the expected shape. */
export function tenantFromStreamId(streamId: string): string | null {
  const i = streamId.lastIndexOf(STREAM_ID_SEP);
  if (i <= 0) return null;
  return streamId.slice(0, i);
}

/** Fan-out targets for the relay: enabled + fully-configured destinations,
 *  each as a complete push URL the relay feeds to `ffmpeg -c copy`
 *  (rtmp/rtmps → flv muxer, srt → mpegts — the relay picks by scheme). */
export async function getFanoutDestinations(
  tenantId: string,
): Promise<{ platform: string; push_url: string }[]> {
  const db = getSupabaseAdmin();
  const { data } = await db
    .from("chalybobs_destinations")
    .select("platform_id, ingest_url, stream_key, enabled")
    .eq("tenant_id", tenantId)
    .eq("enabled", true);
  return (data ?? [])
    .filter(
      (r) =>
        ((r.ingest_url as string) ?? "").trim().length > 0 &&
        ((r.stream_key as string) ?? "").trim().length > 0,
    )
    .map((r) => {
      const base = (r.ingest_url as string).trim().replace(/\/+$/, "");
      const key = (r.stream_key as string).trim();
      // SRT carries the credential as ?streamid=..., not as a path
      // segment. If the user's URL already embeds it, it's complete as-is.
      const pushUrl = base.startsWith("srt://")
        ? base.includes("streamid=")
          ? base
          : `${base}${base.includes("?") ? "&" : "?"}streamid=${key}`
        : `${base}/${key}`;
      return {
        platform: r.platform_id as string,
        push_url: pushUrl,
      };
    });
}
