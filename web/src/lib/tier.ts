/**
 * Single source of truth for "does this tier unlock full-access features?"
 *
 * Chalyb's documented schema has four tiers (FREE | PRO | PARTNER |
 * ALL_ACCESS — see src/backend/types.ts), but production SSO tokens also mint
 * "vip" as the top/full-access tier. ALL_ACCESS, PARTNER and VIP all grant
 * full access: PARTNER is a comped/relationship tier and VIP is the live
 * top-tier label, both get everything.
 *
 * Tier strings arrive from the SSO token and can vary in case, so compare
 * case-insensitively. The UI gate (dashboard page) and the server-side
 * enforcement (setClipsEnabledAction) MUST both route through this so they
 * can never drift apart.
 */

const FULL_ACCESS_TIERS = new Set(["all_access", "partner", "vip"]);

export function isFullAccessTier(tier: string | null | undefined): boolean {
  return FULL_ACCESS_TIERS.has((tier ?? "").trim().toLowerCase());
}
