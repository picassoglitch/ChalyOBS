/**
 * Chalyb hub consumption client — admit / settle / usage.
 *
 * Contract: chalyb docs/engines/consumption-contract.md (authoritative).
 * Base: {CHALYB_BASE_URL}/api/engines/chalybobs, bearer = our engine admin
 * token (the same CHALYBOBS_ADMIN_TOKEN / CHALYB_ADMIN_TOKEN pair env.ts
 * accepts for the hub → engine admin calls; the token is shared both ways).
 *
 * Deliberately dependency-free (no "server-only", no @/ imports) so the unit
 * tests can load it under plain `node --test`. Only server code imports it.
 *
 * Env:
 *   CHALYB_BASE_URL   hub origin (e.g. https://chalyb.com). Unset = dev:
 *                     getHubClient() returns null and callers skip metering.
 *   CHALYBOBS_ADMIN_TOKEN (or CHALYB_ADMIN_TOKEN)  bearer
 */

export const ENGINE_SLUG = "chalybobs";

/** Per-attempt cap. Admit sits on the relay's publish path, so keep it short. */
const DEFAULT_TIMEOUT_MS = 5000;

export interface AdmitRequest {
  external_user_id: string;
  external_job_id: string;
  class: "job" | "stream";
  operation: string;
  est_tokens: number;
  upload_mb: number;
  source_minutes: number;
  storage_mb_after: number;
  boost: boolean | null;
  ttl_seconds: number;
}

export interface AdmitResponse {
  ok?: boolean;
  allowed: boolean;
  reservation_id?: string;
  lane?: "standard" | "boost";
  boost_fee_tokens?: number;
  reason?: string;
  limits?: Record<string, unknown>;
  balance?: Record<string, unknown>;
}

export type SettleOutcome = "succeeded" | "failed" | "cancelled" | "heartbeat";

export interface UsageEvent {
  kind: string;
  provider?: string;
  amount: number;
  cost_usd_micros: number;
  source_id: string;
  occurred_at: string;
  operation?: string;
  reservation_id?: string;
  metadata?: Record<string, unknown>;
}

export interface UsageRequest {
  external_user_id: string;
  events: UsageEvent[];
}

/** Every call resolves (never throws): either the parsed 2xx body, or a
 *  failure tagged with the HTTP status (undefined = network/timeout). */
export type HubResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status?: number; message: string };

export interface HubConfig {
  baseUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface HubClient {
  admit(body: AdmitRequest): Promise<HubResult<AdmitResponse>>;
  settle(
    reservationId: string,
    outcome: SettleOutcome,
  ): Promise<HubResult<Record<string, unknown>>>;
  reportUsage(body: UsageRequest): Promise<HubResult<Record<string, unknown>>>;
}

export function createHubClient(config: HubConfig): HubClient {
  const base = `${config.baseUrl.replace(/\/+$/, "")}/api/engines/${ENGINE_SLUG}`;
  const doFetch = config.fetchImpl ?? fetch;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function post<T>(path: string, body: unknown): Promise<HubResult<T>> {
    let res: Response;
    try {
      res = await doFetch(`${base}${path}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        cache: "no-store",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
    let text = "";
    try {
      text = await res.text();
    } catch {
      // Body unreadable — status alone decides.
    }
    if (!res.ok) {
      return { ok: false, status: res.status, message: text.slice(0, 500) };
    }
    try {
      return { ok: true, status: res.status, data: (text ? JSON.parse(text) : {}) as T };
    } catch {
      return { ok: false, status: res.status, message: "invalid_json_response" };
    }
  }

  return {
    admit: (body) => post<AdmitResponse>("/usage/admit", body),
    settle: (reservationId, outcome) =>
      post("/usage/settle", { reservation_id: reservationId, outcome }),
    reportUsage: (body) => post("/usage", body),
  };
}

type HubEnv = Record<string, string | undefined>;

/** Hub base URL, or null when unset (dev / standalone). */
export function hubBaseUrl(env: HubEnv = process.env): string | null {
  const v = env.CHALYB_BASE_URL?.trim();
  return v ? v.replace(/\/+$/, "") : null;
}

/** Engine bearer for the hub. Same precedence as env.ts adminTokenEnv(). */
function hubToken(env: HubEnv): string | null {
  return env.CHALYBOBS_ADMIN_TOKEN || env.CHALYB_ADMIN_TOKEN || null;
}

/**
 * Client from env.
 *   - CHALYB_BASE_URL unset         → { client: null, misconfigured: false } (dev: skip metering)
 *   - base set but no bearer token  → { client: null, misconfigured: true }  (callers fail closed)
 */
export function getHubClient(env: HubEnv = process.env): {
  client: HubClient | null;
  misconfigured: boolean;
} {
  const baseUrl = hubBaseUrl(env);
  if (!baseUrl) return { client: null, misconfigured: false };
  const token = hubToken(env);
  if (!token) return { client: null, misconfigured: true };
  return { client: createHubClient({ baseUrl, token }), misconfigured: false };
}
