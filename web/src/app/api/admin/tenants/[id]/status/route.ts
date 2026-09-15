/**
 * POST /api/admin/tenants/:id/status   { status: 'active' | 'paused' | 'cancelled' }
 *
 * Pause / resume / cancel a tenant remotely. Called by Chalyb when a user's
 * tier changes (PRO → free, etc.). Auth: shared bearer CHALYBOBS_ADMIN_TOKEN.
 *
 * Phase 0 stub: no DB, no enforcement. Returns 204 so Chalyb's
 * engine_subscriptions reconciliation passes. When ChalybOBS has destinations
 * persisted, this becomes a real "stop streaming + freeze OAuth tokens"
 * mutation on the tenant row.
 */

import { NextRequest, NextResponse } from "next/server";
import { checkAdminBearer } from "@/lib/admin-auth";
import { readChalybEnv } from "@/lib/env";

const VALID_STATUSES = new Set(["active", "paused", "cancelled"]);

interface StatusRequest {
  status?: string;
}

export async function POST(
  request: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const env = readChalybEnv();
  const authErr = checkAdminBearer(
    request.headers.get("authorization"),
    env?.adminToken,
  );
  if (authErr) return authErr;

  const { id } = await ctx.params;
  if (!id) {
    return NextResponse.json({ error: "missing_tenant_id" }, { status: 400 });
  }

  let body: StatusRequest;
  try {
    body = (await request.json()) as StatusRequest;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (!body.status || !VALID_STATUSES.has(body.status)) {
    return NextResponse.json(
      { error: "invalid_status", expected: [...VALID_STATUSES] },
      { status: 400 },
    );
  }

  // Phase 0: accept and acknowledge. No state to mutate yet.
  // Real impl: UPDATE tenants SET status = $1 WHERE tenant_id = $2 returning *.
  return new NextResponse(null, { status: 204 });
}
