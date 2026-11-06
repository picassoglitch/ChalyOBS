-- ChalybOBS — lock a stream's destination SET at authorize (Aldo, 2026-11-06)
--
-- chalybobs_streams.destination_ids: ids of the enabled destinations when
-- live/authorize admitted the stream. /api/internal/live/destinations (the
-- relay's poll) only returns these for that stream: one added mid-stream
-- starts on the next stream; one removed or disabled mid-stream may stop.
-- The price (0027 destinations) stays as admitted. NULL = admitted before
-- this column (keeps the live list until that stream ends).
--
-- Nullable, no default: metadata-only ALTER, no rewrite, no backfill.
-- Apply AFTER 0027 and BEFORE deploying the ChalybOBS web code that writes
-- it. Idempotent: re-runnable.

alter table public.chalybobs_streams
  add column if not exists destination_ids text[];
