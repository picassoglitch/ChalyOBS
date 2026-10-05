-- ChalybOBS — usage caps + metering against the Chalyb hub
--
-- Implements the engine side of docs/engines/consumption-contract.md (chalyb):
--
--   chalybobs_streams        one row per stream session (stream_id minted in
--                            live/authorize). Holds the hub reservation the
--                            session was admitted under; live/ended reads it
--                            to report stream.minutes and settle.
--   chalybobs_usage_outbox   durable outbox of hub calls (usage events +
--                            reservation settles), drained with backoff so
--                            spend survives restarts / scale-to-zero.
--   chalybobs_sessions.tier  tier last delivered by Chalyb (SSO launch or
--                            tenant provisioning). Relay callbacks carry no
--                            cookie, so live/started|ended re-check this
--                            before forwarding to ChalyClip.
--
-- Apply in the schema repo (chalyb, alongside 0023-0025) BEFORE deploying the
-- ChalybOBS web code that reads these tables. Idempotent: re-runnable.

alter table public.chalybobs_sessions
  add column if not exists tier text,
  add column if not exists tier_updated_at timestamptz;

create table if not exists public.chalybobs_streams (
  stream_id      text primary key,           -- <tenant_id>__<random>
  tenant_id      text not null,
  reservation_id text,                       -- hub reservation; null = unmetered (dev)
  lane           text,
  admitted_at    timestamptz not null default now(),
  started_at     timestamptz,
  ended_at       timestamptz,
  duration_s     integer
);

create index if not exists chalybobs_streams_tenant_idx
  on public.chalybobs_streams (tenant_id);

create table if not exists public.chalybobs_usage_outbox (
  id              bigint generated always as identity primary key,
  tenant_id       text not null,
  kind            text not null check (kind in ('usage', 'settle')),
  dedupe_key      text not null,              -- stream.minutes:<stream_id> | settle:<reservation>:<outcome>
  reservation_id  text,
  payload         jsonb not null,             -- exact body POSTed to the hub
  status          text not null default 'pending'
                    check (status in ('pending', 'sent', 'dead')),
  attempts        integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_error      text,
  created_at      timestamptz not null default now(),
  sent_at         timestamptz,
  unique (kind, dedupe_key)
);

create index if not exists chalybobs_usage_outbox_pending_idx
  on public.chalybobs_usage_outbox (id)
  where status = 'pending';

-- Service-role only (bypasses RLS); no anon/auth policy.
alter table public.chalybobs_streams       enable row level security;
alter table public.chalybobs_usage_outbox  enable row level security;
