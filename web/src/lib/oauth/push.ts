import "server-only";
import { BroadcastMeta } from "../destinations";
import {
  getOAuthConnections,
  markDestinationStatus,
  OAuthTokenRow,
  saveOAuthTokens,
} from "../data";
import { OAuthFlowError, OAuthProvider } from "./flow";
import { getOAuthProvider } from "./providers";

/**
 * Push composer metadata to every OAuth-connected platform of a tenant.
 * Called after publishBroadcastMeta persisted the canonical copy — this is
 * strictly best-effort: a platform API being down must never fail the save,
 * so each platform is caught independently and failures only surface as the
 * row's status banner. Platforms without a pushMeta (YouTube: metadata is
 * per-broadcast) are skipped.
 */
export async function pushBroadcastToConnectedPlatforms(
  tenantId: string,
  meta: BroadcastMeta,
): Promise<void> {
  const connections = await getOAuthConnections(tenantId);
  await Promise.allSettled(
    connections.map(async (conn) => {
      const provider = getOAuthProvider(conn.platformId);
      if (!provider?.pushMeta || !provider.isConfigured()) return;
      const token = await ensureFreshToken(tenantId, provider, conn);
      if (!token) return;
      try {
        await provider.pushMeta(token, meta);
      } catch (e) {
        // A rejected token outside the expiry window (revoked on the
        // platform's side) also needs the Reconnect banner.
        if (
          e instanceof OAuthFlowError &&
          (e.status === 401 || e.status === 403)
        ) {
          await markDestinationStatus(tenantId, conn.id, "expired");
        }
      }
    }),
  );
}

/** Reuse the access token while >60s of life remains, otherwise refresh and
 *  persist the (possibly rotated) pair. A failed refresh marks the row
 *  expired — the UI then shows the Reconnect banner. */
export async function ensureFreshToken(
  tenantId: string,
  provider: OAuthProvider,
  conn: OAuthTokenRow,
): Promise<string | null> {
  if (!conn.refreshToken) return null;
  const expiresAt = conn.expiresAt ? Date.parse(conn.expiresAt) : 0;
  if (expiresAt - Date.now() > 60_000) return conn.accessToken;
  try {
    const tokens = await provider.refreshTokens(conn.refreshToken);
    await saveOAuthTokens(tenantId, conn.id, tokens);
    return tokens.accessToken;
  } catch {
    await markDestinationStatus(tenantId, conn.id, "expired");
    return null;
  }
}
