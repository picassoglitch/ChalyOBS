/**
 * Constant-time bearer-token check for admin endpoints. The bearer is
 * `CHALYBOBS_ADMIN_TOKEN`, shared with Chalyb (it stores the same value as
 * `CHALYBOBS_ADMIN_TOKEN` on its side).
 *
 * Returns `null` on success, or a NextResponse with the right status if
 * the check fails so the caller can `return result ?? actual();`.
 */

import { NextResponse } from "next/server";

export function checkAdminBearer(
  authorization: string | null | undefined,
  expectedToken: string | null | undefined,
): NextResponse | null {
  if (!expectedToken) {
    return NextResponse.json(
      { error: "chalybobs_admin_token_not_configured" },
      { status: 503 },
    );
  }
  if (!authorization || !/^bearer\s+/i.test(authorization)) {
    return NextResponse.json(
      { error: "missing_bearer" },
      { status: 401, headers: { "WWW-Authenticate": "Bearer" } },
    );
  }
  const presented = authorization.replace(/^bearer\s+/i, "").trim();
  if (!constantTimeEqual(presented, expectedToken)) {
    return NextResponse.json({ error: "invalid_admin_token" }, { status: 403 });
  }
  return null;
}

/** Constant-time string compare so a wrong token leaks no timing info. */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
