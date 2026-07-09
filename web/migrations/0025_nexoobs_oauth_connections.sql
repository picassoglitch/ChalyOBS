-- NexoOBS — OAuth auto-connect (Restream-style) for platform destinations
--
-- Connecting a platform via OAuth (Kick first; Twitch/YouTube follow the same
-- shape) replaces manual ingest-URL + stream-key entry: the callback fetches
-- the channel's stream endpoint with the granted token and fills the row.
--
--   oauth_token          (existing, 0023) now holds the ACCESS token
--   oauth_refresh_token  refresh token — long-lived credential used to mint
--                        fresh access tokens for metadata pushes / key re-sync
--   oauth_expires_at     access-token expiry; refresh when past/near it
--   oauth_scopes         space-separated scopes actually granted, so we can
--                        detect connections made before a scope was added
--
-- Apply in the schema repo (nexo-ai, alongside 0023/0024) BEFORE deploying
-- the NexoOBS web code that reads these columns.

alter table public.nexoobs_destinations
  add column if not exists oauth_refresh_token text not null default '',
  add column if not exists oauth_expires_at timestamptz,
  add column if not exists oauth_scopes text not null default '';
