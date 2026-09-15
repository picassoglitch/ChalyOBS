import { SupabaseBackend } from "./supabase-backend";
import type { BackendClient } from "./client";

/** Default backend: Supabase against the Chalyb project. */
export const backend: BackendClient = new SupabaseBackend();

export type { BackendClient } from "./client";
export type {
  HealthSample,
  ChalybSession,
  OperatorRole,
  PlatformConnection,
  PlatformId,
  Permissions,
  SubscriptionTier,
  UserRole,
} from "./types";
export { defaultPermissions } from "./types";
