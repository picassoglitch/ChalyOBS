/**
 * POST /api/admin/tenants
 *
 * Idempotent tenant provisioning called by Chalyb's `chalybobs.ts` integration
 * (mirror of how it calls ChalyClip). Auth: shared bearer
 * CHALYBOBS_ADMIN_TOKEN.
 *
 * Phase 0: no DB. We return a deterministic `tenant_id` (= external_user_id
 * from Chalyb, which is its supabase user_id) and a deterministic
 * `api_token` (HMAC of user_id with our session secret). This is enough for
 * Chalyb's engine_subscriptions row to land — every re-call returns the
 * same pair, so the 409-vs-201 behavior collapses to a single 200.
 *
 * When ChalyOBS gets a real DB (Postgres, alongside destinations
 * + OAuth tokens), swap the stub block for actual upsert + first-time vs
 * duplicate detection.
 */

import { NextRequest, NextResponse } from "next/server";
import { checkAdminBearer } from "@/lib/admin-auth";
import { b64urlEncode } from "@/lib/b64url";
import { readChalybEnv } from "@/lib/env";

interface ProvisionRequest {
  external_user_id?: string;
  email?: string;
  display_name?: string | null;
  tier?: string | null;
}

interface ProvisionResponse {
  tenant_id: string;
  api_token: string;
  /** Set to "duplicate" on the second-onward call. Phase 0 stub always
   *  computes the same pair so we omit the field — Chalyb treats absence
   *  as "new" but doesn't reject either way. */
  error?: string;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const env = readChalybEnv();
  const authErr = checkAdminBearer(
    request.headers.get("authorization"),
    env?.adminToken,
  );
  if (authErr) return authErr;
  if (!env) {
    return NextResponse.json(
      { error: "service_not_configured" },
      { status: 503 },
    );
  }

  let body: ProvisionRequest;
  try {
    body = (await request.json()) as ProvisionRequest;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  if (!body.external_user_id || !body.email) {
    return NextResponse.json(
      { error: "missing_required_fields" },
      { status: 400 },
    );
  }

  const tenant_id = body.external_user_id;
  const api_token = await deriveApiToken(tenant_id, env.sessionSecret);

  const response: ProvisionResponse = { tenant_id, api_token };
  return NextResponse.json(response, { status: 200 });
}

/** Derive a stable api_token from the tenant_id without storing it.
 *  Deterministic so re-provisioning returns the same value — Chalyb's
 *  engine_subscriptions row stays consistent across redeploys. */
async function deriveApiToken(
  tenantId: string,
  secret: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`api_token:${tenantId}`),
  );
  return `nob_${b64urlEncode(new Uint8Array(sig))}`;
}
