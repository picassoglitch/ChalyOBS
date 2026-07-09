import "server-only";
import { BroadcastMeta } from "../destinations";
import {
  normalizeTokenResponse,
  OAuthFlowError,
  OAuthProvider,
  OAuthTokens,
  PlatformConnection,
  RawTokenResponse,
} from "./flow";

/**
 * Kick OAuth 2.1 (id.kick.com) + public API (api.kick.com/public/v1).
 *
 * Kick's connect is the closest to "pure" auto-connect: `streamkey:read`
 * returns the channel's ingest URL AND stream key in one call, and
 * `channel:write` accepts title/category/tags before or during a live.
 * PKCE (S256) is mandatory on every authorization request, even for
 * confidential clients, and the refresh token ROTATES on every refresh.
 */

const AUTHORIZE_URL = "https://id.kick.com/oauth/authorize";
const TOKEN_URL = "https://id.kick.com/oauth/token";
const API_BASE = "https://api.kick.com/public/v1";

const SCOPES = [
  "user:read",
  "channel:read",
  "channel:write",
  "streamkey:read",
].join(" ");

function readEnv(): { clientId: string; clientSecret: string } | null {
  const clientId = process.env.NEXOOBS_KICK_CLIENT_ID;
  const clientSecret = process.env.NEXOOBS_KICK_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

function requireEnv(): { clientId: string; clientSecret: string } {
  const env = readEnv();
  if (!env) throw new OAuthFlowError("kick oauth env missing", 500);
  return env;
}

async function requestTokens(
  form: Record<string, string>,
): Promise<OAuthTokens> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
  });
  if (!res.ok) {
    throw new OAuthFlowError(`kick token endpoint: HTTP ${res.status}`, res.status);
  }
  const json = (await res.json()) as RawTokenResponse;
  return normalizeTokenResponse(json, { fallbackScopes: SCOPES });
}

async function fetchConnection(
  accessToken: string,
): Promise<PlatformConnection> {
  const res = await fetch(`${API_BASE}/channels`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new OAuthFlowError(`kick channels: HTTP ${res.status}`, res.status);
  }
  const json = (await res.json()) as {
    data?: {
      slug?: string;
      stream?: { url?: string; key?: string };
    }[];
  };
  const ch = json.data?.[0];
  if (!ch?.slug || !ch.stream?.url || !ch.stream.key) {
    throw new OAuthFlowError("kick channels: missing stream endpoint", 502);
  }
  return {
    channelHandle: ch.slug,
    ingestUrl: ch.stream.url,
    streamKey: ch.stream.key,
  };
}

/** Resolve a free-text category ("Just Chatting", "Minecraft"…) to a Kick
 *  category id via search. Null when nothing matches — the caller then just
 *  omits category_id. */
async function searchCategoryId(
  accessToken: string,
  query: string,
): Promise<number | null> {
  const q = query.trim();
  if (!q) return null;
  const url = new URL(`${API_BASE}/categories`);
  url.searchParams.set("q", q);
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return null;
  const json = (await res.json()) as {
    data?: { id?: number; name?: string }[];
  };
  const items = json.data ?? [];
  const exact = items.find(
    (c) => (c.name ?? "").toLowerCase() === q.toLowerCase(),
  );
  return exact?.id ?? items[0]?.id ?? null;
}

/** Kick consumes title / category / tags of the composer superset (see
 *  PLATFORM_FIELD_SUPPORT). The API rejects empty patches, hence the guard. */
async function pushMeta(
  accessToken: string,
  meta: BroadcastMeta,
): Promise<void> {
  const body: Record<string, unknown> = {};
  if (meta.title.trim().length > 0) body.stream_title = meta.title.trim();
  const categoryId = await searchCategoryId(accessToken, meta.category).catch(
    () => null,
  );
  if (categoryId) body.category_id = categoryId;
  if (meta.tags.length > 0) body.custom_tags = meta.tags.slice(0, 10);
  if (Object.keys(body).length === 0) return;
  const res = await fetch(`${API_BASE}/channels`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new OAuthFlowError(`kick patch channel: HTTP ${res.status}`, res.status);
  }
}

export const kickProvider: OAuthProvider = {
  platformId: "kick",
  usesPkce: true,
  isConfigured: () => readEnv() !== null,

  buildAuthorizeUrl({ redirectUri, state, codeChallenge }) {
    const { clientId } = requireEnv();
    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("scope", SCOPES);
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", codeChallenge ?? "");
    url.searchParams.set("code_challenge_method", "S256");
    return url.toString();
  },

  exchangeCode({ code, redirectUri, codeVerifier }) {
    const env = requireEnv();
    return requestTokens({
      grant_type: "authorization_code",
      client_id: env.clientId,
      client_secret: env.clientSecret,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier ?? "",
      code,
    });
  },

  refreshTokens(refreshToken) {
    const env = requireEnv();
    return requestTokens({
      grant_type: "refresh_token",
      client_id: env.clientId,
      client_secret: env.clientSecret,
      refresh_token: refreshToken,
    });
  },

  fetchConnection,
  pushMeta,
};
