/**
 * ChalyOBS env vars — Chalyb shared convention (CHALYB_*, CHALYBCLIP_*,
 * CHALYBCRYPTO_*, CHALYBOBS_*). No NEXT_PUBLIC_ prefix anywhere: every read
 * happens on the server (SSO route, middleware, admin endpoints).
 *
 * Defensive: when any required var is missing, getChalybEnv() returns null and
 * the affected surface degrades gracefully — the UI still renders, but
 * protected routes redirect to the login screen which surfaces the missing
 * env name so operators see it immediately on deploy.
 */

export interface ChalybEnv {
  /** HMAC-SHA256 secret shared with Chalyb. Must match the value Chalyb
   *  stores as `CHALYBOBS_SSO_SECRET` so signLaunchToken + verify line up. */
  ssoSecret: string;
  /** Bearer token Chalyb presents on POST /api/admin/* calls. */
  adminToken: string;
  /** Independent HMAC secret used to sign OUR session cookie. NOT shared
   *  with Chalyb — only ChalyOBS mints + verifies its own session. */
  sessionSecret: string;
  /** Absolute public URL of this ChalyOBS deploy. Used to construct
   *  return_to on the login redirect. */
  publicUrl: string;
  /** Where to send unauthenticated visitors. Shared variable in Vercel
   *  (`CHALYB_LOGIN_URL`) so every Chalyb engine points at the same login. */
  chalybLoginUrl: string;
}

/**
 * The hub's convention (chalyb/.env.local.example) is that every engine reads
 * CHALYB_SSO_SECRET / CHALYB_ADMIN_TOKEN, while the hub itself holds one
 * <SLUG>_SSO_SECRET / <SLUG>_ADMIN_TOKEN pair per engine. Accept both spellings
 * so ChalyOBS works with the same Vercel variables as the other engines;
 * the engine-specific CHALYBOBS_* name wins when both are set.
 */
function ssoSecretEnv(): string | undefined {
  return process.env.CHALYBOBS_SSO_SECRET || process.env.CHALYB_SSO_SECRET;
}
function adminTokenEnv(): string | undefined {
  return process.env.CHALYBOBS_ADMIN_TOKEN || process.env.CHALYB_ADMIN_TOKEN;
}
function sessionSecretEnv(): string | undefined {
  return (
    process.env.CHALYBOBS_SESSION_SECRET || process.env.CHALYB_SESSION_SECRET
  );
}

export function readChalybEnv(): ChalybEnv | null {
  const ssoSecret = ssoSecretEnv();
  const adminToken = adminTokenEnv();
  const sessionSecret = sessionSecretEnv();
  // On Cloud Run the hub's Terraform injects PUBLIC_URL=https://<slug>.<domain>
  // for every engine; CHALYBOBS_PUBLIC_URL overrides it when set.
  const publicUrl =
    process.env.CHALYBOBS_PUBLIC_URL ||
    process.env.PUBLIC_URL ||
    "http://localhost:3000";
  const chalybLoginUrl =
    process.env.CHALYB_LOGIN_URL ?? "https://chalyb.com/login";

  if (!ssoSecret || !adminToken || !sessionSecret) return null;
  return { ssoSecret, adminToken, sessionSecret, publicUrl, chalybLoginUrl };
}

/**
 * Resolve the public-facing origin (scheme + host) for building absolute
 * redirect URLs. Behind a proxy, `request.url` is the internal bind
 * address (http://localhost:8080), so naive `url.origin` redirects send the
 * browser to localhost. Priority:
 *   1. CHALYBOBS_PUBLIC_URL, else PUBLIC_URL (Cloud Run, from the hub's Terraform)
 *   2. x-forwarded-proto + x-forwarded-host (proxy-injected)
 *   3. the request's own origin (local dev fallback)
 */
export function resolvePublicOrigin(request: Request): string {
  const fromEnv = process.env.CHALYBOBS_PUBLIC_URL || process.env.PUBLIC_URL;
  if (fromEnv) return fromEnv.replace(/\/$/, "");

  const proto = request.headers.get("x-forwarded-proto");
  const host = request.headers.get("x-forwarded-host");
  if (proto && host) return `${proto}://${host}`;

  return new URL(request.url).origin;
}

/**
 * Shared bearer the chalybclip-live relay presents on the internal live
 * webhooks (/api/internal/live/*). Must equal the relay's
 * CHALYBCLIP_INTERNAL_SIGNING_SECRET. Separate from the SSO/admin secrets —
 * this is the ChalyOBS ↔ relay trust boundary.
 */
export function readRelaySecret(): string | null {
  return process.env.CHALYBOBS_RELAY_SECRET ?? null;
}

/** List the env vars that are missing — used by the login page to tell
 *  operators exactly what to set in Vercel. Returns [] when all present. */
export function missingChalybEnvVars(): string[] {
  const missing: string[] = [];
  if (!ssoSecretEnv()) missing.push("CHALYBOBS_SSO_SECRET (o CHALYB_SSO_SECRET)");
  if (!adminTokenEnv()) missing.push("CHALYBOBS_ADMIN_TOKEN (o CHALYB_ADMIN_TOKEN)");
  if (!sessionSecretEnv())
    missing.push("CHALYBOBS_SESSION_SECRET (o CHALYB_SESSION_SECRET)");
  return missing;
}
