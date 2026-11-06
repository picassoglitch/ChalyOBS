-- ChalybOBS — release a hold the relay never used (2026-11-06)
--
-- chalybobs_streams.aborted_at: set by /api/internal/live/abort when the
-- relay authorized a publish but the publisher was gone (or the relay could
-- not confirm it) before 'started'. The hold is settled 'cancelled' (no
-- usage) and ended_at is set too, so a stray live/ended or an authorize
-- retry can't bill or reuse the stream. Only a stream that never started can
-- be aborted.
--
-- Additive nullable column: metadata-only, no rewrite, no backfill.
-- Apply AFTER 0030 and BEFORE deploying the web code that uses it.
-- Idempotent: re-runnable.

alter table public.chalybobs_streams
  add column if not exists aborted_at timestamptz;
