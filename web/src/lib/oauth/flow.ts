import "server-only";
import {
  b64urlDecodeString,
  b64urlEncode,
  b64urlEncodeString,
} from "../b64url";
import { BroadcastMeta, PlatformId } from "../destinations";

/**
 * Platform-agnostic pieces of the OAuth auto-connect flow. Each platform
 * connects its own way (endpoints, PKCE or not, what "the stream endpoint"
 * even means), so everything platform-specific lives behind OAuthProvider
 * (kick.ts / twitch.ts / youtube.ts, registered in providers.ts) — this file
 * only owns what's genuinely identical: PKCE/state generation, the state
 * cookie, and the shared types the routes and the metadata push consume.
 */

export class OAuthFlowError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "OAuthFlowError";
  }
}

export interface OAuthTokens {
  accessToken: string;
  refreshToken: string;
  /** ISO timestamp of access-token expiry. */
  expiresAt: string;
  /** Space-separated scopes actually granted. */
  scopes: string;
}

/** What a completed connect learned about the channel — this is the payload
 *  that replaces manual entry (see connectOAuthDestination). */
export interface PlatformConnection {
  channelHandle: string;
  ingestUrl: string;
  streamKey: string;
}

export interface OAuthProvider {
  platformId: PlatformId;
  /** Whether the authorize request carries a PKCE S256 challenge. */
  usesPkce: boolean;
  /** False when the deploy lacks this platform's app credentials — the UI
   *  then falls back to manual entry for it. */
  isConfigured(): boolean;
  buildAuthorizeUrl(opts: {
    redirectUri: string;
    state: string;
    /** Present iff usesPkce. */
    codeChallenge?: string;
  }): string;
  exchangeCode(opts: {
    code: string;
    redirectUri: string;
    codeVerifier?: string;
  }): Promise<OAuthTokens>;
  /** Must survive refresh-token rotation: when the platform doesn't return a
   *  new refresh token (Google), keep returning the one passed in. */
  refreshTokens(refreshToken: string): Promise<OAuthTokens>;
  /** Fetch handle + ingest URL + stream key with a fresh access token. */
  fetchConnection(accessToken: string): Promise<PlatformConnection>;
  /** Optional: mirror composer metadata to the platform (title/category/…).
   *  Absent when the platform has no meaningful pre-live metadata API. */
  pushMeta?(accessToken: string, meta: BroadcastMeta): Promise<void>;
}

// ── PKCE / state ─────────────────────────────────────────────────────────────

function randomToken(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return b64urlEncode(buf);
}

/** 32 random bytes → 43-char base64url verifier (RFC 7636 minimum length). */
export function generatePkceVerifier(): string {
  return randomToken(32);
}

export function generateOAuthState(): string {
  return randomToken(16);
}

export async function pkceChallengeS256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return b64urlEncode(new Uint8Array(digest));
}

// ── State cookie ─────────────────────────────────────────────────────────────
//
// Short-lived httpOnly cookie carrying {state, PKCE verifier} between /start
// and /callback. sameSite=lax so it rides the top-level navigation back from
// the platform's consent page. One cookie per platform, so parallel connects
// can't clobber each other.

export const OAUTH_COOKIE_TTL_SECONDS = 600;

export function oauthCookieName(platformId: string): string {
  return `chalybobs_oauth_${platformId}`;
}

export interface OAuthCookiePayload {
  state: string;
  verifier?: string;
}

export function encodeOAuthCookie(p: OAuthCookiePayload): string {
  return b64urlEncodeString(JSON.stringify(p));
}

export function parseOAuthCookie(raw: string): OAuthCookiePayload | null {
  try {
    const json = JSON.parse(
      b64urlDecodeString(raw),
    ) as Partial<OAuthCookiePayload>;
    if (typeof json.state !== "string") return null;
    if (json.verifier !== undefined && typeof json.verifier !== "string") {
      return null;
    }
    return { state: json.state, verifier: json.verifier };
  } catch {
    return null;
  }
}

/** Shared shape of an OAuth token-endpoint response (Kick/Twitch/Google all
 *  speak this dialect, modulo optional fields the providers normalize). */
export interface RawTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string | string[];
}

export function normalizeTokenResponse(
  json: RawTokenResponse,
  opts: {
    /** Refresh-token fallback for platforms that don't rotate it (Google). */
    fallbackRefreshToken?: string;
    fallbackScopes: string;
  },
): OAuthTokens {
  const refreshToken = json.refresh_token ?? opts.fallbackRefreshToken;
  if (!json.access_token || !refreshToken) {
    throw new OAuthFlowError("token endpoint: malformed response", 502);
  }
  const scopes = Array.isArray(json.scope)
    ? json.scope.join(" ")
    : (json.scope ?? opts.fallbackScopes);
  return {
    accessToken: json.access_token,
    refreshToken,
    expiresAt: new Date(
      Date.now() + (json.expires_in ?? 3600) * 1000,
    ).toISOString(),
    scopes,
  };
}
