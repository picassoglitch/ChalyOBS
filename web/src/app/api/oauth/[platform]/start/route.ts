/**
 * GET /api/oauth/[platform]/start   (kick | twitch | youtube)
 *
 * First leg of the Restream-style auto-connect, shared by every OAuth
 * platform: mint CSRF state (+ PKCE verifier when the platform requires it),
 * stash them in a short-lived httpOnly per-platform cookie, and 303 the
 * browser to the platform's consent page. The user lands back on
 * /api/oauth/[platform]/callback, which completes the connection.
 *
 * How each platform connects is the provider's business (see
 * lib/oauth/providers.ts) — this route only orchestrates.
 *
 * Full-page navigation by design (the dashboard links here, it does not
 * fetch) — OAuth consent can't happen over XHR.
 */

import { NextRequest, NextResponse } from "next/server";
import { resolvePublicOrigin } from "@/lib/env";
import { getServerSession } from "@/lib/server-session";
import {
  encodeOAuthCookie,
  generateOAuthState,
  generatePkceVerifier,
  OAUTH_COOKIE_TTL_SECONDS,
  oauthCookieName,
  pkceChallengeS256,
} from "@/lib/oauth/flow";
import { getOAuthProvider } from "@/lib/oauth/providers";

export async function GET(
  request: NextRequest,
  ctx: RouteContext<"/api/oauth/[platform]/start">,
): Promise<NextResponse> {
  const { platform } = await ctx.params;
  const origin = resolvePublicOrigin(request);

  const backWithError = (code: string) => {
    const back = new URL("/dashboard", origin);
    back.searchParams.set("connect_error", code);
    return NextResponse.redirect(back, { status: 303 });
  };

  const session = await getServerSession();
  if (!session) {
    return NextResponse.redirect(new URL("/login?next=/dashboard", origin), {
      status: 303,
    });
  }

  const provider = getOAuthProvider(platform);
  if (!provider) return backWithError("unknown_platform");
  if (!provider.isConfigured()) {
    // Platform app credentials not set in this deploy — bounce back with a
    // diagnosable error instead of a 500. (The UI hides Connect in this
    // case, so reaching here means a hand-typed URL.)
    return backWithError(`${platform}_not_configured`);
  }

  const state = generateOAuthState();
  const verifier = provider.usesPkce ? generatePkceVerifier() : undefined;
  const codeChallenge = verifier ? await pkceChallengeS256(verifier) : undefined;

  const authorizeUrl = provider.buildAuthorizeUrl({
    redirectUri: `${origin}/api/oauth/${provider.platformId}/callback`,
    state,
    codeChallenge,
  });

  const response = NextResponse.redirect(authorizeUrl, { status: 303 });
  response.cookies.set({
    name: oauthCookieName(provider.platformId),
    value: encodeOAuthCookie({ state, verifier }),
    httpOnly: true,
    sameSite: "lax",
    secure: origin.startsWith("https:"),
    path: "/",
    maxAge: OAUTH_COOKIE_TTL_SECONDS,
  });
  return response;
}
