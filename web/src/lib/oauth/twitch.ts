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
 * Twitch OAuth (id.twitch.tv) + Helix API (api.twitch.tv/helix).
 *
 * Twitch's own way of connecting: classic authorization-code grant with a
 * confidential client (state only, no PKCE), every Helix call needs BOTH the
 * Bearer token and a Client-Id header, the ingest URL is a fixed constant
 * (only the key is per-user, via `channel:read:stream_key`), and the token
 * response's `scope` is a JSON array rather than a string. Refresh rotates
 * the refresh token.
 */

const AUTHORIZE_URL = "https://id.twitch.tv/oauth2/authorize";
const TOKEN_URL = "https://id.twitch.tv/oauth2/token";
const API_BASE = "https://api.twitch.tv/helix";

/** Twitch's global RTMP entrypoint — anycast to the nearest ingest PoP. */
const TWITCH_INGEST = "rtmp://live.twitch.tv/app";

const SCOPES = ["channel:read:stream_key", "channel:manage:broadcast"].join(" ");

function readEnv(): { clientId: string; clientSecret: string } | null {
  const clientId = process.env.CHALYBOBS_TWITCH_CLIENT_ID;
  const clientSecret = process.env.CHALYBOBS_TWITCH_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

function requireEnv(): { clientId: string; clientSecret: string } {
  const env = readEnv();
  if (!env) throw new OAuthFlowError("twitch oauth env missing", 500);
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
    throw new OAuthFlowError(
      `twitch token endpoint: HTTP ${res.status}`,
      res.status,
    );
  }
  const json = (await res.json()) as RawTokenResponse;
  return normalizeTokenResponse(json, { fallbackScopes: SCOPES });
}

async function helixGet<T>(
  accessToken: string,
  path: string,
): Promise<T> {
  const { clientId } = requireEnv();
  const res = await fetch(`${API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Client-Id": clientId,
    },
  });
  if (!res.ok) {
    throw new OAuthFlowError(`twitch ${path}: HTTP ${res.status}`, res.status);
  }
  return (await res.json()) as T;
}

/** The token's own user — login (handle) + id (broadcaster_id for every
 *  other Helix call). No params → Helix resolves from the Bearer token. */
async function fetchSelf(
  accessToken: string,
): Promise<{ id: string; login: string }> {
  const json = await helixGet<{ data?: { id?: string; login?: string }[] }>(
    accessToken,
    "/users",
  );
  const user = json.data?.[0];
  if (!user?.id || !user.login) {
    throw new OAuthFlowError("twitch users: empty response", 502);
  }
  return { id: user.id, login: user.login };
}

async function fetchConnection(
  accessToken: string,
): Promise<PlatformConnection> {
  const self = await fetchSelf(accessToken);
  const json = await helixGet<{ data?: { stream_key?: string }[] }>(
    accessToken,
    `/streams/key?broadcaster_id=${self.id}`,
  );
  const key = json.data?.[0]?.stream_key;
  if (!key) {
    throw new OAuthFlowError("twitch streams/key: missing key", 502);
  }
  return {
    channelHandle: self.login,
    ingestUrl: TWITCH_INGEST,
    streamKey: key,
  };
}

/** Free-text category → Twitch game id via Helix search. */
async function searchGameId(
  accessToken: string,
  query: string,
): Promise<string | null> {
  const q = query.trim();
  if (!q) return null;
  const json = await helixGet<{ data?: { id?: string; name?: string }[] }>(
    accessToken,
    `/search/categories?query=${encodeURIComponent(q)}&first=10`,
  ).catch(() => null);
  const items = json?.data ?? [];
  const exact = items.find(
    (c) => (c.name ?? "").toLowerCase() === q.toLowerCase(),
  );
  return exact?.id ?? items[0]?.id ?? null;
}

/** Twitch consumes title / category / tags / language (composer's `mature`
 *  maps to content-classification labels, which need per-label semantics —
 *  deliberately not guessed here). PATCH returns 204 on success. */
async function pushMeta(
  accessToken: string,
  meta: BroadcastMeta,
): Promise<void> {
  const { clientId } = requireEnv();
  const self = await fetchSelf(accessToken);
  const body: Record<string, unknown> = {};
  if (meta.title.trim().length > 0) body.title = meta.title.trim();
  const gameId = await searchGameId(accessToken, meta.category);
  if (gameId) body.game_id = gameId;
  if (meta.tags.length > 0) {
    body.tags = meta.tags.map((t) => t.slice(0, 25)).slice(0, 10);
  }
  if (meta.language) body.broadcaster_language = meta.language;
  if (Object.keys(body).length === 0) return;
  const res = await fetch(
    `${API_BASE}/channels?broadcaster_id=${self.id}`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Client-Id": clientId,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) {
    throw new OAuthFlowError(
      `twitch patch channel: HTTP ${res.status}`,
      res.status,
    );
  }
}

export const twitchProvider: OAuthProvider = {
  platformId: "twitch",
  usesPkce: false,
  isConfigured: () => readEnv() !== null,

  buildAuthorizeUrl({ redirectUri, state }) {
    const { clientId } = requireEnv();
    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("scope", SCOPES);
    url.searchParams.set("state", state);
    return url.toString();
  },

  exchangeCode({ code, redirectUri }) {
    const env = requireEnv();
    return requestTokens({
      grant_type: "authorization_code",
      client_id: env.clientId,
      client_secret: env.clientSecret,
      redirect_uri: redirectUri,
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
