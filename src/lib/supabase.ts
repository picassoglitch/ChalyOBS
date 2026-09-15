/**
 * Single Supabase client instance — points at the same Chalyb
 * project (`uqcbziwdgbnzehipzjxp.supabase.co`) that ChalyClip + the web app
 * use, so ChalyOBS is just another engine sitting on top of Chalyb's auth
 * and `profiles` table.
 *
 * Anon key is public-by-design — safe to embed in the mobile bundle. RLS
 * policies on the Supabase side gate which rows each user can read/write.
 */
import "react-native-url-polyfill/auto";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  // Don't crash at module load — let consumers see the error when they
  // actually try to use it. This keeps Expo Go startup clean when env vars
  // are missing during onboarding a new dev.
  console.warn(
    "[supabase] EXPO_PUBLIC_SUPABASE_URL / _ANON_KEY missing. " +
      "Copy .env.local.example to .env.local and restart Metro.",
  );
}

export const supabase = createClient(
  SUPABASE_URL ?? "https://placeholder.supabase.co",
  SUPABASE_ANON_KEY ?? "placeholder",
  {
    auth: {
      storage: AsyncStorage,
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: false, // mobile — no URL fragment
      // PKCE is the right flow for native + deep links — the callback URL
      // returns ?code=... and we exchange it for a session. Explicit even
      // though it's the v2 default.
      flowType: "pkce",
    },
  },
);

export const supabaseConfigured = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

/** Slug ChalyOBS uses in Chalyb's engines registry. */
export const ENGINE_SLUG = process.env.EXPO_PUBLIC_ENGINE_SLUG ?? "chalybobs";
