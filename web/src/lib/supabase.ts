import "server-only";
import { createClient, SupabaseClient } from "@supabase/supabase-js";

/**
 * Server-only Supabase admin client for the shared Chalyb project.
 *
 * Uses the new-format SECRET key (sb_secret_...), which replaces the legacy
 * `service_role` JWT. It bypasses RLS, so EVERY query in this app MUST filter
 * by tenant_id (sourced from the verified session cookie). The key never
 * reaches the browser — all data access goes through Server Components /
 * Server Actions / route handlers.
 *
 * Env: CHALYBOBS_SUPABASE_SECRET_KEY (new format). Falls back to the legacy
 * CHALYBOBS_SUPABASE_SERVICE_ROLE_KEY name so either value works during the
 * migration window. The publishable key (sb_publishable_...) is NOT used —
 * we need elevated writes to the chalybobs_* tables.
 */

function secretKey(): string | undefined {
  return (
    process.env.CHALYBOBS_SUPABASE_SECRET_KEY ??
    process.env.CHALYBOBS_SUPABASE_SERVICE_ROLE_KEY
  );
}

let cached: SupabaseClient | null = null;

export function getSupabaseAdmin(): SupabaseClient {
  if (cached) return cached;
  const url = process.env.CHALYBOBS_SUPABASE_URL;
  const key = secretKey();
  if (!url || !key) {
    throw new Error(
      "Supabase not configured — set CHALYBOBS_SUPABASE_URL + CHALYBOBS_SUPABASE_SECRET_KEY",
    );
  }
  cached = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cached;
}

export function isSupabaseConfigured(): boolean {
  return Boolean(process.env.CHALYBOBS_SUPABASE_URL && secretKey());
}
