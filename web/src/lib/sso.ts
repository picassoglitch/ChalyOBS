/**
 * SSO token verifier — TypeScript port of ChalyClip's
 * `chalybclip/integrations/chalyb/sso.py`. Wire-compatible byte for byte:
 *
 *   token = base64url(payload_json) + "." + base64url(HMAC-SHA256(payload_b64, secret))
 *
 * Payload claims (matches Chalyb's signLaunchToken in
 * `src/lib/engines/integrations/chalybclip.ts`):
 *
 *   { user_id, email, tenant_id, tier?, exp }
 *
 * Why custom format and not JWT: two-party trust relationship, we control
 * both ends, no header/algo agility needed. One HMAC each side, done.
 */

import { b64urlDecode, b64urlDecodeString } from "./b64url";

export interface SsoPayload {
  user_id: string;
  email: string;
  tenant_id: string;
  /** 'free' | 'pro' | 'all_access' — set when Chalyb minted with tier. */
  tier?: string;
  /** Unix seconds. */
  exp: number;
}

export class SsoTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SsoTokenError";
  }
}

/** Verify a token minted by Chalyb. Throws SsoTokenError on any failure
 *  — caller turns those into a single user-facing error page rather than
 *  telling an attacker *why* their forgery didn't work. */
export async function verifySsoToken(
  token: string,
  options: { secret: string; nowSeconds?: number; leewaySeconds?: number },
): Promise<SsoPayload> {
  const { secret, nowSeconds, leewaySeconds = 0 } = options;
  if (!secret) {
    throw new SsoTokenError(
      "CHALYBOBS_SSO_SECRET not configured on this ChalyOBS instance",
    );
  }
  if (!token) throw new SsoTokenError("empty token");

  const dotAt = token.indexOf(".");
  if (dotAt <= 0 || dotAt === token.length - 1) {
    throw new SsoTokenError("malformed token");
  }
  const payloadB64 = token.slice(0, dotAt);
  const sigB64 = token.slice(dotAt + 1);

  let claimedSig: Uint8Array<ArrayBuffer>;
  try {
    claimedSig = b64urlDecode(sigB64);
  } catch {
    throw new SsoTokenError("bad signature encoding");
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
  if (!valid) throw new SsoTokenError("bad signature");

  let raw: unknown;
  try {
    raw = JSON.parse(b64urlDecodeString(payloadB64));
  } catch {
    throw new SsoTokenError("bad payload encoding");
  }

  const payload = parsePayload(raw);
  const now = nowSeconds ?? Math.floor(Date.now() / 1000);
  if (payload.exp + leewaySeconds < now) {
    throw new SsoTokenError("token expired");
  }
  return payload;
}

function parsePayload(raw: unknown): SsoPayload {
  if (!raw || typeof raw !== "object") {
    throw new SsoTokenError("payload missing required fields");
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.user_id !== "string" || obj.user_id.length === 0) {
    throw new SsoTokenError("payload missing user_id");
  }
  if (typeof obj.email !== "string" || obj.email.length < 3) {
    throw new SsoTokenError("payload missing email");
  }
  if (typeof obj.tenant_id !== "string" || obj.tenant_id.length === 0) {
    throw new SsoTokenError("payload missing tenant_id");
  }
  if (typeof obj.exp !== "number" || obj.exp <= 0) {
    throw new SsoTokenError("payload missing exp");
  }
  const out: SsoPayload = {
    user_id: obj.user_id,
    email: obj.email,
    tenant_id: obj.tenant_id,
    exp: obj.exp,
  };
  if (typeof obj.tier === "string" && obj.tier.length > 0) {
    out.tier = obj.tier;
  }
  return out;
}
