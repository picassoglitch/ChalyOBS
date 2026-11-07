// Hub PR #174 passes `lang` on the SSO launch ("Visible text only", Aldo 2026-11-07);
// Spanish stays the default, so its text and URLs are unchanged.

export type Lang = "es" | "en";

/** Remembers the SSO `lang` on the engine's domain for later hops to the hub. */
export const LANG_COOKIE = "chalyb_lang";
export const LANG_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

/** "en", "en-US", "EN" → "en"; "es", "es-MX" → "es"; anything else → null. */
export function normalizeLang(raw: string | null | undefined): Lang | null {
  if (!raw) return null;
  const base = raw.trim().toLowerCase().replace("_", "-").split("-")[0];
  return base === "en" || base === "es" ? base : null;
}

/** The first en/es entry of an Accept-Language header, in the header's order. */
export function langFromAcceptLanguage(header: string | null | undefined): Lang | null {
  if (!header) return null;
  for (const part of header.split(",")) {
    const lang = normalizeLang(part.split(";")[0]);
    if (lang) return lang;
  }
  return null;
}

/** The title a new session starts with (also pushed to YouTube/Twitch/Kick). */
export function defaultStreamTitle(lang: Lang | null | undefined): string {
  return lang === "en" ? "My live stream" : "Mi transmisión en vivo";
}

/** A hub path in `lang`: the hub's English pages live under /en. */
export function hubPath(path: string, lang: Lang | null | undefined): string {
  return lang === "en" ? `/en${path}` : path;
}
