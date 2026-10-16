/**
 * POST /api/internal/usage/drain
 *
 * Delivers pending rows of the usage outbox (stream.minutes events +
 * reservation settles) to the Chalyb hub, retrying failures with backoff.
 * live/authorize and live/ended already drain opportunistically; point a
 * Cloud Scheduler job here (e.g. every 5 min) so a row stuck behind a hub
 * outage is delivered even when nobody streams.
 *
 * Auth: Bearer <CHALYBOBS_RELAY_SECRET> or the engine admin token
 * (CHALYBOBS_ADMIN_TOKEN / CHALYB_ADMIN_TOKEN).
 *   200: { sent, retried, dead, skipped }  |  { skipped: "hub_not_configured" }
 */

import { NextRequest, NextResponse } from "next/server";
import { checkRelayBearer } from "@/lib/relay-auth";
import { checkAdminBearer } from "@/lib/admin-auth";
import { readChalybEnv } from "@/lib/env";
import { drainUsageOutbox } from "@/lib/usage/outbox";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const authorization = request.headers.get("authorization");
  if (!checkRelayBearer(authorization)) {
    const authErr = checkAdminBearer(authorization, readChalybEnv()?.adminToken);
    if (authErr) return authErr;
  }

  const stats = await drainUsageOutbox(100);
  if (!stats) {
    return NextResponse.json({ skipped: "hub_not_configured" });
  }
  return NextResponse.json(stats);
}
