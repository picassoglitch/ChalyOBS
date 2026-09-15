import "server-only";
import { cookies } from "next/headers";
import { readChalybEnv } from "./env";
import { SESSION_COOKIE_NAME, SessionClaims, verifySession } from "./session";

/**
 * Read + verify the ChalybOBS session cookie in a Server Component / Server
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
