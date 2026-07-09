"use client";

import { useState } from "react";
import {
  DestinationConfig,
  PLATFORM_META,
  PlatformId,
} from "@/lib/destinations";
import { CopyIcon } from "./icons";

type Dest = DestinationConfig & { id: string };

export interface ChannelPatch {
  channelHandle?: string;
  streamTitle?: string;
  ingestUrl?: string;
  streamKey?: string;
}

interface Props {
  destination: Dest;
  onClose: () => void;
  onSave: (patch: ChannelPatch) => void;
  busy?: boolean;
}

export function ChannelEditModal({ destination, onClose, onSave, busy }: Props) {
  const meta = PLATFORM_META[destination.platformId];
  const isCustom =
    destination.platformId === "custom_rtmp" ||
    destination.platformId === "custom_srt";

  const [channelHandle, setChannelHandle] = useState(destination.channelHandle);
  const [streamTitle, setStreamTitle] = useState(destination.streamTitle);
  const [ingestUrl, setIngestUrl] = useState(
    destination.ingestUrl || meta.ingestHint,
  );
  const [streamKey, setStreamKey] = useState(destination.streamKey);
  const [revealKey, setRevealKey] = useState(false);

  const canSave =
    ingestUrl.trim().length > 0 && streamKey.trim().length > 0 && !busy;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-2xl bg-surface border border-border p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 mb-5">
          <span
            className="w-3 h-3 rounded-full"
            style={{ backgroundColor: `var(--color-${meta.colorVar})` }}
          />
          <h2 className="text-lg font-bold flex-1">Configurar {meta.displayName}</h2>
          <button
            onClick={onClose}
            className="text-text-tertiary hover:text-text-primary text-xl leading-none"
          >
            ×
          </button>
        </div>

        {destination.oauthConnected && (
          <div className="mb-4 px-3 py-2.5 rounded-lg bg-good/10 border border-good/40 text-[11px] text-text-secondary leading-relaxed">
            Conectado con tu cuenta de {meta.displayName} — el ingest URL y el
            stream key se rellenaron automáticamente y se actualizan al
            reconectar. Normalmente no necesitas editarlos a mano.
          </div>
        )}

        <div className="space-y-4">
          <Field
            label="Nombre del canal / handle"
            value={channelHandle}
            onChange={setChannelHandle}
            placeholder={hintHandle(destination.platformId)}
          />

          <Field
            label="Título del stream"
            value={streamTitle}
            onChange={setStreamTitle}
            placeholder="Lo que se mostrará en vivo"
          />

          <Field
            label={isCustom ? "Ingest URL (RTMP/SRT)" : "Ingest URL"}
            value={ingestUrl}
            onChange={setIngestUrl}
            placeholder="rtmp://..."
            mono
            readOnly={!isCustom && meta.ingestHint.length > 0}
            hint={
              !isCustom && meta.ingestHint.length > 0
                ? "URL fija de la plataforma. Solo necesitas el stream key."
                : undefined
            }
          />

          <div>
            <label className="block text-[10px] font-bold tracking-[0.1em] text-text-tertiary uppercase mb-2">
              Stream key
            </label>
            <div className="flex items-stretch gap-1 rounded-lg bg-surface-elevated border border-border overflow-hidden">
              <input
                value={streamKey}
                onChange={(e) => setStreamKey(e.target.value)}
                type={revealKey ? "text" : "password"}
                placeholder="Pega aquí el stream key de la plataforma"
                autoComplete="off"
                className="flex-1 px-3.5 py-2.5 bg-transparent font-mono text-xs text-text-primary outline-none"
              />
              <button
                type="button"
                onClick={() => setRevealKey((v) => !v)}
                className="px-3 text-[10px] font-bold tracking-wider text-text-tertiary hover:text-text-primary"
              >
                {revealKey ? "OCULTAR" : "VER"}
              </button>
            </div>
            <p className="text-[10px] text-text-tertiary mt-1.5 leading-relaxed">
              {keyHint(destination.platformId)}
            </p>
          </div>
        </div>

        <div className="flex gap-2 mt-6">
          <button
            onClick={onClose}
            className="flex-1 py-2.5 rounded-lg border border-border text-sm font-semibold text-text-secondary hover:bg-surface-elevated transition"
          >
            Cancelar
          </button>
          <button
            disabled={!canSave}
            onClick={() =>
              onSave({
                channelHandle: channelHandle.trim(),
                streamTitle: streamTitle.trim(),
                ingestUrl: ingestUrl.trim(),
                streamKey: streamKey.trim(),
              })
            }
            className="flex-1 py-2.5 rounded-lg bg-accent text-white text-sm font-semibold hover:opacity-90 transition disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Guardar
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  mono,
  readOnly,
  hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  mono?: boolean;
  readOnly?: boolean;
  hint?: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div>
      <label className="block text-[10px] font-bold tracking-[0.1em] text-text-tertiary uppercase mb-2">
        {label}
      </label>
      <div className="flex items-stretch gap-1 rounded-lg bg-surface-elevated border border-border overflow-hidden">
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          readOnly={readOnly}
          autoComplete="off"
          autoCapitalize="none"
          className={`flex-1 px-3.5 py-2.5 bg-transparent text-xs text-text-primary outline-none ${
            mono ? "font-mono" : ""
          } ${readOnly ? "text-text-secondary" : ""}`}
        />
        {readOnly && (
          <button
            type="button"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(value);
                setCopied(true);
                setTimeout(() => setCopied(false), 1200);
              } catch {}
            }}
            className="px-3 text-text-tertiary hover:text-text-primary"
            title={copied ? "Copiado" : "Copiar"}
          >
            <CopyIcon className="w-4 h-4" />
          </button>
        )}
      </div>
      {hint && <p className="text-[10px] text-text-tertiary mt-1.5">{hint}</p>}
    </div>
  );
}

function hintHandle(p: PlatformId): string {
  switch (p) {
    case "kick":
      return "picassoglitch";
    case "twitch":
      return "tu_usuario_twitch";
    case "youtube":
      return "Tu canal de YouTube";
    case "tiktok":
      return "@tu_tiktok";
    case "facebook":
      return "Tu página de Facebook";
    case "instagram":
      return "@tu_instagram";
    default:
      return "Nombre del canal";
  }
}

function keyHint(p: PlatformId): string {
  switch (p) {
    case "twitch":
      return "Twitch → Creator Dashboard → Settings → Stream → Primary Stream key.";
    case "youtube":
      return "YouTube Studio → Go Live → Stream → Clave de transmisión.";
    case "kick":
      return "Kick → Settings → Stream Key.";
    case "facebook":
      return "Facebook Live Producer → usar clave de transmisión persistente.";
    case "tiktok":
      return "TikTok LIVE Center → requiere que tu cuenta tenga acceso a LIVE por RTMP (1000+ seguidores o invitación).";
    case "restream":
      return "Restream → Settings → Streaming setup → Stream key.";
    case "custom_rtmp":
      return "La clave/credencial que te dé tu servidor de destino.";
    case "custom_srt":
      return "El streamid de tu servidor SRT (lo añadimos como ?streamid=... a la URL). Si tu URL ya lo incluye, pégalo igual aquí.";
    default:
      return "Pega el stream key que te da la plataforma.";
  }
}
