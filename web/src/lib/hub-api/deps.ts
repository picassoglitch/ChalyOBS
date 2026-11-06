import "server-only";
import {
  addDestination,
  connectOAuthDestination,
  getDestinations,
  getOrCreateSession,
  getStoredTier,
  getStreamKey,
  listStreams,
  publishBroadcastMeta,
  regenerateStreamKey,
  removeDestination,
  saveTenantTier,
  toggleDestination,
  updateDestination,
  updateSession,
} from "@/lib/data";
import { isSupabaseConfigured } from "@/lib/supabase";
import { getOAuthProvider, oauthAvailability } from "@/lib/oauth/providers";
import { pushBroadcastToConnectedPlatforms } from "@/lib/oauth/push";
import type { HubApiDeps } from "./handlers";

/** The real dependencies of the hub API: the same data layer, OAuth
 *  providers and metadata push the dashboard's server actions use. */
export function realHubApiDeps(publicOrigin: string): HubApiDeps {
  return {
    ssoSecret: process.env.CHALYBOBS_SSO_SECRET || process.env.CHALYB_SSO_SECRET,
    dbConfigured: isSupabaseConfigured(),
    relayRtmpUrl: process.env.CHALYBOBS_RELAY_RTMP_URL ?? "rtmp://ingest.chalyb.com/live",
    relayInternalHls: process.env.CHALYBOBS_RELAY_INTERNAL_HLS,
    publicOrigin,
    getOrCreateSession,
    getStoredTier,
    saveTenantTier,
    updateSession,
    getStreamKey,
    regenerateStreamKey,
    getDestinations,
    addDestination,
    updateDestination,
    toggleDestination,
    removeDestination,
    publishBroadcastMeta,
    pushBroadcastToConnectedPlatforms,
    listStreams,
    getOAuthProvider,
    oauthAvailability,
    connectOAuthDestination,
  };
}
