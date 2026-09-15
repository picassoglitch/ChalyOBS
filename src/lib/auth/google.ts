/**
 * Google sign-in via Supabase OAuth + Expo's deep-link round-trip.
 *
 *   1. supabase.auth.signInWithOAuth({ provider: 'google' }) returns a URL
 *      pointing at Google's consent screen with the right state + PKCE
 *      challenge.
 *   2. expo-web-browser opens that URL in an in-app browser session and
 *      waits for the redirectTo URI to be hit.
 *   3. Google → Supabase → our scheme. Supabase appends `?code=...` to the
 *      callback. We pull the code and exchangeCodeForSession() to land a
 *      live session in the supabase-js client — onAuthStateChange in our
 *      SessionProvider then hydrates the rest of the app.
 *
 * The redirect URI is derived per-runtime:
 *   - Expo Go:     `exp://<host>:<port>/--/auth/callback`
 *   - Dev client:  `chalybobs://auth/callback`
 *   - Standalone:  `chalybobs://auth/callback`
 *
 * The matching URLs MUST be in the Supabase project's Auth → URL
 * Configuration → Redirect URLs allowlist. See README §Google OAuth setup.
 */
import * as Linking from "expo-linking";
import * as WebBrowser from "expo-web-browser";
import { supabase } from "../supabase";

WebBrowser.maybeCompleteAuthSession();

export async function signInWithGoogle(): Promise<void> {
  const redirectTo = Linking.createURL("auth/callback");

  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: {
      redirectTo,
      skipBrowserRedirect: true,
    },
  });
  if (error) throw new Error(translateOAuthError(error.message));
  if (!data.url) throw new Error("Supabase no devolvió URL de OAuth");

  const result = await WebBrowser.openAuthSessionAsync(data.url, redirectTo);

  if (result.type === "cancel" || result.type === "dismiss") {
    throw new Error("Inicio de sesión cancelado");
  }
  if (result.type !== "success") {
    throw new Error("OAuth no completó (resultado inesperado)");
  }

  // PKCE branch — Supabase appends ?code=... to the callback URL.
  const { code, fragmentTokens } = parseCallbackUrl(result.url);
  if (code) {
    const { error: exchangeErr } = await supabase.auth.exchangeCodeForSession(code);
    if (exchangeErr) throw new Error(translateOAuthError(exchangeErr.message));
    return;
  }

  // Implicit-flow fallback — older Supabase config returns tokens in the
  // URL fragment. Keep this branch so older project setups don't dead-end.
  if (fragmentTokens) {
    const { error: setErr } = await supabase.auth.setSession(fragmentTokens);
    if (setErr) throw new Error(translateOAuthError(setErr.message));
    return;
  }

  throw new Error("La URL de callback no contiene tokens ni código");
}

interface FragmentTokens {
  access_token: string;
  refresh_token: string;
}

function parseCallbackUrl(callbackUrl: string): {
  code: string | null;
  fragmentTokens: FragmentTokens | null;
} {
  // We can't always rely on URL standard library quirks across RN platforms;
  // hand-roll a tolerant parser for both query (?code=) and fragment
  // (#access_token=&refresh_token=).
  const queryIdx = callbackUrl.indexOf("?");
  const fragIdx = callbackUrl.indexOf("#");

  let code: string | null = null;
  if (queryIdx >= 0) {
    const queryEnd = fragIdx > queryIdx ? fragIdx : callbackUrl.length;
    const params = new URLSearchParams(callbackUrl.slice(queryIdx + 1, queryEnd));
    code = params.get("code");
  }

  let fragmentTokens: FragmentTokens | null = null;
  if (fragIdx >= 0) {
    const fragment = callbackUrl.slice(fragIdx + 1);
    const params = new URLSearchParams(fragment);
    const access_token = params.get("access_token");
    const refresh_token = params.get("refresh_token");
    if (access_token && refresh_token) {
      fragmentTokens = { access_token, refresh_token };
    }
  }

  return { code, fragmentTokens };
}

function translateOAuthError(msg: string): string {
  const lower = msg.toLowerCase();
  if (lower.includes("user cancelled") || lower.includes("cancelled")) {
    return "Inicio de sesión cancelado";
  }
  if (lower.includes("redirect")) {
    return `URL de redirect no permitida. Añade el callback al allowlist en Supabase. (${msg})`;
  }
  return msg;
}
