import type { SupabaseClient } from "@supabase/supabase-js";

// Update only: provisioning carries no screen language, so creating the row here
// fixed its default title in Spanish (2026-11-07). Logged, never thrown: it can't block login.
export async function writeTenantTier(
  db: () => SupabaseClient,
  tenantId: string,
  tier: string | null,
): Promise<void> {
  try {
    const { error } = await db()
      .from("chalybobs_sessions")
      .update({ tier, tier_updated_at: new Date().toISOString() })
      .eq("tenant_id", tenantId);
    if (error) console.error(`[tier] save failed: ${error.message}`);
  } catch (e) {
    console.error(`[tier] save failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}
