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
 * Env — the engine-specific names win, then the names the other Chalyb
 * engines already use on Vercel (hub: NEXT_PUBLIC_SUPABASE_URL +
 * SUPABASE_SERVICE_ROLE_KEY; ChalyCrypto: SUPABASE_URL +
 * SUPABASE_SERVICE_ROLE_KEY), so one shared set of vars configures every
 * engine. Either the new-format secret key (sb_secret_...) or the legacy
 * service_role JWT works. The publishable/anon key is NOT accepted — we need
 * elevated writes to the chalybobs_* tables.
 */

export const SUPABASE_URL_ENV_NAMES = [
  "CHALYBOBS_SUPABASE_URL",
  "SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_URL",
] as const;

export const SUPABASE_SECRET_ENV_NAMES = [
  "CHALYBOBS_SUPABASE_SECRET_KEY",
  "CHALYBOBS_SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_SECRET_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
] as const;

function firstEnv(names: readonly string[]): string | undefined {
  for (const name of names) {
    const v = process.env[name];
    if (v) return v;
  }
  return undefined;
}

function supabaseUrl(): string | undefined {
  return firstEnv(SUPABASE_URL_ENV_NAMES);
}

function secretKey(): string | undefined {
  return firstEnv(SUPABASE_SECRET_ENV_NAMES);
}

let cached: SupabaseClient | null = null;

export function getSupabaseAdmin(): SupabaseClient {
  if (cached) return cached;
  const url = supabaseUrl();
  const key = secretKey();
  if (!url || !key) {
    throw new Error(
      "Supabase not configured — set CHALYBOBS_SUPABASE_URL (or SUPABASE_URL / NEXT_PUBLIC_SUPABASE_URL) + CHALYBOBS_SUPABASE_SECRET_KEY (or SUPABASE_SERVICE_ROLE_KEY)",
    );
  }
  cached = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cached;
}

export function isSupabaseConfigured(): boolean {
  return Boolean(supabaseUrl() && secretKey());
}
