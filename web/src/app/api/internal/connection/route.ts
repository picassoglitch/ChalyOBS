/**
 * ChalybClip connection state — the shared, bidirectional switch.
 *
 *   GET  /api/internal/connection?tenant=<chalyb_user_id>  → { enabled }
 *   POST /api/internal/connection  { tenant, enabled }      → { enabled }
 *
 * Source of truth is ChalybOBS's chalybobs_sessions.clips_enabled. The ChalybOBS
 * header switch toggles it directly; ChalybClip's Live-page switch reads/writes
 * it through this endpoint — so flipping it on either side updates the same
 * connection. Bearer-authed with CHALYBOBS_RELAY_SECRET (shared internal trust).
 *
 * Full-access gating is enforced by each app's UI before calling; this
 * internal endpoint trusts the bearer.
 */

import { NextRequest, NextResponse } from "next/server";
import { checkRelayBearer } from "@/lib/relay-auth";
import { getClipsEnabled, setClipsEnabled } from "@/lib/data";

export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!checkRelayBearer(request.headers.get("authorization"))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const tenant = request.nextUrl.searchParams.get("tenant");
  if (!tenant) {
    return NextResponse.json({ error: "missing_tenant" }, { status: 400 });
  }
  const enabled = await getClipsEnabled(tenant);
  return NextResponse.json({ enabled });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!checkRelayBearer(request.headers.get("authorization"))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  let body: { tenant?: string; enabled?: boolean };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (!body.tenant || typeof body.enabled !== "boolean") {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }
  await setClipsEnabled(body.tenant, body.enabled);
  return NextResponse.json({ enabled: body.enabled });
}
