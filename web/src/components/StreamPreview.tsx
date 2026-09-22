"use client";

import { ReactNode, useEffect, useRef, useState } from "react";
import Hls from "hls.js";

type State = "connecting" | "live" | "reconnecting" | "error" | "unconfigured";

interface Props {
  /** HLS manifest URL, or null when the relay HLS base isn't configured. */
  hlsUrl: string | null;
  /** Rendered INSIDE the player while there's no signal (Restream-style
   *  "Connect your encoder" card). Disappears as soon as the feed shows. */
  offlineContent?: ReactNode;
}

// After this many consecutive fatal errors *once we've had signal*, stop
// auto-recovering and surface the alert with a manual retry.
const MAX_FATAL_BEFORE_ALERT = 6;

/**
 * Live preview player. Pulls HLS from the relay via the authenticated
 * same-origin proxy. The manifest only exists while an encoder is pushing,
 * so before first signal we sit in "connecting". Transient errors after
 * we've had signal use hls.js's built-in recovery (network → reload, media
 * → recover) and show "reconnecting" — keeping the last frame — instead of
 * flickering back to "waiting". Only sustained failure raises the alert.
 *
 * HLS (not WebRTC) because the relay's HTTP proxy is TCP-only.
 */
export function StreamPreview({ hlsUrl, offlineContent }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [state, setState] = useState<State>(
    hlsUrl ? "connecting" : "unconfigured",
  );
  const [attempt, setAttempt] = useState(0); // bump to force a full reconnect

  useEffect(() => {
    if (!hlsUrl) {
      setState("unconfigured");
      return;
    }
    const video = videoRef.current;
    if (!video) return;

    let cancelled = false;
    let hls: Hls | null = null;
    let fatalCount = 0;
    let hadSignal = false;
    let reloadTimer: ReturnType<typeof setTimeout> | null = null;

    const markLive = () => {
      if (cancelled) return;
      hadSignal = true;
      fatalCount = 0;
      setState("live");
    };

    // Native HLS (Safari / iOS).
    if (video.canPlayType("application/vnd.apple.mpegurl") && !Hls.isSupported()) {
      video.src = hlsUrl;
      const onPlaying = () => markLive();
      const onError = () => {
        if (cancelled) return;
        setState(hadSignal ? "reconnecting" : "connecting");
        reloadTimer = setTimeout(() => {
          if (!cancelled) video.load();
        }, 3000);
      };
      video.addEventListener("playing", onPlaying);
      video.addEventListener("error", onError);
      video.play().catch(() => {});
      return () => {
        cancelled = true;
        if (reloadTimer) clearTimeout(reloadTimer);
        video.removeEventListener("playing", onPlaying);
        video.removeEventListener("error", onError);
      };
    }

    if (!Hls.isSupported()) {
      setState("connecting");
      return;
    }

    hls = new Hls({
      // Stability over latency: LL-HLS through the proxy flaps. A few extra
      // seconds of delay is fine for a confidence monitor.
      lowLatencyMode: false,
      manifestLoadingMaxRetry: 6,
      manifestLoadingRetryDelay: 1000,
      levelLoadingMaxRetry: 6,
      fragLoadingMaxRetry: 8,
    });

    hls.loadSource(hlsUrl);
    hls.attachMedia(video);

    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      if (cancelled) return;
      video.play().catch(() => {});
    });
    hls.on(Hls.Events.FRAG_BUFFERED, markLive);
    hls.on(Hls.Events.ERROR, (_evt, data) => {
      if (cancelled || !data.fatal) return;
      fatalCount += 1;

      // Before any signal, fatal errors are just "no publisher yet" — stay
      // calm in connecting and let hls.js keep retrying the manifest.
      if (!hadSignal) {
        setState("connecting");
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) hls?.startLoad();
        return;
      }

      // Had signal → transient blip. Try to recover in place.
      if (fatalCount < MAX_FATAL_BEFORE_ALERT) {
        setState("reconnecting");
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
          hls?.startLoad();
        } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
          hls?.recoverMediaError();
        } else {
          // Unrecoverable type → full reconnect on a delay.
          reloadTimer = setTimeout(() => {
            if (!cancelled) setAttempt((a) => a + 1);
          }, 3000);
        }
        return;
      }

      // Sustained failure → give up auto-recovery, raise the alert.
      setState("error");
      hls?.destroy();
    });

    return () => {
      cancelled = true;
      if (reloadTimer) clearTimeout(reloadTimer);
      hls?.destroy();
    };
  }, [hlsUrl, attempt]);

  const showVideo = state === "live" || state === "reconnecting";
  const showOfflineCard =
    (state === "connecting" || state === "unconfigured") && !!offlineContent;

  return (
    <div className="rounded-2xl bg-surface border border-border overflow-hidden">
      {/* While the encoder card is inside the player, let the box grow past
          16:9 so the card never clips; strict 16:9 once video shows. */}
      <div
        className={`relative aspect-video bg-black ${showOfflineCard ? "min-h-[35rem]" : ""}`}
      >
        <video
          ref={videoRef}
          className={`w-full h-full object-contain ${showVideo ? "" : "opacity-0"}`}
          muted
          playsInline
          controls={state === "live"}
        />

        {/* LIVE badge */}
        {state === "live" && (
          <span className="absolute top-3 left-3 inline-flex items-center gap-1.5 px-2 py-1 rounded-md bg-bad/80 text-white text-[10px] font-bold tracking-wider">
            <span className="w-1.5 h-1.5 rounded-full bg-white animate-pulse" />
            LIVE
          </span>
        )}

        {/* Reconnecting — keep last frame visible, overlay a small banner */}
        {state === "reconnecting" && (
          <div className="absolute top-3 left-3 inline-flex items-center gap-2 px-2.5 py-1.5 rounded-md bg-black/70 text-warn text-[11px] font-semibold">
            <span className="w-3 h-3 rounded-full border-2 border-warn border-t-transparent animate-spin" />
            Reconectando…
          </div>
        )}

        {/* Sustained mid-stream failure — alert + manual retry */}
        {state === "error" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center text-center px-6">
            <div className="w-12 h-12 rounded-full bg-bad/15 border border-bad/40 flex items-center justify-center mb-3">
              <span className="text-bad text-xl leading-none">!</span>
            </div>
            <p className="text-sm font-semibold text-bad">Señal perdida</p>
            <p className="text-[11px] text-text-tertiary mt-1 max-w-xs">
              Se interrumpió la conexión con el relay (red o el encoder dejó
              de transmitir).
            </p>
            <button
              onClick={() => {
                setState("connecting");
                setAttempt((a) => a + 1);
              }}
              className="mt-3 px-3 py-1.5 rounded-md bg-accent text-white text-xs font-semibold hover:opacity-90 transition"
            >
              Reintentar
            </button>
          </div>
        )}

        {/* No signal yet — the encoder card lives inside the player
            (Restream-style) and vanishes when the feed arrives. */}
        {(state === "connecting" || state === "unconfigured") &&
          (offlineContent ? (
            <div className="absolute inset-0 overflow-y-auto">
              <span className="absolute top-3 left-3 z-10 px-2 py-1 rounded-md bg-surface-high text-text-tertiary text-[10px] font-bold tracking-wider">
                OFFLINE
              </span>
              <div className="min-h-full flex flex-col items-center justify-center px-6 py-8">
                <div className="w-full max-w-md">{offlineContent}</div>
                {state === "unconfigured" && (
                  <p className="text-[10px] text-text-tertiary mt-3 text-center">
                    Preview no disponible — el relay aún no expone HLS (
                    <code className="font-mono">CHALYBOBS_RELAY_INTERNAL_HLS</code>
                    ).
                  </p>
                )}
              </div>
            </div>
          ) : (
            <div className="absolute inset-0 flex flex-col items-center justify-center text-center px-6">
              {state === "unconfigured" ? (
                <>
                  <div className="w-12 h-12 rounded-full border border-border flex items-center justify-center mb-3">
                    <span className="w-2.5 h-2.5 rounded-full bg-text-tertiary" />
                  </div>
                  <p className="text-sm font-semibold text-text-secondary">
                    Preview no disponible
                  </p>
                  <p className="text-[11px] text-text-tertiary mt-1 max-w-xs">
                    El relay aún no expone HLS. Configura{" "}
                    <code className="font-mono">CHALYBOBS_RELAY_INTERNAL_HLS</code>.
                  </p>
                </>
              ) : (
                <>
                  <div className="w-12 h-12 rounded-full border border-border flex items-center justify-center mb-3">
                    <span className="w-3 h-3 rounded-full border-2 border-text-tertiary border-t-transparent animate-spin" />
                  </div>
                  <p className="text-sm font-semibold text-text-secondary">
                    Esperando señal…
                  </p>
                  <p className="text-[11px] text-text-tertiary mt-1 max-w-xs">
                    Conecta tu encoder al relay. El preview aparece unos
                    segundos después de empezar a transmitir.
                  </p>
                </>
              )}
            </div>
          ))}
      </div>
    </div>
  );
}
