// Supabase key kind from its shape alone (prefix or legacy-JWT role claim).

export type SupabaseKeyKind =
  | "secret" // sb_secret_…
  | "service_role" // legacy JWT, role service_role
  | "publishable" // sb_publishable_…
  | "anon" // legacy JWT, role anon / authenticated
  | "unknown";

export function supabaseKeyKind(key: string): SupabaseKeyKind {
  const k = key.trim();
  if (k.startsWith("sb_secret_")) return "secret";
  if (k.startsWith("sb_publishable_")) return "publishable";
  const parts = k.split(".");
  if (parts.length === 3) {
    try {
      const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
      const claims = JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as {
        role?: unknown;
      };
      if (claims.role === "service_role") return "service_role";
      if (claims.role === "anon" || claims.role === "authenticated") return "anon";
    } catch {
      // not a JWT
    }
  }
  return "unknown";
}

// Anon-role key: RLS hides every chalybobs_* row and refuses inserts (2026-11-07 Osmo
// incident). Unknown shapes pass; the DB answers for those.
export function isLowPrivilegeKey(key: string): boolean {
  const kind = supabaseKeyKind(key);
  return kind === "publishable" || kind === "anon";
}
