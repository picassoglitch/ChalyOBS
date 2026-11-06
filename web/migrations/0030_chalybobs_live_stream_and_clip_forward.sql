-- ChalybOBS — per-stream live flag and one ChalyClip hand-off (2026-11-06)
--
-- chalybobs_sessions.live_stream_id: the stream live/started put live. A
-- (retried, late) live/ended for an older stream only clears is_live while
-- it still names that stream, so it can't take a newer stream offline.
-- NULL = went live before this column (cleared as before).
--
-- chalybobs_streams.clip_forwarded_at: set when live/ended handed the end to
-- ChalyClip successfully, so a relay retry of live/ended doesn't start a
-- second clip run (ChalyClip resets a processed stream on a repeat 'ended').
--
-- Additive nullable columns: metadata-only, no rewrite, no backfill.
-- Apply AFTER 0029 and BEFORE deploying the web code that uses them.
-- Idempotent: re-runnable.

alter table public.chalybobs_sessions
  add column if not exists live_stream_id text;

alter table public.chalybobs_streams
  add column if not exists clip_forwarded_at timestamptz;
