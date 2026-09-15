"use client";

import { useEffect, useOptimistic, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Header } from "@/components/Header";
import { EncoderPanel } from "@/components/EncoderPanel";
import { ChannelsPanel } from "@/components/ChannelsPanel";
import { Footer } from "@/components/Footer";
import { buildIngest } from "@/lib/ingest";
import { StreamPreview } from "@/components/StreamPreview";
import {
  BroadcastMeta,
  DestinationConfig,
  PLATFORM_META,
  PlatformId,
} from "@/lib/destinations";
import { ChannelPatch } from "@/components/ChannelEditModal";
import {
  addDestinationAction,
  publishBroadcastAction,
  regenerateKeyAction,
  removeDestinationAction,
  setClipsEnabledAction,
  setTitleAction,
  toggleDestinationAction,
  toggleLiveAction,
  updateDestinationAction,
} from "./actions";

type Dest = DestinationConfig & { id: string };

interface Props {
  initialTitle: string;
  initialIsLive: boolean;
  initialClips: boolean;
  initialStreamKey: string;
  initialBroadcastMeta: BroadcastMeta;
  relayRtmp: string;
  previewEnabled: boolean;
  isFullAccess: boolean;
  upgradeUrl: string;
  destinations: Dest[];
  /** Result of an OAuth auto-connect round-trip, from ?connected= /
   *  ?connect_error= on the callback redirect. */
  connectNotice: { kind: "ok" | "error"; code: string } | null;
  /** Which OAuth platforms this deploy has credentials for. */
  oauthAvailable: Partial<Record<PlatformId, boolean>>;
}

/** Human copy for the connect-result banner. Codes come from the
 *  /api/oauth/[platform]/callback redirects as `<platform>_<reason>`
 *  (or a bare platform id on success). */
function connectNoticeText(notice: { kind: "ok" | "error"; code: string }): string {
  if (notice.kind === "ok") {
    const name = platformDisplayName(notice.code);
    return `${name} conectado — ingest URL y stream key se configuraron automáticamente.`;
  }
  const sep = notice.code.indexOf("_");
  const name = platformDisplayName(sep > 0 ? notice.code.slice(0, sep) : "");
  const reason = sep > 0 ? notice.code.slice(sep + 1) : notice.code;
  switch (reason) {
    case "denied":
      return `Cancelaste la conexión con ${name}.`;
    case "not_configured":
      return `La conexión con ${name} no está configurada en este deploy (faltan sus credenciales OAuth).`;
    case "state_mismatch":
      return "La sesión de conexión expiró. Inténtalo de nuevo.";
    default:
      return `${name} no completó la conexión. Inténtalo de nuevo.`;
  }
}

function platformDisplayName(id: string): string {
  return PLATFORM_META[id as PlatformId]?.displayName ?? "La plataforma";
}

type OptimisticAction =
  | { type: "toggle"; id: string }
  | { type: "remove"; id: string }
  | { type: "titles"; title: string };

export function DashboardClient({
  initialTitle,
  initialIsLive,
  initialClips,
  initialStreamKey,
  initialBroadcastMeta,
  relayRtmp,
  previewEnabled,
  isFullAccess,
  upgradeUrl,
  destinations,
  connectNotice,
  oauthAvailable,
}: Props) {
  const router = useRouter();
  const [notice, setNotice] = useState(connectNotice);
  const [noticeDismissed, setNoticeDismissed] = useState(false);
  // True between opening a connect popup and hearing back from it — used to
  // refresh on refocus when the popup can't postMessage (COOP severed the
  // opener, or the flow ended on a platform error page).
  const awaitingConnect = useRef(false);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== window.location.origin) return;
      const d = e.data as {
        source?: string;
        connected?: string | null;
        connectError?: string | null;
      };
      if (d?.source !== "chalybobs-oauth") return;
      awaitingConnect.current = false;
      setNotice(
        d.connected
          ? { kind: "ok", code: d.connected }
          : d.connectError
            ? { kind: "error", code: d.connectError }
            : null,
      );
      setNoticeDismissed(false);
      router.refresh();
    };
    const onFocus = () => {
      if (!awaitingConnect.current) return;
      awaitingConnect.current = false;
      router.refresh();
    };
    window.addEventListener("message", onMessage);
    window.addEventListener("focus", onFocus);
    return () => {
      window.removeEventListener("message", onMessage);
      window.removeEventListener("focus", onFocus);
    };
  }, [router]);

  /** Restream-style connect: the platform's consent/login opens in a popup;
   *  /oauth/done postMessages the result back and closes it. Popup blocked →
   *  degrade to a full-page navigation (the callback then lands on
   *  /dashboard with the same banner params). */
  const openConnect = (path: string) => {
    awaitingConnect.current = true;
    const popup = window.open(
      path,
      "chalybobs_connect",
      "popup=yes,width=520,height=780",
    );
    if (!popup) {
      awaitingConnect.current = false;
      window.location.assign(path);
    }
  };
  const [title, setTitle] = useState(initialTitle);
  const [isLive, setIsLive] = useState(initialIsLive);
  const [clipsEnabled, setClipsEnabled] = useState(initialClips);
  const [streamKey, setStreamKey] = useState(initialStreamKey);
  const [broadcastMeta, setBroadcastMeta] = useState(initialBroadcastMeta);
  const [pending, startTransition] = useTransition();

  // Destinations are server-authoritative (props). useOptimistic gives a
  // snappy local view that reconciles to the server data after each
  // action + router.refresh().
  const [optimistic, applyOptimistic] = useOptimistic(
    destinations,
    (state: Dest[], action: OptimisticAction): Dest[] => {
      switch (action.type) {
        case "toggle":
          return state.map((d) =>
            d.id === action.id ? { ...d, enabled: !d.enabled } : d,
          );
        case "remove":
          return state.filter((d) => d.id !== action.id);
        case "titles":
          return state.map((d) => ({ ...d, streamTitle: action.title }));
      }
    },
  );

  const ingest = buildIngest(streamKey, relayRtmp);

  return (
    <div className="flex flex-col min-h-dvh">
      <Header
        title={title}
        isLive={isLive}
        onTitleChange={(next) => {
          setTitle(next);
          // Keep the composer's title field in sync with the header edit.
          setBroadcastMeta((m) => ({ ...m, title: next }));
          startTransition(() => setTitleAction(next));
        }}
        clipsEnabled={clipsEnabled}
        clipsAvailable={isFullAccess}
        isFullAccess={isFullAccess}
        upgradeUrl={upgradeUrl}
        onToggleClips={() => {
          // On/off switch for the ChalybClip connection. When ON, ChalybOBS
          // forwards each stream's lifecycle to ChalybClip and clips flow.
          // No navigation — just toggles the connection state.
          const next = !clipsEnabled;
          setClipsEnabled(next);
          startTransition(() => setClipsEnabledAction(next));
        }}
      />

      <main className="flex-1 px-4 py-6 sm:px-8 sm:py-8 max-w-7xl mx-auto w-full">
        {notice && !noticeDismissed && (
          <div
            className={`mb-4 px-4 py-3 rounded-lg border flex items-center gap-3 text-sm ${
              notice.kind === "ok"
                ? "bg-good/10 border-good/40 text-text-primary"
                : "bg-bad/10 border-bad/40 text-text-primary"
            }`}
          >
            <span className="flex-1">{connectNoticeText(notice)}</span>
            <button
              onClick={() => {
                setNoticeDismissed(true);
                // Drop ?connected/?connect_error so a reload doesn't re-show it.
                router.replace("/dashboard");
              }}
              className="text-text-tertiary hover:text-text-primary text-lg leading-none"
              aria-label="Cerrar aviso"
            >
              ×
            </button>
          </div>
        )}
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_380px] gap-6">
          <div className="space-y-6">
            {/* Restream-style: the encoder card lives INSIDE the player while
                offline; the moment the feed arrives it's replaced by video. */}
            <StreamPreview
              hlsUrl={previewEnabled ? "/api/preview/index.m3u8" : null}
              offlineContent={
                <EncoderPanel
                  embedded
                  ingest={ingest}
                  isLive={isLive}
                  onRegenerateKey={() => {
                    startTransition(async () => {
                      const fresh = await regenerateKeyAction();
                      setStreamKey(fresh);
                    });
                  }}
                />
              }
            />
          </div>
          <ChannelsPanel
            destinations={optimistic}
            broadcastMeta={broadcastMeta}
            oauthAvailable={oauthAvailable}
            onConnect={openConnect}
            busy={pending}
            onToggle={(id) => {
              startTransition(async () => {
                applyOptimistic({ type: "toggle", id });
                await toggleDestinationAction(id);
                router.refresh();
              });
            }}
            onAddChannel={(platformId: PlatformId) => {
              startTransition(async () => {
                await addDestinationAction(platformId);
                router.refresh();
              });
            }}
            onPublishBroadcast={(meta) => {
              const nextTitle = meta.title.trim() || title;
              setTitle(nextTitle);
              setBroadcastMeta(meta);
              startTransition(async () => {
                applyOptimistic({ type: "titles", title: nextTitle });
                await publishBroadcastAction(meta);
                router.refresh();
              });
            }}
            onRemove={(id) => {
              startTransition(async () => {
                applyOptimistic({ type: "remove", id });
                await removeDestinationAction(id);
                router.refresh();
              });
            }}
            onSaveDestination={(id, patch: ChannelPatch) => {
              startTransition(async () => {
                await updateDestinationAction(id, patch);
                router.refresh();
              });
            }}
          />
        </div>

        {/* Dev-only helper — never shipped to users. */}
        {process.env.NODE_ENV !== "production" && (
          <div className="mt-6 flex justify-center">
            <button
              onClick={() => {
                const next = !isLive;
                setIsLive(next);
                startTransition(() => toggleLiveAction(next));
              }}
              className="text-[10px] tracking-widest font-bold text-text-tertiary hover:text-text-primary px-3 py-1.5 rounded border border-border bg-surface"
            >
              DEV · TOGGLE {isLive ? "OFFLINE" : "LIVE"}
            </button>
          </div>
        )}
      </main>

      <Footer />
    </div>
  );
}
