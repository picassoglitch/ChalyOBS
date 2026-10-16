/**
 * Where the Chalyb hub lives, for redirects that must land in the hub (the
 * OAuth hand-back and the "user pages moved to the hub" redirect). Read from
 * env ONLY — never from the request, so neither can become an open redirect.
 * Same resolution the login page uses for the hub's launcher.
 */
export function resolveHubBase(
  env: Record<string, string | undefined> = process.env,
): string {
  const explicit = env.CHALYB_BASE_URL?.trim();
  const raw = explicit || env.CHALYB_LOGIN_URL?.trim() || "https://chalyb.com/login";
  try {
    return new URL(raw).origin;
  } catch {
    return "https://chalyb.com";
  }
}

/**
 * OAuth callback hand-back. A connect started from the hub carries a state
 * that begins with "hub." (the hub generated it and holds it in its own
 * httpOnly cookie, with the PKCE verifier). The platform can only call back
 * the URI registered for this engine, so the engine bounces the browser to
 * the hub's callback with the same code/state/error; the hub checks the state
 * against its cookie and then completes the exchange server-to-server for the
 * hub session's own tenant (POST /api/hub/v1/oauth/<p>/complete). Binding to
 * the hub session is what stops a link from someone else's connect from
 * attaching a channel to the wrong account.
 *
 * Returns null when the callback is not a hub one (the engine's own flow
 * continues unchanged).
 */
export function hubOAuthForwardUrl(
  platform: string,
  params: URLSearchParams,
  hubBase: string,
): URL | null {
  const state = params.get("state");
  if (!state || !state.startsWith("hub.")) return null;
  const to = new URL("/api/tools/chalybobs/oauth/callback", hubBase);
  to.searchParams.set("platform", platform);
  for (const key of ["code", "state", "error"] as const) {
    const v = params.get(key);
    if (v !== null) to.searchParams.set(key, v);
  }
  return to;
}

/**
 * User pages that moved into the hub (CHALYBOBS_REDIRECT_TO_HUB=1). Only
 * these paths; APIs, /auth/*, /oauth/* and static files are never touched.
 */
export function hubPageRedirect(
  pathname: string,
  env: Record<string, string | undefined> = process.env,
): string | null {
  if (env.CHALYBOBS_REDIRECT_TO_HUB !== "1") return null;
  const under = (p: string) => pathname === p || pathname.startsWith(`${p}/`);
  let target: string | null = null;
  if (pathname === "/" || under("/dashboard") || under("/login")) target = "/app/en-vivo";
  else if (under("/settings")) target = "/app/en-vivo/ajustes";
  else if (under("/analytics")) target = "/app/en-vivo/transmisiones";
  if (!target) return null;
  return new URL(target, resolveHubBase(env)).toString();
}
