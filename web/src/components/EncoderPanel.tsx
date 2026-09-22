"use client";

import { useState } from "react";
import { IngestCredentials } from "@/lib/ingest";
import { CopyIcon, RefreshIcon } from "./icons";

interface EncoderPanelProps {
  ingest: IngestCredentials;
  isLive: boolean;
  onRegenerateKey: () => void;
  /** Rendered inside the player (StreamPreview's offline overlay): no card
   *  chrome or status badge — the player provides both. */
  embedded?: boolean;
}

/**
 * Encoder credentials card. RTMP only — that's the protocol the relay
 * actually ingests (MediaMTX rtmp:1935 behind the relay's TCP proxy; SRT and
 * WebRTC ride UDP, which the proxy can't carry). No fake protocol tabs.
 */
export function EncoderPanel({
  ingest,
  isLive,
  onRegenerateKey,
  embedded = false,
}: EncoderPanelProps) {
  const [keyVisible, setKeyVisible] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);

  return (
    <section
      className={
        embedded
          ? "w-full"
          : "rounded-2xl bg-surface border border-border p-6 sm:p-8 relative overflow-hidden"
      }
    >
      {!embedded && (
        <span
          className={`absolute top-4 left-4 inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-[10px] font-bold tracking-wider ${
            isLive
              ? "bg-bad/15 text-bad"
              : "bg-surface-high text-text-tertiary"
          }`}
        >
          {isLive && <span className="w-1.5 h-1.5 rounded-full bg-bad animate-pulse" />}
          {isLive ? "LIVE" : "OFFLINE"}
        </span>
      )}

      <div className={`text-center ${embedded ? "mb-4" : "mb-5 mt-2"}`}>
        <h2 className="text-xl font-bold text-text-primary">
          Connect your encoder
        </h2>
        <p className="text-xs text-text-tertiary mt-1">
          Copia y pega estos datos en OBS, vMix, tu Osmo o cualquier encoder RTMP.
        </p>
      </div>

      <Field label="RTMP URL" value={ingest.rtmpUrl} />

      <div className="mt-3">
        <Field
          label="Stream key"
          value={ingest.streamKey}
          secret
          visible={keyVisible}
          onToggleVisible={() => setKeyVisible((v) => !v)}
          onRegenerate={onRegenerateKey}
        />
      </div>

      <div className="mt-3">
        <Field label="URL completa (cámaras de un solo campo)" value={ingest.fullRtmpUrl} />
        <p className="text-[10px] text-text-tertiary mt-1.5 leading-relaxed">
          Para DJI Osmo / Mimo, GoPro o el teléfono — que solo tienen un campo
          de URL — pega esta. Ya incluye tu stream key.
        </p>
      </div>

      <div className={embedded ? "mt-4" : "mt-5"}>
        <button
          type="button"
          onClick={() => setGuideOpen((v) => !v)}
          aria-expanded={guideOpen}
          className="w-full text-center text-xs text-accent hover:underline font-medium"
        >
          {guideOpen ? "▾" : "▸"} Cómo conectar OBS, Zoom, vMix
        </button>
        {guideOpen && (
          <div className="mt-3 rounded-lg bg-surface-elevated border border-border p-4 text-left">
            <ol className="space-y-2.5 text-[11px] text-text-secondary leading-relaxed list-decimal list-inside">
              <li>
                <b className="text-text-primary">OBS Studio:</b> Ajustes →
                Transmisión → Servicio:{" "}
                <code className="font-mono">Personalizado</code> → pega la{" "}
                <b>RTMP URL</b> en «Servidor» y el <b>stream key</b> en «Clave
                de retransmisión» → Iniciar transmisión.
              </li>
              <li>
                <b className="text-text-primary">vMix:</b> Settings → Streaming
                → Destination: <code className="font-mono">Custom RTMP
                Server</code> → URL + Stream Name or Key → Start.
              </li>
              <li>
                <b className="text-text-primary">Zoom:</b> requiere plan con
                «Custom Live Streaming»: en la reunión → Más → Transmitir en
                vivo en servicio personalizado → pega URL y key.
              </li>
              <li>
                <b className="text-text-primary">Osmo / GoPro / teléfono:</b>{" "}
                usa la <b>URL completa</b> de arriba (un solo campo).
              </li>
            </ol>
            <p className="mt-3 text-[10px] text-text-tertiary">
              Al conectar, el preview aparece aquí en unos segundos y tu señal
              se reenvía a todos los canales activos.
            </p>
          </div>
        )}
      </div>
    </section>
  );
}

interface FieldProps {
  label: string;
  value: string;
  secret?: boolean;
  visible?: boolean;
  onToggleVisible?: () => void;
  onRegenerate?: () => void;
}

function Field({
  label,
  value,
  secret,
  visible,
  onToggleVisible,
  onRegenerate,
}: FieldProps) {
  const [copied, setCopied] = useState(false);
  const displayValue = secret && !visible ? "•".repeat(Math.min(value.length, 40)) : value;

  return (
    <div>
      <label className="block text-[10px] font-bold tracking-[0.1em] text-text-tertiary uppercase mb-2">
        {label}
      </label>
      <div className="flex items-stretch gap-1 rounded-lg bg-surface-elevated border border-border overflow-hidden">
        <button
          type="button"
          onClick={() => onToggleVisible?.()}
          disabled={!secret}
          className="flex-1 text-left px-3.5 py-2.5 font-mono text-xs text-text-secondary truncate disabled:cursor-default"
        >
          {displayValue}
        </button>
        {onRegenerate && (
          <button
            type="button"
            onClick={onRegenerate}
            className="px-3 text-text-tertiary hover:text-text-primary hover:bg-surface-high transition"
            aria-label="Regenerar clave"
            title="Regenerar"
          >
            <RefreshIcon className="w-4 h-4" />
          </button>
        )}
        <button
          type="button"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(value);
              setCopied(true);
              setTimeout(() => setCopied(false), 1400);
            } catch {
              // noop — clipboard unavailable
            }
          }}
          className="px-3 text-text-tertiary hover:text-text-primary hover:bg-surface-high transition"
          aria-label="Copiar"
          title={copied ? "¡Copiado!" : "Copiar"}
        >
          <CopyIcon className="w-4 h-4" />
        </button>
      </div>
      {copied && (
        <span className="text-[10px] text-good mt-1 inline-block">
          Copiado al portapapeles
        </span>
      )}
    </div>
  );
}
