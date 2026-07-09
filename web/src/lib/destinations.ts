export type PlatformId =
  | "kick"
  | "twitch"
  | "youtube"
  | "tiktok"
  | "facebook"
  | "instagram"
  | "restream"
  | "custom_rtmp"
  | "custom_srt";

export interface DestinationConfig {
  platformId: PlatformId;
  /** Display name shown on the row (typically the user's handle on that platform). */
  channelHandle: string;
  /** Free-form title shown live on the destination. */
  streamTitle: string;
  /** Custom ingest URL (used for custom_rtmp / custom_srt). */
  ingestUrl: string;
  /** Stream key for outbound RTMP. Never serialize to non-secret storage. */
  streamKey: string;
  /** True when the row was auto-connected via platform OAuth (tokens stay
   *  server-side — the client only ever sees this flag). */
  oauthConnected: boolean;
  /** When true, this platform receives the next session. */
  enabled: boolean;
  /** Optional health/auth state surfaced as a banner under the row. */
  status?: DestinationStatus;
}

export type DestinationStatus =
  | { kind: "ok" }
  | { kind: "offline" }
  | { kind: "expired"; action: "reconnect" }
  | { kind: "pending_approval"; platformName: string };

export interface PlatformMeta {
  displayName: string;
  ingestHint: string;
  /** CSS variable name (without the `--color-` prefix) — matches `globals.css`. */
  colorVar: string;
  supportsChat: boolean;
  supportsBroadcast: boolean;
}

export const PLATFORM_META: Record<PlatformId, PlatformMeta> = {
  kick: {
    displayName: "Kick",
    ingestHint: "rtmps://fa723fc1b171.global-contribute.live-video.net:443/app",
    colorVar: "kick",
    supportsChat: true,
    supportsBroadcast: true,
  },
  twitch: {
    displayName: "Twitch",
    ingestHint: "rtmp://live.twitch.tv/app",
    colorVar: "twitch",
    supportsChat: true,
    supportsBroadcast: true,
  },
  youtube: {
    displayName: "YouTube Live",
    ingestHint: "rtmp://a.rtmp.youtube.com/live2",
    colorVar: "youtube",
    supportsChat: true,
    supportsBroadcast: true,
  },
  tiktok: {
    displayName: "TikTok Live",
    ingestHint: "",
    colorVar: "tiktok",
    supportsChat: false,
    supportsBroadcast: true,
  },
  facebook: {
    displayName: "Facebook Live",
    ingestHint: "rtmps://live-api-s.facebook.com:443/rtmp",
    colorVar: "facebook",
    supportsChat: true,
    supportsBroadcast: true,
  },
  instagram: {
    displayName: "Instagram Live",
    ingestHint: "",
    colorVar: "instagram",
    supportsChat: false,
    supportsBroadcast: false,
  },
  restream: {
    displayName: "Restream",
    ingestHint: "rtmp://live.restream.io/live",
    colorVar: "restream",
    supportsChat: false,
    supportsBroadcast: true,
  },
  custom_rtmp: {
    displayName: "RTMP custom",
    ingestHint: "",
    colorVar: "accent",
    supportsChat: false,
    supportsBroadcast: true,
  },
  custom_srt: {
    displayName: "SRT custom",
    ingestHint: "",
    colorVar: "accent",
    supportsChat: false,
    supportsBroadcast: true,
  },
};

/** Platforms with a Restream-style OAuth auto-connect flow. Value is the
 *  route that starts the flow (full-page navigation, not fetch — it 303s to
 *  the platform's authorize page). Whether a given deploy can actually use
 *  it depends on that platform's app credentials — the dashboard receives
 *  that availability from the server (oauthAvailability()) and falls back
 *  to manual entry when absent. Keep in sync with lib/oauth/providers.ts. */
export const OAUTH_CONNECT_PATH: Partial<Record<PlatformId, string>> = {
  kick: "/api/oauth/kick/start",
  twitch: "/api/oauth/twitch/start",
  youtube: "/api/oauth/youtube/start",
};

export const PLATFORM_ORDER: PlatformId[] = [
  "kick",
  "twitch",
  "youtube",
  "tiktok",
  "facebook",
  "instagram",
  "restream",
  "custom_rtmp",
  "custom_srt",
];

/** First-letter avatar fallback so the channel row always renders something. */
export function avatarInitial(handle: string): string {
  const trimmed = handle.trim();
  if (trimmed.length === 0) return "?";
  return trimmed[0]!.toUpperCase();
}

// ── Broadcast metadata composer ──────────────────────────────────────────────
//
// The "Update Titles" composer collects a single superset of broadcast
// metadata. On publish, each field is applied only to the platforms that
// support it (PLATFORM_FIELD_SUPPORT) — that's the "availability accordingly".

export type BroadcastFieldId =
  | "title"
  | "description"
  | "category"
  | "tags"
  | "language"
  | "visibility"
  | "madeForKids"
  | "mature";

export type Visibility = "public" | "unlisted" | "private";

/** The full composer state — one shared blob per tenant. */
export interface BroadcastMeta {
  title: string;
  description: string;
  /** Game / category name (free text — platforms resolve to their own ids). */
  category: string;
  tags: string[];
  /** ISO-639-1 language code, or "" for unset. */
  language: string;
  /** YouTube broadcast visibility. */
  visibility: Visibility;
  /** YouTube "made for kids" flag. */
  madeForKids: boolean;
  /** Mature / 18+ content flag (Twitch, Kick, Facebook). */
  mature: boolean;
}

export const DEFAULT_BROADCAST_META: BroadcastMeta = {
  title: "",
  description: "",
  category: "",
  tags: [],
  language: "",
  visibility: "public",
  madeForKids: false,
  mature: false,
};

export type BroadcastFieldKind =
  | "text"
  | "textarea"
  | "tags"
  | "select"
  | "toggle";

export interface BroadcastFieldMeta {
  id: BroadcastFieldId;
  label: string;
  kind: BroadcastFieldKind;
  placeholder?: string;
  help?: string;
  /** Options for kind === "select". */
  options?: { value: string; label: string }[];
}

const LANGUAGE_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "Sin especificar" },
  { value: "es", label: "Español" },
  { value: "en", label: "English" },
  { value: "pt", label: "Português" },
  { value: "fr", label: "Français" },
  { value: "de", label: "Deutsch" },
  { value: "it", label: "Italiano" },
  { value: "ja", label: "日本語" },
  { value: "ko", label: "한국어" },
];

/** Render order + presentation for the composer. Every field in the superset
 *  appears regardless of which platforms the tenant has connected. */
export const BROADCAST_FIELDS: BroadcastFieldMeta[] = [
  {
    id: "title",
    label: "Título",
    kind: "text",
    placeholder: "Lo que se mostrará en vivo",
  },
  {
    id: "description",
    label: "Descripción",
    kind: "textarea",
    placeholder: "Describe tu transmisión",
  },
  {
    id: "category",
    label: "Categoría / Juego",
    kind: "text",
    placeholder: "Just Chatting, Minecraft…",
  },
  {
    id: "tags",
    label: "Etiquetas",
    kind: "tags",
    placeholder: "Escribe una etiqueta y pulsa Enter",
  },
  {
    id: "language",
    label: "Idioma",
    kind: "select",
    options: LANGUAGE_OPTIONS,
  },
  {
    id: "visibility",
    label: "Visibilidad",
    kind: "select",
    options: [
      { value: "public", label: "Pública" },
      { value: "unlisted", label: "Oculta (con enlace)" },
      { value: "private", label: "Privada" },
    ],
  },
  {
    id: "madeForKids",
    label: "Contenido para niños",
    kind: "toggle",
  },
  {
    id: "mature",
    label: "Contenido para adultos (18+)",
    kind: "toggle",
  },
];

/** Which broadcast fields each platform can actually consume. The composer
 *  uses this to show, per field, which connected channels will receive it. */
export const PLATFORM_FIELD_SUPPORT: Record<PlatformId, BroadcastFieldId[]> = {
  twitch: ["title", "category", "tags", "language", "mature"],
  youtube: [
    "title",
    "description",
    "category",
    "tags",
    "language",
    "visibility",
    "madeForKids",
  ],
  kick: ["title", "category", "mature"],
  facebook: ["title", "description", "mature"],
  tiktok: ["title"],
  instagram: [],
  restream: ["title"],
  custom_rtmp: ["title"],
  custom_srt: ["title"],
};

/** Platforms (in display order) that support a given broadcast field. */
export function platformsSupporting(field: BroadcastFieldId): PlatformId[] {
  return PLATFORM_ORDER.filter((p) =>
    PLATFORM_FIELD_SUPPORT[p].includes(field),
  );
}

/** Normalize an untrusted JSON blob (e.g. a freshly-added DB column that may be
 *  null on old rows) into a complete BroadcastMeta, falling back the title to
 *  the session's canonical title. */
export function normalizeBroadcastMeta(
  raw: unknown,
  fallbackTitle: string,
): BroadcastMeta {
  const m =
    raw && typeof raw === "object" ? (raw as Partial<BroadcastMeta>) : {};
  const visibility: Visibility =
    m.visibility === "unlisted" || m.visibility === "private"
      ? m.visibility
      : "public";
  return {
    title:
      typeof m.title === "string" && m.title.trim().length > 0
        ? m.title
        : fallbackTitle,
    description: typeof m.description === "string" ? m.description : "",
    category: typeof m.category === "string" ? m.category : "",
    tags: Array.isArray(m.tags)
      ? m.tags.filter((t): t is string => typeof t === "string")
      : [],
    language: typeof m.language === "string" ? m.language : "",
    visibility,
    madeForKids: m.madeForKids === true,
    mature: m.mature === true,
  };
}
