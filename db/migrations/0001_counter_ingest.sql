-- 0001_counter_ingest.sql
-- People-counter ingest: registered devices, their hashed secrets, raw
-- payloads (staging), interval readings and an ingest audit trail.
--
-- Rules (see docs/adr/0003-counter-ingest.md and docs/data-dictionary.md):
--   * Every table carries venue_id so row-level security can scope by venue.
--   * Timestamps are timestamptz in UTC. Trading-day assignment happens later,
--     by joining interval_start/interval_end to the trading-day model.
--   * A reading is unique on (device_id, entry_point_id, interval_start,
--     interval_end). Re-sent data is a duplicate; different counts for the
--     same key are a conflict, recorded in counter_ingest_events.
--   * Never edit this file after merge. Change the schema in a new migration.
--
-- Written for PostgreSQL 15+ (Supabase). Tested in CI with PGlite.

begin;

-- Devices ---------------------------------------------------------------------

create table counter_devices (
  device_id          text        primary key
                                 check (device_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$'),
  provider           text        not null check (provider ~ '^[a-z0-9_-]{1,32}$'),
  venue_id           text        not null check (length(venue_id) between 1 and 64),
  entry_point_id     text        not null check (length(entry_point_id) between 1 and 64),
  -- Optional per-line entry points: {"2": "side-door"}. See resolveEntryPointId.
  line_entry_points  jsonb       not null default '{}'::jsonb
                                 check (jsonb_typeof(line_entry_points) = 'object'),
  -- Vendor serial number. When set, payloads must carry the same serial.
  vendor_serial      text        check (vendor_serial is null or length(vendor_serial) between 1 and 64),
  active             boolean     not null default true,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  -- Lets child tables check that their venue_id matches the device's.
  unique (device_id, venue_id)
);

comment on table counter_devices is
  'People counters allowed to post to /api/ingest/counters/<provider>. Deactivate rather than delete.';

-- Secrets live in their own table so that no future read policy on devices can
-- expose them. Two hashes only while a secret is being rotated.
create table counter_device_credentials (
  device_id      text        primary key,
  venue_id       text        not null,
  secret_hashes  text[]      not null
                             check (cardinality(secret_hashes) between 1 and 2
                                    and array_position(secret_hashes, null) is null),
  updated_at     timestamptz not null default now(),
  -- Every element is an encoded scrypt hash (apps/web/lib/ingest/secrets.ts):
  -- scrypt$v=1$n=<N>,r=<r>,p=<p>$<16-byte salt, base64url>$<32-byte hash, base64url>.
  -- A pasted secret, or anything else, is refused. At most two elements
  -- (checked above), indexed from 1.
  constraint counter_device_credentials_scrypt_format check (
    array_lower(secret_hashes, 1) = 1
    and secret_hashes[1] ~ '^scrypt\$v=1\$n=[0-9]{1,7},r=[0-9]{1,2},p=[0-9]\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$'
    and (cardinality(secret_hashes) < 2
         or secret_hashes[2] ~ '^scrypt\$v=1\$n=[0-9]{1,7},r=[0-9]{1,2},p=[0-9]\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$')
  ),
  foreign key (device_id, venue_id) references counter_devices (device_id, venue_id)
    on update cascade on delete cascade
);

comment on table counter_device_credentials is
  'scrypt hashes of device secrets (never the secrets). Server-side only: no policy may ever grant read access.';

-- Raw payloads (staging) ------------------------------------------------------

create table counter_raw_payloads (
  id             bigint      generated always as identity primary key,
  venue_id       text        not null,
  device_id      text        not null,
  provider       text        not null,
  payload_hash   text        not null check (payload_hash ~ '^[0-9a-f]{64}$'),
  payload        jsonb       not null,
  received_at    timestamptz not null,
  parse_status   text        not null check (parse_status in ('mapped', 'rejected')),
  error_code     text        check (error_code is null or error_code ~ '^[a-z_]{1,40}$'),
  -- About the stored payload, not from it. {"stripped_keys": [...]}: names of
  -- the keys data minimisation removed before storage (device and SIM
  -- identifiers such as network_info, device_mac, ip_address). Never values.
  metadata       jsonb       not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  foreign key (device_id, venue_id) references counter_devices (device_id, venue_id)
    on update cascade on delete restrict,
  -- The same body re-sent by the device is stored once. payload_hash is over
  -- the exact bytes received (before minimisation), so re-sends still match.
  unique (device_id, payload_hash)
);

comment on table counter_raw_payloads is
  'Request bodies as received minus device and SIM identifiers, so a mapping bug can be fixed and replayed without asking the device to resend.';

-- Readings --------------------------------------------------------------------

create table counter_readings (
  id                  bigint      generated always as identity primary key,
  venue_id            text        not null,
  device_id           text        not null,
  entry_point_id      text        not null check (length(entry_point_id) between 1 and 80),
  source_line         text        not null check (length(source_line) between 1 and 16),
  interval_start      timestamptz not null,
  interval_end        timestamptz not null,
  count_in            integer     not null check (count_in >= 0),
  count_out           integer     not null check (count_out >= 0),
  occupancy           integer     check (occupancy is null or occupancy >= 0),
  device_reported_at  timestamptz not null,
  received_at         timestamptz not null,
  raw_payload_hash    text        not null,
  -- 'late': buffered data that arrived well after its interval (still counted).
  clock_flag          text        check (clock_flag is null or clock_flag in ('late')),
  -- Starts at 1; +1 each time a conflicting re-send replaces the counts.
  revision            integer     not null default 1 check (revision >= 1),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  check (interval_end > interval_start),
  -- Longest interval accepted (MAX_READING_INTERVAL_HOURS in repository.ts);
  -- also bounds the overlap lookup.
  check (interval_end - interval_start <= interval '24 hours'),
  foreign key (device_id, venue_id) references counter_devices (device_id, venue_id)
    on update cascade on delete restrict,
  foreign key (device_id, raw_payload_hash) references counter_raw_payloads (device_id, payload_hash)
    on delete restrict,
  constraint counter_readings_natural_key
    unique (device_id, entry_point_id, interval_start, interval_end)
);

create index counter_readings_venue_interval_idx
  on counter_readings (venue_id, interval_start);

comment on table counter_readings is
  'One row per device, entry point and interval. Times in UTC; trading day is assigned by a later join.';

-- Ingest events (audit) -------------------------------------------------------

create table counter_ingest_events (
  id           bigint      generated always as identity primary key,
  venue_id     text        not null,
  device_id    text        not null,
  event_type   text        not null check (event_type in (
                 'request',
                 'reading_conflict',
                 'reading_rejected_clock',
                 'device_alarm',
                 'payload_rejected',
                 'device_mismatch',
                 'overlap_detected'
               )),
  occurred_at  timestamptz not null default now(),
  -- Fixed vocabulary, ids, timestamps and counts. Never payload text or secrets.
  detail       jsonb       not null default '{}'::jsonb check (jsonb_typeof(detail) = 'object'),
  foreign key (device_id, venue_id) references counter_devices (device_id, venue_id)
    on update cascade on delete restrict
);

create index counter_ingest_events_device_time_idx
  on counter_ingest_events (device_id, occurred_at);

comment on table counter_ingest_events is
  'What happened on each authenticated ingest request: counts, conflicts, clock rejections, device alarms.';

-- Row-level security ----------------------------------------------------------
--
-- Enabled on every table with NO policies yet, so the Supabase `anon` and
-- `authenticated` roles can read and write nothing. The ingest endpoint
-- connects server-side as the table owner, which bypasses RLS (RLS is not
-- forced). Devices never connect to the database.
--
-- TODO(auth PR): add read policies for the Supabase Auth model planned in
-- CLAUDE.md (Supabase Auth JWT, `auth.uid()`, a venue membership table with a
-- role of owner/manager/supervisor/staff). Sketch, not applied:
--
--   create policy counter_readings_read on counter_readings
--     for select to authenticated
--     using (venue_id in (
--       select m.venue_id from venue_memberships m where m.user_id = auth.uid()
--     ));
--
--   Same pattern for counter_devices (managers and owners only),
--   counter_ingest_events (owners only) and counter_raw_payloads (no app
--   access; operators only). counter_device_credentials gets no policy, ever.

alter table counter_devices             enable row level security;
alter table counter_device_credentials  enable row level security;
alter table counter_raw_payloads        enable row level security;
alter table counter_readings            enable row level security;
alter table counter_ingest_events       enable row level security;

-- Supabase grants table and sequence privileges to anon/authenticated by
-- default. Take them away here so access depends on explicit grants plus
-- policies, not on RLS alone. That includes the identity sequences behind the
-- id columns, so those roles cannot read or advance them either. Skipped where
-- the roles do not exist (plain PostgreSQL, PGlite).
do $$
declare
  role_name text;
begin
  foreach role_name in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = role_name) then
      execute format(
        'revoke all on table counter_devices, counter_device_credentials, counter_raw_payloads, '
        'counter_readings, counter_ingest_events from %I', role_name);
      execute format(
        'revoke all on sequence %s, %s, %s from %I',
        pg_get_serial_sequence('counter_raw_payloads', 'id'),
        pg_get_serial_sequence('counter_readings', 'id'),
        pg_get_serial_sequence('counter_ingest_events', 'id'),
        role_name);
    end if;
  end loop;
end
$$;

commit;
