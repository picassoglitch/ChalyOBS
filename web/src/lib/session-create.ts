// Which session the first-access create hands back. Never a key the DB doesn't
// hold: the relay would refuse it as unknown_stream_key (2026-11-07 Osmo incident).
export class SessionCreateError extends Error {
  constructor(tenantId: string, cause: string) {
    super(`chalybobs_sessions create failed for tenant ${tenantId}: ${cause}`);
    this.name = "SessionCreateError";
  }
}

export function settleSessionInsert<T>(r: {
  tenantId: string;
  insertError: { message: string } | null;
  stored: T | null;
  fresh: T;
}): T {
  if (!r.insertError) return r.fresh;
  if (r.stored) return r.stored;
  throw new SessionCreateError(r.tenantId, r.insertError.message);
}
