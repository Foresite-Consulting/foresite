# Milesight VS13x people counter (VS135 4G first): runbook

Push connector. The counter POSTs JSON to our ingest endpoint; we never poll it and it never touches the database. Code: `packages/connectors/src/counters/milesight/` (schema and mapping) and `apps/web/lib/ingest/` (endpoint). Decisions: `docs/adr/0003-counter-ingest.md`. Tables: `docs/data-dictionary.md#counter-readings`.

Anything not confirmed in the vendor's documentation is marked **UNVERIFIED**. Nothing here has been tested on a real device yet.

## Vendor documentation used

| Ref | Document                                                                                                                                                                                               | Sections used                                                                                                                                                                                              |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | [VS135 cellular user guide: Communication](https://www.milesight.com/products/docs/en/vs135-cellular/steps/vs1xx/vs13x/vs13x-communication.html)                                                       | "Data Push Settings" (recipients, HTTP(s) URL/User/Password, Report Strategy, Data Retransmission), "Cellular", "MQTT API"                                                                                 |
| D2  | [VS135 cellular user guide: Periodic Report](https://www.milesight.com/products/docs/en/vs135-cellular/steps/vs1xx/vs13x/vs13x-periodic-report.html)                                                   | Full JSON example (`device_info`, `network_info`, `line_periodic_data`, `line_total_data`, `region_data`, `time_info`)                                                                                     |
| D3  | [VS135 cellular user guide: Trigger Report](https://www.milesight.com/products/docs/en/vs135-cellular/steps/vs1xx/vs13x/vs13x-trigger-report.html)                                                     | "Line Crossing People Counting", "Region People Counting", "Dwell Time Detection", "Occlusion Detection Alarm"                                                                                             |
| D4  | [VS135 cellular user guide: System](https://www.milesight.com/products/docs/en/vs135-cellular/steps/vs1xx/vs13x/135/VS135-cellular-system.html)                                                        | "Time Configuration" (time zone, DST, NTP)                                                                                                                                                                 |
| D5  | [VS13x API Specification PDF](https://resource.milesight.com/milesight/iot/document/vs13x-api-documentation-en.pdf) (revision table up to VS13x_1.0.9, 10 Jun 2025)                                    | Overview (Digest auth for the device's own API); 3.4/3.5 Get/Set Recipient Configuration (`httpConfig`, `reportStrategy`, `customizeTimeInfo`, `lineTotalData` bits); 3.6 Get Recipient List; 6.9/6.10 NTP |
| D6  | [VS133/VS135 product page](https://www.milesight.com/iot/product/lorawan-sensor/vs133-vs135)                                                                                                           | Specifications: protocols per version, local storage, retransmission packets                                                                                                                               |
| D7  | VS135-P user guide (PoE, 23 Feb 2024), [distributor copy](https://www.telemetrieshop.nl/downloads/422_vs135-p-user-guide-en.pdf). Not an official Milesight URL; used only to cross-check field names. | 5.3.2 Recipient; 7.1 to 7.4 Communication Protocol                                                                                                                                                         |

## What the docs confirm

- The device pushes people-counting data "in json format" to an HTTP(S) URL, with a User and Password "used for authentication" (D1 Data Push Settings; D7 5.3.2). Up to 8 recipients (D1). MQTT(S) with CA-signed or self-signed client certificates is the alternative (D1).
- Report strategy: Trigger Report (on every count change, with an optional cooldown), Periodic Report "On the Dot" (clock-aligned) or "From Now On" (D1; D5 3.4 `periodMode`, `onTheDotMin`, `periodIntervalMin` in minutes).
- Data Retransmission: "resend stored data packets from the disconnected period when the device's network connection is restored", up to 50,000 per recipient (D1). Product page: "8 x 50000 data retransmission packets" for PoE and cellular (D6).
- Payload fields we use (D2, D3): `device_info.device_sn`; `time_info.start_time`/`end_time` (periodic) or `time` (trigger), ISO 8601 local time with an offset; `line_periodic_data[].line`, `.in`, `.out`; `line_total_data[].capacity_counted`; `tof_occlusion_trigger.occlusion_status`.
- Report content is configurable per recipient: `customizeDeviceInfo` (bit1 device SN), `customizeTimeInfo` (bit1 start time, bit2 end time), `networkInfo` (ICCID, IMEI, cell ID), `lineTotalData` (bit1 "Capacity Counted") (D5 3.4).
- Time: time zone, DST and NTP sync are configurable (D4; D5 6.9/6.10).

## UNVERIFIED (check on the first real device)

| #   | Question                                                                                                                                                                     | Our assumption / mitigation                                                                                                                                |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| U1  | Which HTTP auth scheme the push uses (Basic or Digest), and whether the header is sent up front or only after a 401 challenge. D1 only says "used for authentication".       | HTTP Basic. 401 responses carry `WWW-Authenticate: Basic`. If the device only does Digest, we switch to MQTTS or revisit (ADR 0003). **Highest risk.**     |
| U2  | HTTP method and `Content-Type` header.                                                                                                                                       | `POST`, `application/json`. Anything else gets 415; the log shows `unsupported_media_type`.                                                                |
| U3  | Whether the device verifies the HTTPS server certificate, and against which CA store. (D5 2.20 "Import HTTPS certificate" may be for the device's own web server.)           | Vercel's certificate is publicly trusted, so either way should connect.                                                                                    |
| U4  | What the device does on a non-2xx response (retry, keep buffered, drop), and whether it honours `Retry-After`. D1 describes retransmission only for a "disconnected period". | We answer 2xx for anything we stored or deliberately skipped, 4xx only for requests that will never succeed, 429/503 when a retry makes sense.             |
| U5  | How fast buffered packets are re-sent after an outage, and whether they are byte-identical to the originals.                                                                 | Rate limit allows a burst of 60 then 1 per second per device. Dedupe is on the reading key, not the bytes, so changed `running_time` etc. does not matter. |
| U6  | Whether one POST can carry several reports.                                                                                                                                  | We accept one object or an array of up to 100.                                                                                                             |
| U7  | The body the "Connection Test" button sends.                                                                                                                                 | If it is not a report, the Test will show 400 (`invalid_payload`). Check the ingest logs; a 401 means wrong User/Password.                                 |
| U8  | What `capacity_counted` means exactly.                                                                                                                                       | Read as current occupancy for the line; stored as `occupancy` (negative values become empty).                                                              |
| U9  | Allowed periodic intervals. D2's example is a 1-minute interval; D1 gives 10-minute and 1-hour examples.                                                                     | Use 5 minutes, On the Dot.                                                                                                                                 |
| U10 | Password field length and allowed characters. (D5 3.4 lists `httpConfig.password` as "integer" in the Get response, probably masked.)                                        | Generated secrets are 40 letters and digits. If the field is shorter, regenerate with a shorter length (minimum 16) and note it here.                      |
| U11 | Number of recipients: D1 says 8, D5 3.4 says `recipientID` 1–6, D6 lists both "8 x 50000" and "6 x 30000".                                                                   | We need one recipient.                                                                                                                                     |
| U12 | Whether `start_time`/`end_time` are always present in periodic reports. They can be switched off (`customizeTimeInfo`).                                                      | Required. Without them the request fails with `missing_interval`.                                                                                          |
| U13 | Whether the device follows an HTTP→HTTPS redirect on POST.                                                                                                                   | Always configure the `https://` URL.                                                                                                                       |
| U14 | Line numbering when several devices are stitched (master/node mode).                                                                                                         | Lines 1–16 accepted; each line gets its own entry point.                                                                                                   |
| U15 | `occlusion_status` values other than `"occluded"`.                                                                                                                           | Recorded as `other`.                                                                                                                                       |
| U16 | D7's PoE example shows `start_time` equal to `end_time`; D2's cellular example shows a 1-minute interval.                                                                    | Zero-length intervals are rejected (`invalid_interval`). If real devices send them, revisit.                                                               |

Hosting items (UNVERIFIED until the first Vercel deploy): Vercel sets `x-forwarded-proto: https` and overwrites any value the client sends; `x-real-ip`/`x-forwarded-for` are set by Vercel; Vercel's handling of plain-HTTP POSTs.

## Device set-up (per counter)

Do this with the venue's installer on site, or remotely through Milesight DeviceHub only if the client has approved that account (D4 "Remote Management"; account in the client's name).

1. **Register the device with Foresite** (an engineer):
   ```sh
   npm run device:create -w apps/web -- --device <venue>-<door>-01 --venue <venue id> --entry <entry point id> \
     [--serial <device SN from the label>] [--line 2=<entry id for line 2>]
   ```
   The secret is printed **once** to the terminal. The SQL on stdout holds only its hash; run it in the client's Supabase SQL editor. Nothing is written to disk. Put the secret straight into the device (step 4) and nowhere else (no tickets, chat or email).
2. **Time:** System > Time Configuration (D4). Time zone = the venue's (Perth: UTC+8, no DST), Synchronize Mode = NTP, a reachable NTP server (default `pool.ntp.org`, D5 6.9). Readings more than 10 minutes in the future are rejected, so a wrong clock shows up as `rejected` counts.
3. **Lines:** draw line 1 across the main entry, "in" pointing into the venue. Extra lines on the same device need `--line <n>=<entry id>` at registration, or they get `<entry>:line-<n>`.
4. **Recipient** (Communication > Data Push Settings, D1):
   - Protocol: HTTP(s).
   - URL: `https://<client app domain>/api/ingest/counters/milesight`
   - User: the Foresite device id from step 1. Password: the secret from step 1.
   - Report Strategy: Periodic Report on, **On the Dot**, period **5 minutes**. Trigger Report **off** (we ignore trigger reports; turning them off saves 4G data).
   - Data Retransmission: **on**.
   - Customise Report Content: device SN **on** (required), start time and end time **on** (required), Line Count Data **on**, Capacity Counted on (optional, gives occupancy), network info (ICCID, IMEI, cell ID) **off** (we do not need it).
5. **Connection Test** (U7), then wait for the next 5-minute boundary and check the logs for `"outcome":"stored","deviceId":"<id>"` with `"status":201`.
6. Record in the client's engagement notes: device id, venue, entry point, serial, firmware version, date installed. Never the secret.

## What the venue or vendor must provide

- Venue: power (VS135 cellular: DC 12 V / 2 A, D6), mounting height within range (up to 3.5 m standard, 6.5 m high-ceiling, D6), a SIM with data in the client's name, the device SN, and someone on site for installation and line drawing.
- Client: the counter purchase and any Milesight DeviceHub account in **their** name (Connor approves; we never create vendor accounts).
- Vendor (via Connor, if needed): answers to U1, U4, U5 and U7 above.

## Rotating a device secret

1. `npm run device:create -w apps/web -- --rotate --device <id>`: prints a new secret once and SQL that adds its hash as a second slot. Run the SQL.
2. Put the new secret in the device's recipient Password field.
3. When the logs show `"secretSlot":2` for that device, run the SQL from `npm run device:create -w apps/web -- --finish-rotation --device <id>` to drop the old secret.

To revoke a device at once: `update counter_devices set active = false, updated_at = now() where device_id = '<id>';`

## Monitoring and logs

One JSON log line per request (`"event":"counter_ingest"`): `outcome`, `status`, `deviceId` (only after authentication), `secretSlot`, `errorCode`, field `paths` for validation errors, `counts`, `durationMs`, `requestId` (also in the `X-Request-Id` response header). No secrets, Authorization headers or payload values are logged. Per-request summaries, conflicts, clock rejections and occlusion alarms are also in `counter_ingest_events`.

Alerting on "no data from device for N minutes" belongs to the alerts PR (not built here).

## Failure modes and recovery

| Symptom (log / response)                               | Likely cause                                                   | Recovery                                                                                                                              |
| ------------------------------------------------------ | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| 401 `auth_bad_secret` / `auth_unknown_device`          | Wrong User/Password, device not registered, wrong provider URL | Re-enter credentials; check the device id; rotate if the secret is lost.                                                              |
| 401 `auth_malformed` on every request                  | Device does not send HTTP Basic (U1)                           | Escalate to Lachlan: Digest or MQTTS needed.                                                                                          |
| 401 `auth_inactive`                                    | Device deactivated                                             | Reactivate if intended.                                                                                                               |
| 403 `https_required`                                   | URL uses `http://`                                             | Change the URL to `https://`.                                                                                                         |
| 403 `device_mismatch`                                  | Payload serial differs from the registered serial              | Device swapped or credentials copied to another device. Fix the registration; investigate if unexpected.                              |
| 415 `unsupported_media_type`                           | Device sends another Content-Type (U2)                         | Escalate; do not loosen the check without an ADR note.                                                                                |
| 400 `missing_interval`                                 | Start/end time switched off in Customise Report Content        | Turn them on (step 4). The raw payloads are kept in `counter_raw_payloads` (`parse_status = 'rejected'`).                             |
| 400 `invalid_payload` with `paths`                     | Firmware changed a field we use, or the Test message (U7)      | Compare the stored raw payload with the schema; fix the schema; replay the stored raw payloads.                                       |
| `rejected` counts > 0, events `reading_rejected_clock` | Device clock wrong (`future`) or very old buffer (`too_old`)   | Fix NTP/time zone. Old data beyond `INGEST_MAX_AGE_DAYS` is not stored as readings (raw payload is).                                  |
| `late` counts > 0                                      | Buffered data after an outage                                  | Normal. Stored and counted.                                                                                                           |
| `conflict` counts > 0, events `reading_conflict`       | Same interval re-sent with different counts                    | Later device timestamp wins; both versions are in the event. Investigate if frequent (counter reset, two devices sharing an id).      |
| 429 `rate_limited`                                     | Burst above the per-device limit, or repeated failed logins    | The device should retry (U4). Tune `INGEST_RATE_LIMIT_*` if a legitimate backfill is throttled.                                       |
| 503 `storage_unavailable`                              | Database unreachable or storage misconfigured                  | Check `counter_ingest_config` errors and Supabase status. Nothing partial is stored; the device's retransmission covers the gap (U4). |
| Device "Status" disconnected                           | 4G coverage, SIM, DNS                                          | Check SIM data and signal on site. Data is buffered on the device (up to 50,000 packets, D1) and re-sent on reconnect.                |
| `device_alarm` events with `alarm: occlusion`          | Lens covered or obstructed                                     | Ask the venue to clear the sensor.                                                                                                    |

## Replaying raw payloads

Every authenticated JSON body is stored in `counter_raw_payloads` before mapping. After fixing a schema or mapping bug, replay rows with `parse_status = 'rejected'` through `mapMilesightPayload` and `repository.ingest`; the natural-key dedupe makes replays safe to repeat. A replay script is a follow-up.
