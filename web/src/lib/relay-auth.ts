import "server-only";
import { readRelaySecret } from "./env";

/**
 * Constant-time bearer check for the internal live webhooks the relay
 * (chalybclip-live MediaMTX hooks) calls. Returns true if the presented
 * Authorization header matches CHALYBOBS_RELAY_SECRET.
 */
export function checkRelayBearer(authorization: string | null): boolean {
  const expected = readRelaySecret();
  if (!expected) return false;
  if (!authorization || !/^bearer\s+/i.test(authorization)) return false;
  const presented = authorization.replace(/^bearer\s+/i, "").trim();
  if (presented.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < presented.length; i++) {
    diff |= presented.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}
