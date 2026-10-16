/**
 * Bearer auth for the hub's server-to-server API (/api/hub/v1/*).
 *
 * The hub (www.chalyb.com) mints the same HMAC token it uses for the SSO
 * launch (see sso.ts), signed with CHALYBOBS_SSO_SECRET, plus an `aud` claim:
 *
 *   chalybobs-hub-api      every endpoint except the preview; ~120 s TTL,
 *                          minted per request, never leaves the hub server.
 *   chalybobs-hub-preview  ONLY GET /preview/*; ~30 min TTL, rides in the
 *                          browser's hub preview URL. It can read nothing
 *                          but the tenant's own HLS preview.
 *
 * A launch token (no aud, it travels in browser URLs) is never accepted
 * here, and an API token can't be swapped for a preview one or vice versa.
 * The tenant comes only from the verified token.
 */

import { type SsoPayload, verifySsoToken } from "../sso.ts";

export const HUB_API_AUD = "chalybobs-hub-api";
export const HUB_PREVIEW_AUD = "chalybobs-hub-preview";
export type HubAud = typeof HUB_API_AUD | typeof HUB_PREVIEW_AUD;

/** Longest lifetime the engine accepts per audience (exp - now). A token
 *  minted with a longer exp is refused even with a valid signature, so a
 *  leaked preview URL or a mis-minted API token can't live for days. */
export const MAX_TTL_SECONDS: Record<HubAud, number> = {
  [HUB_API_AUD]: 600,
  [HUB_PREVIEW_AUD]: 3600,
};

export type HubClaims = SsoPayload & { aud: HubAud };

export async function verifyHubBearer(
  authorization: string | null | undefined,
  opts: { secret: string | null | undefined; aud: HubAud; nowSeconds?: number },
): Promise<HubClaims | null> {
  if (!opts.secret) return null;
  const header = (authorization ?? "").trim();
  if (!/^bearer\s+/i.test(header)) return null;
  const token = header.replace(/^bearer\s+/i, "").trim();
  if (!token) return null;

  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  let payload: SsoPayload;
  try {
    payload = await verifySsoToken(token, { secret: opts.secret, nowSeconds: now });
  } catch {
    return null;
  }
  if (payload.aud !== opts.aud) return null;
  if (payload.exp - now > MAX_TTL_SECONDS[opts.aud]) return null;
  return { ...payload, aud: opts.aud };
}
