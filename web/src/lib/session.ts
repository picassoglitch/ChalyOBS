/**
 * ChalyOBS session cookie — independent of the SSO secret.
 *
 * Stateless: the cookie carries the verified user claims directly, signed
 * with CHALYBOBS_SESSION_SECRET. No DB lookup per request; revocation = wait
 * for expiry or rotate CHALYBOBS_SESSION_SECRET (invalidates everyone).
 *
 * Same wire shape as the SSO token (base64url payload + base64url HMAC) so
 * we don't drag in two parsers. Different secret + longer TTL — the SSO
 * token is a single-use handoff, the session cookie persists for a month.
 */

import { b64urlDecode, b64urlDecodeString, b64urlEncode, b64urlEncodeString } from "./b64url";

export const SESSION_COOKIE_NAME = "chalybobs_session";
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

export interface SessionClaims {
  user_id: string;
  email: string;
  tenant_id: string;
  tier?: string;
  /** Unix seconds. */
  exp: number;
}

export class SessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionError";
  }
}

export async function signSession(
  claims: Omit<SessionClaims, "exp"> & { exp?: number },
  secret: string,
): Promise<string> {
  if (!secret) throw new SessionError("CHALYBOBS_SESSION_SECRET missing");
  const exp =
    claims.exp ?? Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const payload: SessionClaims = {
    user_id: claims.user_id,
    email: claims.email,
    tenant_id: claims.tenant_id,
    exp,
  };
  if (claims.tier) payload.tier = claims.tier;

  const payloadB64 = b64urlEncodeString(JSON.stringify(payload));
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sigBuf = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(payloadB64),
  );
  return `${payloadB64}.${b64urlEncode(new Uint8Array(sigBuf))}`;
}

export async function verifySession(
  cookieValue: string,
  secret: string,
): Promise<SessionClaims> {
  if (!secret) throw new SessionError("CHALYBOBS_SESSION_SECRET missing");
  if (!cookieValue) throw new SessionError("empty session");

  const dotAt = cookieValue.indexOf(".");
  if (dotAt <= 0 || dotAt === cookieValue.length - 1) {
    throw new SessionError("malformed session");
  }
  const payloadB64 = cookieValue.slice(0, dotAt);
  const sigB64 = cookieValue.slice(dotAt + 1);

  let claimedSig: Uint8Array<ArrayBuffer>;
  try {
    claimedSig = b64urlDecode(sigB64);
  } catch {
    throw new SessionError("bad signature encoding");
  }

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    claimedSig,
    new TextEncoder().encode(payloadB64),
  );
  if (!valid) throw new SessionError("bad signature");

  let raw: unknown;
  try {
    raw = JSON.parse(b64urlDecodeString(payloadB64));
  } catch {
    throw new SessionError("bad payload encoding");
  }
  const claims = parseClaims(raw);
  if (claims.exp < Math.floor(Date.now() / 1000)) {
    throw new SessionError("session expired");
  }
  return claims;
}

function parseClaims(raw: unknown): SessionClaims {
  if (!raw || typeof raw !== "object") throw new SessionError("bad claims");
  const obj = raw as Record<string, unknown>;
  if (typeof obj.user_id !== "string") throw new SessionError("bad claims");
  if (typeof obj.email !== "string") throw new SessionError("bad claims");
  if (typeof obj.tenant_id !== "string") throw new SessionError("bad claims");
  if (typeof obj.exp !== "number") throw new SessionError("bad claims");
  const out: SessionClaims = {
    user_id: obj.user_id,
    email: obj.email,
    tenant_id: obj.tenant_id,
    exp: obj.exp,
  };
  if (typeof obj.tier === "string") out.tier = obj.tier;
  return out;
}
