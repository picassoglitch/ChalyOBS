/**
 * GET /api/me — viewer self-inspection.
 *
 * Returns the current session's identity + resolved access level, read from
 * the verified chalybobs_session cookie. No secrets, no other tenants — just
 * "who am I and does the app think I'm full access". Handy for diagnosing the
 * ChalybClip switch being greyed out: it shows the exact `tier` value the SSO
 * handoff delivered.
 */

import { NextResponse } from "next/server";
import { getServerSession } from "@/lib/server-session";
import { isFullAccessTier } from "@/lib/tier";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const session = await getServerSession();
  if (!session) {
    return NextResponse.json({ authenticated: false }, { status: 401 });
  }
  return NextResponse.json({
    authenticated: true,
    email: session.email,
    tenant_id: session.tenant_id,
    // The raw tier claim as delivered by Chalyb's SSO token. `null` here means
    // the token carried no tier at all → that's why full access is off.
    tier: session.tier ?? null,
    isFullAccess: isFullAccessTier(session.tier),
  });
}
