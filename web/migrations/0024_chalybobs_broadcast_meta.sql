-- ChalybOBS — broadcast-metadata composer ("Update Titles")
--
-- Adds a single JSON blob to each tenant's session row holding the full
-- composer state: title, description, category, tags[], language, visibility,
-- madeForKids, mature. The title is still mirrored to chalybobs_sessions.title
-- and every chalybobs_destinations.stream_title (the relay fan-out and channel
-- rows read those), so this column is purely additive.
--
-- Each platform consumes only the subset of fields it supports at publish time
-- (see PLATFORM_FIELD_SUPPORT in web/src/lib/destinations.ts).
--
-- Apply this in the schema repo (chalyb, alongside migration 0023) BEFORE
-- deploying the ChalybOBS web code that reads/writes broadcast_meta.

alter table public.chalybobs_sessions
  add column if not exists broadcast_meta jsonb not null default '{}'::jsonb;
