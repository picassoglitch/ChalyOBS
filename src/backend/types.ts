/**
 * Types mirror the Chalyb schema (Supabase `profiles` table) so this
 * mobile engine reads the same rows the Next.js shell + ChalybClip do.
 *
 *   public.profiles
 *     id uuid primary key references auth.users(id) on delete cascade
 *     email text
 *     full_name text
 *     avatar_url text
 *     preferred_locale text ('en' | 'es')
 *     role text       — UserRole (see below)
 *     tier text       — SubscriptionTier (see below)
 *     org_id uuid
 *     selected_engine_id text   — slug ('chalybclip', 'chalybobs', …)
 *
 * The "Role" the user picks INSIDE ChalybOBS (Streamer vs Camera Operator) is
 * stored locally only — it's session-scoped, not a Chalyb platform concept.
 */

export type UserRole =
  | "SUPER_ADMIN"
  | "ADMIN"
  | "OPERATOR"
  | "EDITOR"
  | "VIEWER"
  | "CLIENT";

export type SubscriptionTier = "FREE" | "PRO" | "PARTNER" | "ALL_ACCESS";

/** Session info read from Supabase auth + the joined `profiles` row. */
export interface ChalybSession {
  /** Supabase auth user id (= profiles.id). */
  userId: string;
  email: string | null;
  fullName: string | null;
  avatarUrl: string | null;
  preferredLocale: "en" | "es";
  role: UserRole;
  tier: SubscriptionTier;
  orgId: string | null;
  /** Engine slug the user selected as their LIVE engine (PRO tier). */
  selectedEngineId: string | null;
}

/** Local-only choice: which mode of ChalybOBS are you running right now. */
export type OperatorRole = "streamer" | "operator";

export type PlatformId =
  | "kick"
  | "twitch"
  | "youtube"
  | "tiktok"
  | "restream"
  | "custom_rtmp"
  | "custom_srt";

export interface PlatformConnection {
  platformId: PlatformId;
  handle: string;
  hasAuth: boolean;
  connectedAt: number;
}

export interface Permissions {
  chatReplyAllowed: boolean;
  streamControlAllowed: boolean;
  destinationSwitchAllowed: boolean;
}

export const defaultPermissions: Permissions = {
  chatReplyAllowed: false,
  streamControlAllowed: false,
  destinationSwitchAllowed: false,
};

export interface HealthSample {
  ts: number;
  bitrateKbps: number;
  fps: number;
  droppedFrames: number;
  rttMs: number;
  batteryPct: number;
}
