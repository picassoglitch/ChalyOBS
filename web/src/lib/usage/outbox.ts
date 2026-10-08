import "server-only";
import { getSupabaseAdmin } from "@/lib/supabase";
import { getHubClient, type SettleOutcome, type UsageRequest } from "./hub";
import { drainOutbox, type DrainStats, type OutboxRow, type OutboxStore } from "./metering";

/**
 * Durable usage outbox (table chalybobs_usage_outbox, migration 0026).
 *
 * Events must survive restarts and Cloud Run scale-to-zero, so live/ended
 * writes the `stream.minutes` event and the reservation settle here first,
 * then drains. Anything the hub doesn't take is retried with backoff on the
 * next drain — triggered by every live/authorize + live/ended and by
 * POST /api/internal/usage/drain (point Cloud Scheduler at it).
 *
 * (kind, dedupe_key) is unique, so a relay retrying live/ended can't
 * double-enqueue; the hub's (engine, source_id) uniqueness makes a
 * re-delivered usage row a no-op too.
 */

const TABLE = "chalybobs_usage_outbox";

export interface OutboxInsert {
  tenantId: string;
  kind: "usage" | "settle";
  dedupeKey: string;
  reservationId: string | null;
  payload: UsageRequest | { reservation_id: string; outcome: SettleOutcome };
}

/** Insert rows, ignoring ones already enqueued. Returns false (and logs
 *  loudly) when the write failed — the caller has nothing durable then. */
export async function enqueueOutbox(rows: OutboxInsert[]): Promise<boolean> {
  if (rows.length === 0) return true;
  const db = getSupabaseAdmin();
  const { error } = await db.from(TABLE).upsert(
    rows.map((r) => ({
      tenant_id: r.tenantId,
      kind: r.kind,
      dedupe_key: r.dedupeKey,
      reservation_id: r.reservationId,
      payload: r.payload,
    })),
    { onConflict: "kind,dedupe_key", ignoreDuplicates: true },
  );
  if (error) {
    console.error(
      `[usage-outbox] ENQUEUE FAILED — usage will NOT reach the hub: ${error.message}`,
      JSON.stringify(rows),
    );
    return false;
  }
  return true;
}

const supabaseStore: OutboxStore = {
  async listPending(limit) {
    const db = getSupabaseAdmin();
    const { data, error } = await db
      .from(TABLE)
      .select("id, kind, reservation_id, payload, attempts, next_attempt_at")
      .eq("status", "pending")
      .order("id", { ascending: true })
      .limit(limit);
    if (error) {
      console.error(`[usage-outbox] list failed: ${error.message}`);
      return [];
    }
    return (data ?? []) as OutboxRow[];
  },
  async claim(id, now, leaseUntil) {
    // One conditional UPDATE: Postgres re-checks the WHERE under the row
    // lock, so of two drains racing for the same row only one gets it.
    const { data, error } = await getSupabaseAdmin()
      .from(TABLE)
      .update({ next_attempt_at: leaseUntil.toISOString() })
      .eq("id", id)
      .eq("status", "pending")
      .lte("next_attempt_at", now.toISOString())
      .select("id");
    if (error) {
      console.error(`[usage-outbox] claim failed id=${id}: ${error.message}`);
      return false;
    }
    return (data ?? []).length === 1;
  },
  async markSent(id, attempts) {
    await getSupabaseAdmin()
      .from(TABLE)
      .update({ status: "sent", attempts, sent_at: new Date().toISOString(), last_error: null })
      .eq("id", id);
  },
  async markRetry(id, attempts, nextAttemptAt, error) {
    await getSupabaseAdmin()
      .from(TABLE)
      .update({ attempts, next_attempt_at: nextAttemptAt.toISOString(), last_error: error })
      .eq("id", id)
      .eq("status", "pending");
  },
  async markDead(id, attempts, error) {
    await getSupabaseAdmin()
      .from(TABLE)
      .update({ status: "dead", attempts, last_error: error })
      .eq("id", id)
      .eq("status", "pending");
  },
};

/** Deliver pending rows to the hub. No-op when CHALYB_BASE_URL is unset
 *  (rows stay pending until a hub is configured). Never throws. */
export async function drainUsageOutbox(limit = 50): Promise<DrainStats | null> {
  const { client, misconfigured } = getHubClient();
  if (!client) {
    if (misconfigured) {
      console.error(
        "[usage-outbox] CHALYB_BASE_URL is set but CHALYBOBS_ADMIN_TOKEN/CHALYB_ADMIN_TOKEN is not — usage is piling up undelivered",
      );
    }
    return null;
  }
  try {
    return await drainOutbox(
      supabaseStore,
      async (row) => {
        if (row.kind === "settle") {
          const p = row.payload as { reservation_id: string; outcome: SettleOutcome };
          return client.settle(p.reservation_id, p.outcome);
        }
        return client.reportUsage(row.payload as UsageRequest);
      },
      { limit },
    );
  } catch (e) {
    console.error(`[usage-outbox] drain crashed: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}
