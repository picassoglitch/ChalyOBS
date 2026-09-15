import { NextRequest, NextResponse } from "next/server";
import { readChalybEnv } from "@/lib/env";
import { SESSION_COOKIE_NAME, verifySession } from "@/lib/session";

/**
 * Edge-runtime middleware. ChalyOBS is an agent of Chalyb — it only
 * works for users signed in through Chalyb. Every protected route requires
 * a valid ChalyOBS session cookie (minted by /auth/sso after Chalyb SSO).
 *
 * FAIL CLOSED: no session, bad/expired cookie, OR missing server secrets all
 * redirect to /login (which bounces to Chalyb). There is no
 * unauthenticated bypass — a misconfigured deploy locks users out rather
 * than exposing the app.
 */

const PROTECTED_PREFIXES = ["/dashboard", "/settings", "/analytics"];

export async function middleware(request: NextRequest): Promise<NextResponse> {
  const pathname = request.nextUrl.pathname;
  const isProtected = PROTECTED_PREFIXES.some((p) => pathname.startsWith(p));
  if (!isProtected) return NextResponse.next();

  const redirectToLogin = (clearCookie: boolean): NextResponse => {
    const login = request.nextUrl.clone();
    login.pathname = "/login";
    login.searchParams.set("next", pathname);
    const response = NextResponse.redirect(login);
    if (clearCookie) response.cookies.delete(SESSION_COOKIE_NAME);
    return response;
  };

  const env = readChalybEnv();
  // No secrets configured → we can't verify any session → fail closed.
  if (!env) return redirectToLogin(false);

  const cookie = request.cookies.get(SESSION_COOKIE_NAME);
  if (cookie?.value) {
    try {
      await verifySession(cookie.value, env.sessionSecret);
      return NextResponse.next();
    } catch {
      // bad/expired cookie → fail closed (and clear it).
      return redirectToLogin(true);
    }
  }

  return redirectToLogin(false);
}

export const config = {
  matcher: [
    /*
     * Run on every request except:
     *   - /api/admin/*    — admin bearer, NOT session
     *   - /api/internal/* — relay bearer, NOT session
     *   - Next.js internals
     *   - static assets
     */
    "/((?!api/admin|api/internal|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
