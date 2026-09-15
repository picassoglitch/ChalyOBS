export type PlatformId =
  | "kick"
  | "twitch"
  | "youtube"
  | "tiktok"
  | "restream"
  | "custom_rtmp"
  | "custom_srt";

/**
 * One row per platform the user connects. Holds everything we need to
 * (a) broadcast TO the platform via RTMP/SRT and (b) read inbound chat
 * FROM the user's own channel there.
 */
export interface DestinationConfig {
  platformId: PlatformId;
  /** Channel handle (e.g. 'picassoglitch' → kick.com/picassoglitch).
   *  Used to look up inbound chat; some platforms also derive ingest from it. */
  channelSlug: string;
  /** Custom ingest URL. For named platforms this falls back to PLATFORM_META.ingestHint. */
  ingestUrl: string;
  /** Stream key for outbound RTMP. Stored via the `secrets` kv (Phase 0:
   *  AsyncStorage; Phase 1 dev build: Keychain/Keystore). */
  streamKey: string;
  /** OAuth refresh / access token for write actions (chat send, etc.). */
  oauthToken: string;
  /** When true, this platform is included in the next stream session + chat read. */
  enabled: boolean;
}

export interface PlatformMeta {
  displayName: string;
  ingestHint: string;
  accent: string;
  /** Whether ChalyOBS reads inbound chat from this platform today. */
  supportsChat: boolean;
  /** Whether ChalyOBS broadcasts via RTMP/SRT to this platform today. */
  supportsBroadcast: boolean;
  /** One-line status note shown on the destinations row. */
  phaseNote: string;
}

export const PLATFORM_META: Record<PlatformId, PlatformMeta> = {
  kick: {
    displayName: "Kick",
    ingestHint: "rtmps://fa723fc1b171.global-contribute.live-video.net",
    accent: "#53FC18",
    supportsChat: true,
    supportsBroadcast: true,
    phaseNote:
      "Chat en vivo desde Fase 0. Broadcast RTMP en Fase 1 (dev build).",
  },
  twitch: {
    displayName: "Twitch",
    ingestHint: "rtmp://live.twitch.tv/app",
    accent: "#9146FF",
    supportsChat: false,
    supportsBroadcast: true,
    phaseNote:
      "Broadcast en Fase 1. Chat IRC anónimo + OAuth llegan en Fase 0.5.",
  },
  youtube: {
    displayName: "YouTube Live",
    ingestHint: "rtmp://a.rtmp.youtube.com/live2",
    accent: "#FF0033",
    supportsChat: false,
    supportsBroadcast: true,
    phaseNote: "Broadcast en Fase 1. Chat requiere OAuth 2.0 (Fase 0.5).",
  },
  tiktok: {
    displayName: "TikTok Live",
    ingestHint: "",
    accent: "#FF0050",
    supportsChat: false,
    supportsBroadcast: true,
    phaseNote:
      "Solo cuentas con TikTok Live habilitado. Ingest manual; chat en Fase 1+.",
  },
  restream: {
    displayName: "Restream",
    ingestHint: "rtmp://live.restream.io/live",
    accent: "#22D3EE",
    supportsChat: false,
    supportsBroadcast: true,
    phaseNote: "Multistream a través de Restream. Broadcast Fase 1; chat Fase 0.5.",
  },
  custom_rtmp: {
    displayName: "RTMP custom",
    ingestHint: "",
    accent: "#00FFA3",
    supportsChat: false,
    supportsBroadcast: true,
    phaseNote: "Apunta a tu servidor / OBS local. URL + clave manuales.",
  },
  custom_srt: {
    displayName: "SRT custom",
    ingestHint: "",
    accent: "#3DD5F3",
    supportsChat: false,
    supportsBroadcast: true,
    phaseNote: "SRT puro. Disponible cuando el publicador SRT aterrice.",
  },
};

export const PLATFORM_ORDER: PlatformId[] = [
  "kick",
  "twitch",
  "youtube",
  "tiktok",
  "restream",
  "custom_rtmp",
  "custom_srt",
];

export function emptyDestination(platformId: PlatformId): DestinationConfig {
  return {
    platformId,
    channelSlug: "",
    ingestUrl: "",
    streamKey: "",
    oauthToken: "",
    enabled: false,
  };
}
