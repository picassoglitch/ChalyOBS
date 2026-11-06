-- ChalybOBS — tie authorize retries to ONE relay publish attempt (2026-11-06)
--
-- The relay sends attempt_key with live/authorize, stable across its retries
-- for one publish. (tenant_id, attempt_key) is unique, so the first call
-- claims it atomically (insert ... on conflict do nothing) and admits; a
-- retry with the same key takes that stream over once (reused_at, set by a
-- conditional update). A different key is a different publish: new stream,
-- new admission under the caps. authorizing = row claimed, admission running
-- (admitted_at is the claim time; a claim older than the lease is stale and
-- a retry may take it over). authorize_error = the admission threw; a retry
-- may take the row over and admit again with the SAME stream_id (the hub
-- admit is idempotent per external_job_id, so no second hold).
--
-- Additive: nullable columns + a NOT NULL boolean with a constant default
-- (metadata-only on PG 11+). The unique constraint builds an index on
-- chalybobs_streams (one row per stream, small): brief write lock only.
-- NULL attempt_key (old relay, legacy rows) never conflicts.
-- Apply AFTER 0028 and BEFORE deploying the web code that uses it.
-- Idempotent: re-runnable.

alter table public.chalybobs_streams
  add column if not exists attempt_key text,
  add column if not exists authorizing boolean not null default false,
  add column if not exists reused_at timestamptz,
  add column if not exists authorize_error text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'chalybobs_streams_tenant_attempt_key'
      and conrelid = 'public.chalybobs_streams'::regclass
  ) then
    alter table public.chalybobs_streams
      add constraint chalybobs_streams_tenant_attempt_key unique (tenant_id, attempt_key);
  end if;
end $$;
