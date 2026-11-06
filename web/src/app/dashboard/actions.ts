"use server";

import { revalidatePath } from "next/cache";
import { getServerSession } from "@/lib/server-session";
import {
  BroadcastMeta,
  normalizeBroadcastMeta,
  PLATFORM_META,
  PlatformId,
} from "@/lib/destinations";
import { isAllowedIngestUrl } from "@/lib/push-url";
import { isFullAccessTier } from "@/lib/tier";
import { pushBroadcastToConnectedPlatforms } from "@/lib/oauth/push";
import {
  addDestination,
  publishBroadcastMeta,
  regenerateStreamKey,
  removeDestination,
  setSessionTitle,
  toggleDestination,
  updateDestination,
  updateSession,
} from "@/lib/data";

/** Every action re-reads the tenant from the verified session cookie —
 *  the client can never spoof a tenant_id. */
async function requireTenant(): Promise<string> {
  const session = await getServerSession();
  if (!session) throw new Error("unauthorized");
  return session.tenant_id;
}

/** Server actions are public POST endpoints: the TypeScript types on their
 *  parameters are not enforced at runtime, so re-check what arrives. */
function requireString(value: unknown, field: string, max = 2000): string {
  if (typeof value !== "string" || value.length > max) {
    throw new Error(`invalid ${field}`);
  }
  return value;
}

export async function setTitleAction(title: string): Promise<void> {
  const tenant = await requireTenant();
  const clean = requireString(title, "title", 300).trim() || "Mi transmisión en vivo";
  await setSessionTitle(tenant, clean);
  revalidatePath("/dashboard");
}

export async function toggleLiveAction(value: boolean): Promise<void> {
  const tenant = await requireTenant();
  await updateSession(tenant, { isLive: value });
  revalidatePath("/dashboard");
}

export async function setClipsEnabledAction(value: boolean): Promise<void> {
  // Turning the ChalyClip connection ON is a full-access-only action —
  // enforce server-side, not just by hiding the switch.
  const session = await getServerSession();
  if (!session) throw new Error("unauthorized");
  if (value && !isFullAccessTier(session.tier)) {
    throw new Error("forbidden: full access required");
  }
  await updateSession(session.tenant_id, { clipsEnabled: value });
  revalidatePath("/dashboard");
}

export async function regenerateKeyAction(): Promise<string> {
  const tenant = await requireTenant();
  const key = await regenerateStreamKey(tenant);
  revalidatePath("/dashboard");
  return key;
}

export async function addDestinationAction(platformId: PlatformId): Promise<void> {
  const tenant = await requireTenant();
  // An unknown platform id would be stored and then crash the dashboard
  // (PLATFORM_META lookup) for this tenant on every load.
  if (typeof platformId !== "string" || !Object.hasOwn(PLATFORM_META, platformId)) {
    throw new Error("invalid platform");
  }
  await addDestination(tenant, platformId);
  revalidatePath("/dashboard");
}

export async function toggleDestinationAction(id: string): Promise<void> {
  const tenant = await requireTenant();
  await toggleDestination(tenant, id);
  revalidatePath("/dashboard");
}

export async function updateDestinationAction(
  id: string,
  patch: {
    channelHandle?: string;
    streamTitle?: string;
    ingestUrl?: string;
    streamKey?: string;
  },
): Promise<void> {
  const tenant = await requireTenant();
  requireString(id, "id", 100);
  const clean: typeof patch = {};
  if (patch?.channelHandle !== undefined) clean.channelHandle = requireString(patch.channelHandle, "channelHandle", 200);
  if (patch?.streamTitle !== undefined) clean.streamTitle = requireString(patch.streamTitle, "streamTitle", 300);
  if (patch?.streamKey !== undefined) clean.streamKey = requireString(patch.streamKey, "streamKey", 1000);
  if (patch?.ingestUrl !== undefined) {
    const url = requireString(patch.ingestUrl, "ingestUrl", 1000).trim();
    // The relay pushes with ffmpeg, which also opens file:/http:/tcp: URLs —
    // only accept the schemes a streaming destination actually uses.
    if (url && !isAllowedIngestUrl(url)) {
      throw new Error("invalid ingestUrl: use rtmp://, rtmps:// or srt://");
    }
    clean.ingestUrl = url;
  }
  await updateDestination(tenant, id, clean);
  revalidatePath("/dashboard");
}

export async function removeDestinationAction(id: string): Promise<void> {
  const tenant = await requireTenant();
  await removeDestination(tenant, id);
  revalidatePath("/dashboard");
}

export async function publishBroadcastAction(
  meta: BroadcastMeta,
): Promise<void> {
  const tenant = await requireTenant();
  // Normalize the untrusted blob (wrong types would crash .trim()/.map()).
  const clean = normalizeBroadcastMeta(meta, "");
  await publishBroadcastMeta(tenant, clean);
  // Then mirror to OAuth-connected platforms (Kick title/category/tags).
  // Best-effort by design — platform outages only surface as row status.
  await pushBroadcastToConnectedPlatforms(tenant, clean);
  revalidatePath("/dashboard");
}
