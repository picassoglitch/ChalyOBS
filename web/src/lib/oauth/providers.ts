import "server-only";
import { PlatformId } from "../destinations";
import { OAuthProvider } from "./flow";
import { kickProvider } from "./kick";
import { twitchProvider } from "./twitch";
import { youtubeProvider } from "./youtube";

/**
 * Registry of platforms with an OAuth auto-connect flow. The dynamic
 * /api/oauth/[platform]/* routes, the metadata push, and the dashboard's
 * availability gating all resolve through here — adding a platform is one
 * provider file + one line below (+ its OAUTH_CONNECT_PATH entry for the UI).
 *
 * Platforms NOT here connect their own way by design: Facebook/TikTok/
 * Restream take a manually pasted key (each with platform-specific guidance
 * in the edit modal), Instagram doesn't support external RTMP at all, and
 * custom RTMP/SRT are manual by definition.
 */
const PROVIDERS: Partial<Record<PlatformId, OAuthProvider>> = {
  kick: kickProvider,
  twitch: twitchProvider,
  youtube: youtubeProvider,
};

export function getOAuthProvider(
  platformId: string,
): OAuthProvider | null {
  return PROVIDERS[platformId as PlatformId] ?? null;
}

/** Which OAuth platforms this deploy can actually connect (credentials
 *  present). Drives the dashboard UI: unavailable platforms silently fall
 *  back to manual entry instead of dead-ending the tenant on an error. */
export function oauthAvailability(): Partial<Record<PlatformId, boolean>> {
  const out: Partial<Record<PlatformId, boolean>> = {};
  for (const [id, provider] of Object.entries(PROVIDERS)) {
    out[id as PlatformId] = provider.isConfigured();
  }
  return out;
}
