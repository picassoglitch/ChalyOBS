import "server-only";
import {
  normalizeTokenResponse,
  OAuthFlowError,
  OAuthProvider,
  OAuthTokens,
  PlatformConnection,
  RawTokenResponse,
} from "./flow";

/**
 * YouTube Live via Google OAuth (accounts.google.com) + Data API v3.
 *
 * YouTube's own way of connecting: Google issues the refresh token ONLY when
 * the authorize request carries access_type=offline&prompt=consent, and —
 * unlike Kick/Twitch — never rotates it on refresh (normalizeTokenResponse
 * falls back to the stored one). There is no single "stream key" API either:
 * the equivalent is a REUSABLE liveStream resource, whose cdn.ingestionInfo
 * holds ingestionAddress (+ streamName as the key). We reuse the user's
 * existing RTMP stream or create one named "ChalyOBS".
 *
 * Metadata (title/description/visibility) applies per-BROADCAST on YouTube,
 * not per-channel, so there is no pushMeta here — the composer's values are
 * consumed when broadcast automation lands.
 */

const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API_BASE = "https://www.googleapis.com/youtube/v3";

/** Single scope covering liveStreams read/insert (and future broadcasts). */
const SCOPES = "https://www.googleapis.com/auth/youtube";

function readEnv(): { clientId: string; clientSecret: string } | null {
  const clientId = process.env.CHALYBOBS_YOUTUBE_CLIENT_ID;
  const clientSecret = process.env.CHALYBOBS_YOUTUBE_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

function requireEnv(): { clientId: string; clientSecret: string } {
  const env = readEnv();
  if (!env) throw new OAuthFlowError("youtube oauth env missing", 500);
  return env;
}

async function requestTokens(
  form: Record<string, string>,
  fallbackRefreshToken?: string,
): Promise<OAuthTokens> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
  });
  if (!res.ok) {
    throw new OAuthFlowError(
      `google token endpoint: HTTP ${res.status}`,
      res.status,
    );
  }
  const json = (await res.json()) as RawTokenResponse;
  return normalizeTokenResponse(json, {
    fallbackRefreshToken,
    fallbackScopes: SCOPES,
  });
}

interface LiveStreamResource {
  cdn?: {
    ingestionType?: string;
    ingestionInfo?: { ingestionAddress?: string; streamName?: string };
  };
}

function toConnection(
  handle: string,
  stream: LiveStreamResource,
): PlatformConnection | null {
  const info = stream.cdn?.ingestionInfo;
  if (!info?.ingestionAddress || !info.streamName) return null;
  return {
    channelHandle: handle,
    ingestUrl: info.ingestionAddress,
    streamKey: info.streamName,
  };
}

async function fetchConnection(
  accessToken: string,
): Promise<PlatformConnection> {
  const headers = { Authorization: `Bearer ${accessToken}` };

  const chRes = await fetch(
    `${API_BASE}/channels?part=snippet&mine=true`,
    { headers },
  );
  if (!chRes.ok) {
    throw new OAuthFlowError(`youtube channels: HTTP ${chRes.status}`, chRes.status);
  }
  const chJson = (await chRes.json()) as {
    items?: { snippet?: { title?: string } }[];
  };
  const handle = chJson.items?.[0]?.snippet?.title ?? "YouTube";

  // Reuse the user's existing RTMP stream (what YouTube Studio shows as the
  // persistent stream key) when one exists…
  const listRes = await fetch(
    `${API_BASE}/liveStreams?part=cdn&mine=true&maxResults=50`,
    { headers },
  );
  if (!listRes.ok) {
    throw new OAuthFlowError(
      `youtube liveStreams: HTTP ${listRes.status}`,
      listRes.status,
    );
  }
  const listJson = (await listRes.json()) as { items?: LiveStreamResource[] };
  for (const item of listJson.items ?? []) {
    if ((item.cdn?.ingestionType ?? "rtmp") !== "rtmp") continue;
    const conn = toConnection(handle, item);
    if (conn) return conn;
  }

  // …otherwise create a reusable one, so first-time streamers still get a
  // working endpoint out of a single click.
  const insertRes = await fetch(
    `${API_BASE}/liveStreams?part=snippet,cdn,contentDetails`,
    {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        snippet: { title: "ChalyOBS" },
        cdn: {
          ingestionType: "rtmp",
          resolution: "variable",
          frameRate: "variable",
        },
        contentDetails: { isReusable: true },
      }),
    },
  );
  if (!insertRes.ok) {
    throw new OAuthFlowError(
      `youtube liveStreams insert: HTTP ${insertRes.status}`,
      insertRes.status,
    );
  }
  const created = (await insertRes.json()) as LiveStreamResource;
  const conn = toConnection(handle, created);
  if (!conn) {
    throw new OAuthFlowError("youtube liveStreams: missing ingestion info", 502);
  }
  return conn;
}

export const youtubeProvider: OAuthProvider = {
  platformId: "youtube",
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
    // Without these two, Google omits the refresh token and the connection
    // would die within the hour.
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
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
    return requestTokens(
      {
        grant_type: "refresh_token",
        client_id: env.clientId,
        client_secret: env.clientSecret,
        refresh_token: refreshToken,
      },
      // Google does not rotate refresh tokens — keep the stored one.
      refreshToken,
    );
  },

  fetchConnection,
};
