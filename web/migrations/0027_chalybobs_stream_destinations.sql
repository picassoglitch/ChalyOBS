-- ChalybOBS — lock a stream's fan-out price at authorize (Aldo, 2026-11-06)
--
-- chalybobs_streams.destinations: enabled destinations when live/authorize
-- admitted the stream. Admission reserves for this many copies and
-- live/ended bills the same count; mid-stream destination changes don't
-- change the price. NULL = admitted before this column (billed as 1 copy).
--
-- Nullable, no default: metadata-only ALTER, no rewrite, no backfill.
-- Apply in the schema repo (chalyb) BEFORE deploying the ChalybOBS web code
-- that writes it. Idempotent: re-runnable.

alter table public.chalybobs_streams
  add column if not exists destinations integer
    check (destinations is null or destinations >= 0);
