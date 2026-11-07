import "server-only";
import { cookies } from "next/headers";
import { readChalybEnv } from "./env";
import { SESSION_COOKIE_NAME, SessionClaims, verifySession } from "./session";
import { LANG_COOKIE, type Lang, normalizeLang } from "./locale";

/**
 * Read + verify the ChalyOBS session cookie in a Server Component / Server
 * Action. Returns the tenant claims or null (caller redirects to /login).
 * This is the single source of tenant identity for all data access.
 */
export async function getServerSession(): Promise<SessionClaims | null> {
  const env = readChalybEnv();
  if (!env) return null;
  const store = await cookies();
  const cookie = store.get(SESSION_COOKIE_NAME);
  if (!cookie?.value) return null;
  try {
    return await verifySession(cookie.value, env.sessionSecret);
  } catch {
    return null;
  }
}

/** The language the SSO launch left in the cookie (null = Spanish default). */
export async function getServerLang(): Promise<Lang | null> {
  const store = await cookies();
  return normalizeLang(store.get(LANG_COOKIE)?.value);
}
