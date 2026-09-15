import { supabase } from "@/lib/supabase";
import type { BackendClient } from "./client";
import type {
  HealthSample,
  ChalybSession,
  PlatformConnection,
  PlatformId,
  SubscriptionTier,
  UserRole,
} from "./types";

type ProfileRow = {
  id: string;
  email: string | null;
  full_name: string | null;
  avatar_url: string | null;
  preferred_locale: string | null;
  role: string | null;
  tier: string | null;
  org_id: string | null;
  selected_engine_id: string | null;
};

const ROLE_VALUES: ReadonlyArray<UserRole> = [
  "SUPER_ADMIN",
  "ADMIN",
  "OPERATOR",
  "EDITOR",
  "VIEWER",
  "CLIENT",
];
const TIER_VALUES: ReadonlyArray<SubscriptionTier> = [
  "FREE",
  "PRO",
  "PARTNER",
  "ALL_ACCESS",
];

function coerceRole(value: string | null): UserRole {
  return ROLE_VALUES.includes(value as UserRole) ? (value as UserRole) : "VIEWER";
}

function coerceTier(value: string | null): SubscriptionTier {
  return TIER_VALUES.includes(value as SubscriptionTier)
    ? (value as SubscriptionTier)
    : "FREE";
}

async function fetchProfile(userId: string): Promise<ProfileRow | null> {
  const { data, error } = await supabase
    .from("profiles")
    .select(
      "id, email, full_name, avatar_url, preferred_locale, role, tier, org_id, selected_engine_id",
    )
    .eq("id", userId)
    .maybeSingle();
  if (error) {
    console.warn("[supabase] profile fetch failed:", error.message);
    return null;
  }
  return data;
}

function profileToSession(
  userId: string,
  emailFallback: string | null,
  profile: ProfileRow | null,
): ChalybSession {
  return {
    userId,
    email: profile?.email ?? emailFallback,
    fullName: profile?.full_name ?? null,
    avatarUrl: profile?.avatar_url ?? null,
    preferredLocale:
      profile?.preferred_locale === "es" ? "es" : "en",
    role: coerceRole(profile?.role ?? null),
    tier: coerceTier(profile?.tier ?? null),
    orgId: profile?.org_id ?? null,
    selectedEngineId: profile?.selected_engine_id ?? null,
  };
}

/** Translate Supabase auth errors into Spanish-friendly user messages. */
function translateAuthError(message: string): string {
  const lower = message.toLowerCase();
  if (lower.includes("invalid login credentials")) {
    return "Correo o contraseña incorrectos.";
  }
  if (lower.includes("email not confirmed")) {
    return "Confirma tu correo antes de iniciar sesión.";
  }
  if (lower.includes("rate limit")) {
    return "Demasiados intentos. Espera unos minutos.";
  }
  return message;
}

/**
 * Talks to the Chalyb Supabase project. Profiles are read from
 * `public.profiles` — same row the Next.js shell + ChalyClip read.
 */
export class SupabaseBackend implements BackendClient {
  async signInWithPassword(
    email: string,
    password: string,
  ): Promise<ChalybSession> {
    const { data, error } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    });
    if (error) throw new Error(translateAuthError(error.message));
    if (!data.user) throw new Error("Sesión no devuelta por Supabase.");
    const profile = await fetchProfile(data.user.id);
    return profileToSession(data.user.id, data.user.email ?? null, profile);
  }

  async getCurrentSession(): Promise<ChalybSession | null> {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return null;
    const profile = await fetchProfile(user.id);
    return profileToSession(user.id, user.email ?? null, profile);
  }

  async signOut(): Promise<void> {
    await supabase.auth.signOut();
  }

  onAuthChange(handler: (session: ChalybSession | null) => void): () => void {
    const { data } = supabase.auth.onAuthStateChange(async (_event, sess) => {
      if (!sess?.user) {
        handler(null);
        return;
      }
      const profile = await fetchProfile(sess.user.id);
      handler(profileToSession(sess.user.id, sess.user.email ?? null, profile));
    });
    return () => data.subscription.unsubscribe();
  }

  // ---- Platform connections (Phase 0 mock until schema lands) -------------

  async listPlatformConnections(
    _userId: string,
  ): Promise<PlatformConnection[]> {
    // TODO(phase-1): real table on the Supabase side (`engine_chalybobs_connections`?).
    return [];
  }

  async upsertPlatformConnection(
    _userId: string,
    conn: PlatformConnection,
  ): Promise<PlatformConnection> {
    return conn;
  }

  async setPlatformEnabled(
    _userId: string,
    _platformId: PlatformId,
    _enabled: boolean,
  ): Promise<void> {
    // No-op in Phase 0.
  }

  async reportHealth(
    _sessionId: string,
    _sample: HealthSample,
  ): Promise<void> {
    // No-op in Phase 0; Phase 1 wires the real telemetry channel.
  }
}
