import { redirect } from "next/navigation";
import { getServerSession } from "@/lib/server-session";
import { isSupabaseConfigured } from "@/lib/supabase";
import { getDestinations, getOrCreateSession } from "@/lib/data";
import { isFullAccessTier } from "@/lib/tier";
import { oauthAvailability } from "@/lib/oauth/providers";
import { DashboardClient } from "./DashboardClient";

// Per-tenant data — never cache across requests.
export const dynamic = "force-dynamic";

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await getServerSession();
  if (!session) redirect("/login?next=/dashboard");

  // Result of an OAuth auto-connect round-trip (/api/oauth/<platform>/…).
  const params = await searchParams;
  const connected = typeof params.connected === "string" ? params.connected : null;
  const connectError =
    typeof params.connect_error === "string" ? params.connect_error : null;
  const connectNotice = connected
    ? ({ kind: "ok", code: connected } as const)
    : connectError
      ? ({ kind: "error", code: connectError } as const)
      : null;

  // If the DB isn't configured yet, surface a clear message instead of a
  // 500 — keeps the deploy diagnosable.
  if (!isSupabaseConfigured()) {
    return (
      <div className="flex-1 flex items-center justify-center px-6 py-16 text-center">
        <div className="max-w-md">
          <h1 className="text-xl font-bold mb-2">Base de datos no configurada</h1>
          <p className="text-text-tertiary text-sm">
            Falta <code className="font-mono">NEXOOBS_SUPABASE_URL</code> y{" "}
            <code className="font-mono">NEXOOBS_SUPABASE_SECRET_KEY</code>{" "}
            en Railway. El multi-tenant no puede cargar sin ellas.
          </p>
        </div>
      </div>
    );
  }

  const tenantId = session.tenant_id;
  const [tenantSession, destinations] = await Promise.all([
    getOrCreateSession(tenantId),
    getDestinations(tenantId),
  ]);

  // The reachable RTMP endpoint of the relay (Railway TCP-proxy host:port).
  // Set in Railway as NEXOOBS_RELAY_RTMP_URL.
  const relayRtmp =
    process.env.NEXOOBS_RELAY_RTMP_URL ?? "rtmp://ingest.nexo-ai.world/live";
  // Preview is available when the relay's private HLS address is set; the
  // player then pulls from the authenticated same-origin proxy.
  const previewEnabled = Boolean(process.env.NEXOOBS_RELAY_INTERNAL_HLS);
  // The NexoClip connection switch is full-access only (ALL_ACCESS or
  // PARTNER). Definition lives in @/lib/tier so the server-side gate matches.
  const isFullAccess = isFullAccessTier(session.tier);
  // Upgrade lands on Nexo-AI World (plans live there, not in NexoOBS).
  const upgradeUrl = (
    process.env.NEXO_AI_LOGIN_URL ?? "https://nexo-ai.world/login"
  ).replace(/\/login\/?$/, "");

  return (
    <DashboardClient
      initialTitle={tenantSession.title}
      initialIsLive={tenantSession.isLive}
      initialClips={tenantSession.clipsEnabled}
      initialStreamKey={tenantSession.streamKey}
      initialBroadcastMeta={tenantSession.broadcastMeta}
      relayRtmp={relayRtmp}
      previewEnabled={previewEnabled}
      isFullAccess={isFullAccess}
      upgradeUrl={upgradeUrl}
      destinations={destinations}
      connectNotice={connectNotice}
      // Per-deploy: which platforms have OAuth app credentials configured.
      // Unavailable ones show manual entry instead of a dead Connect button.
      oauthAvailable={oauthAvailability()}
    />
  );
}
