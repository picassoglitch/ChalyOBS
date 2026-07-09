/**
 * GET /api/oauth/[platform]/callback?code=…&state=…   (kick | twitch | youtube)
 *
 * Second leg of the auto-connect, shared by every OAuth platform. Verifies
 * the CSRF state against the cookie set by /start, exchanges the code for
 * tokens, then asks the provider for the channel's connection data — handle,
 * ingest URL AND stream key — and upserts the tenant's destination fully
 * configured. That fetch is the whole point: the user never copies a stream
 * key again.
 *
 * Every failure lands back on /dashboard?connect_error=… so the UI can
 * explain instead of stranding the user on a JSON error.
 */

import { NextRequest, NextResponse } from "next/server";
import { resolvePublicOrigin } from "@/lib/env";
import { getServerSession } from "@/lib/server-session";
import { connectOAuthDestination } from "@/lib/data";
import { oauthCookieName, parseOAuthCookie } from "@/lib/oauth/flow";
import { getOAuthProvider } from "@/lib/oauth/providers";

export async function GET(
  request: NextRequest,
  ctx: RouteContext<"/api/oauth/[platform]/callback">,
): Promise<NextResponse> {
  const { platform } = await ctx.params;
  const origin = resolvePublicOrigin(request);
  const dashboard = new URL("/dashboard", origin);
  const cookieName = oauthCookieName(platform);

  const finish = (param: "connected" | "connect_error", value: string) => {
    dashboard.searchParams.set(param, value);
    const res = NextResponse.redirect(dashboard, { status: 303 });
    res.cookies.delete(cookieName); // one-shot, never reusable
    return res;
  };

  const session = await getServerSession();
  if (!session) {
    return NextResponse.redirect(new URL("/login?next=/dashboard", origin), {
      status: 303,
    });
  }

  const provider = getOAuthProvider(platform);
  if (!provider) return finish("connect_error", "unknown_platform");
  if (!provider.isConfigured()) {
    return finish("connect_error", `${platform}_not_configured`);
  }

  const url = new URL(request.url);
  // User hit "Cancel" on the consent page (or the platform reported an error).
  if (url.searchParams.get("error")) {
    return finish("connect_error", `${platform}_denied`);
  }

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const cookie = parseOAuthCookie(request.cookies.get(cookieName)?.value ?? "");
  const stateOk =
    code && state && cookie && cookie.state === state &&
    // PKCE platforms must round-trip the verifier too.
    (!provider.usesPkce || typeof cookie.verifier === "string");
  if (!stateOk) {
    return finish("connect_error", `${platform}_state_mismatch`);
  }

  try {
    const tokens = await provider.exchangeCode({
      code,
      codeVerifier: cookie.verifier,
      redirectUri: `${origin}/api/oauth/${provider.platformId}/callback`,
    });
    const connection = await provider.fetchConnection(tokens.accessToken);
    await connectOAuthDestination(session.tenant_id, provider.platformId, {
      ...connection,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
      scopes: tokens.scopes,
    });
  } catch {
    return finish("connect_error", `${platform}_exchange_failed`);
  }

  return finish("connected", platform);
}
