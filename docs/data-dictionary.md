# Data dictionary

One definition for every term, field and KPI, used by the app, the reports and the forecast engine alike. If code and this page disagree, the code is wrong or this page is out of date: fix one of them in the same PR.

Implementation: `packages/core` (TypeScript). Golden test vectors that any other implementation (e.g. the Python forecast engine) must pass: `packages/core/test-vectors/trading-day.json`.

## Conventions

| Thing       | Rule                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Instant     | A point on the UTC timeline. Stored and exchanged as ISO 8601 UTC, e.g. `2026-10-17T12:00:00Z` (milliseconds shown only when non-zero, always three digits). Input is a `Date` or an ISO 8601 string that may carry an offset (`+08:00`). Rejected: a local time without an offset; a bracketed annotation such as `[Australia/Sydney]`; a bare number (epoch seconds and milliseconds look alike; convert with `fromEpochMs(ms)`). Precision: milliseconds. |
| Local time  | The venue's wall-clock time in its IANA time zone (`Australia/Perth` by default). Shown to people; never used as a key on its own.                                                                                                                                                                                                                                                                                                                           |
| Trading day | `YYYY-MM-DD`: the local date on which the trading day **starts**. See [Trading day](#trading-day).                                                                                                                                                                                                                                                                                                                                                           |
| Section     | A part of the venue that trades and reports on its own (bar, restaurant, deck, functions…). Id: lower-case slug, e.g. `bar`.                                                                                                                                                                                                                                                                                                                                 |
| Money       | Integer cents (AUD). Never floating point. Every money field's name says its GST basis: `_ex_gst_cents`, `_inc_gst_cents`, or `_no_gst_cents` where GST does not apply (wages).                                                                                                                                                                                                                                                                              |
| GST         | 10% of the GST-exclusive amount, rounded half up to the cent: `gst_cents = floor((net_ex_gst_cents + 5) / 10)`.                                                                                                                                                                                                                                                                                                                                              |
| Durations   | Elapsed minutes (real time), not wall-clock minutes. They differ on a night the clocks change.                                                                                                                                                                                                                                                                                                                                                               |

## Venue configuration

Validated by `venueSchema` / `parseVenue` in `packages/core/src/venue/schema.ts`. Configuration is client data and lives in the client's database, not in this repo.

| Field          | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`, `name`   | Slug and display name.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `timeZone`     | **Canonical** IANA location name. Default `Australia/Perth`. Links are rejected with a message naming the canonical zone (`Australia/NSW` → use `Australia/Sydney`, `Australia/West` → `Australia/Perth`); so are `UTC`, `GMT`, abbreviations such as `EST`, `Etc/…` and fixed offsets such as `+08:00` (no location, no daylight-saving rules). The list is the runtime's `Intl.supportedValuesOf('timeZone')`, with the few names ICU still spells the old way mapped to their IANA names (`Asia/Calcutta` → `Asia/Kolkata`); all Australian zones are the same in both. |
| `cutOver`      | Local `HH:MM` at which one trading day ends and the next begins. Default `05:00`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `sections[]`   | `id`, `name`, `hours`: sessions per weekday (`mon` … `sun`), keyed by the weekday the trading day **starts** on. Missing or `[]` = closed.                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Session        | `{ open, close }`, local `HH:MM`. A close at or before the open is on the next calendar date (`11:00`–`02:00`). Must fit inside one trading day (may not cross the cut-over), so it is always under 24 hours. Sessions in a section may touch but not overlap.                                                                                                                                                                                                                                                                                                             |
| `exceptions[]` | At most one per date. `closure` (whole venue, or `sectionIds`); `public_holiday`, `event` (label, optional replacement `hours`); `special_hours` (replacement `hours` required).                                                                                                                                                                                                                                                                                                                                                                                           |

**Hours for trading day D and section S:** a `closure` on D that covers S → closed. Otherwise, if the exception on D lists hours for S → those (`[]` closes S). Otherwise → S's weekly hours for D's weekday.

## Trading day

`tradingDayFor(instant, venue, sectionId?)` and `tradingDayBounds(tradingDay, venue, sectionId?)` in `packages/core/src/trading-day.ts`.

1. **Window.** Trading day D is the half-open window `[cut-over on local date D, cut-over on local date D+1)`. Every instant is in exactly one trading day; the end of D is the start of D+1.
2. **Assignment.** An instant belongs to the trading day whose window contains it. In practice: local time at or after the cut-over → that local date; before the cut-over → the previous date. The instant exactly at the cut-over starts the new day.
3. **Sessions sit inside the window.** Validation guarantees it, so "the trading day of the session it falls in" and "the trading day by cut-over" are always the same day. An instant outside every session still has a trading day (late voids, early deliveries, stray device data).
4. **Within scheduled hours.** True when a session contains the instant. A session includes its open and excludes its close: `open ≤ instant < close`. For a section: that section's sessions. With no section: any section's.
5. **Length.** Usually 1440 minutes. On a daylight-saving night it is 1380 (clocks forward) or 1500 (clocks back); on Lord Howe Island 1410 or 1470 (30-minute shift).
6. **Local time → instant** (cut-over, opens and closes), one rule everywhere:
   - normal time: that instant;
   - **repeated** time (clocks go back): the **first** occurrence;
   - **skipped** time (clocks go forward): the moment the clocks jump (the first instant after the gap).

   This never goes backwards in time, so sessions stay ordered and inside their day. Consequences: a Sydney bar closing at 02:00 trades 15 elapsed hours on both change nights; on Lord Howe Island, where 02:00 comes just after the repeated half hour, the same session is 15.5 hours long on the night the clocks go back. A session wholly inside a skipped hour has no length that night and is left out.

### Comparisons

| Function              | Definition                                                                                                                |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `sameWeekdayLastYear` | Trading day minus **364 days** (52 weeks). Same weekday. The like-for-like baseline (and the forecast rollback baseline). |
| `sameDateLastYear`    | Same calendar date a year earlier; 29 February → 28 February. Reference only (weekday differs).                           |

## Intervals and buckets

`tradingDayIntervals`, `intervalFor`, `scheduledIntervals`, `bucketEvents` in `packages/core/src/buckets.ts`.

- 15-minute or hourly, aligned to the **local** clock (:00/:15/:30/:45; on the hour), including half-hour zones.
- An interval never spans a change of UTC offset or a trading-day boundary; it is cut short there. A repeated hour gives two intervals with the same `slot` (local `HH:MM`) and different `startUtc`; a skipped hour gives none; Lord Howe can have a 30-minute "hourly" interval.
- Intervals are `[start, end)` and tile the trading day exactly (96 fifteen-minute intervals on a normal day; 92 / 100 in Sydney on change nights).
- **Bucket key:** trading day × section × interval `startUtc`. Totals are plain sums of the events in the bucket (exact for integer cents). `scheduledMinutes` is the part of the interval inside the section's sessions.

## KPIs

None defined yet. Each KPI (GP, labour %, spend per head, vs budget, vs last year) gets its formula, source fields, GST basis and trading-day basis here when its PR lands.

## Synthetic data (development and tests only)

`npm run synth -w packages/core -- --days 730 --seed 42 --out <dir>` (run from the repo root; a relative `--out` resolves from where npm was run). Generator: `packages/core/src/synthetic/`. Fictional venue: **Harbourside Test Venue**. Every CSV starts with `# SYNTHETIC DATA - not from any real venue`. Committed fixture (14 days from `2024-12-20`, seed 42): `packages/core/fixtures/synthetic/`; regenerate with `npm run synth -w packages/core -- --days 14 --seed 42 --out packages/core/fixtures/synthetic`.

### `intervals.csv`: one row per section × 15-minute interval with scheduled hours

| Column                         | Type / unit               | Meaning                                                                                                             |
| ------------------------------ | ------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `interval_start_utc`           | ISO 8601 UTC              | Interval start (inclusive). With `section_id`, the row key.                                                         |
| `interval_end_utc`             | ISO 8601 UTC              | Interval end (exclusive).                                                                                           |
| `trading_day`                  | `YYYY-MM-DD`              | Trading day (see above).                                                                                            |
| `local_start`                  | `YYYY-MM-DDTHH:MM±HH:MM`  | Local start with the offset in force (unambiguous in the repeated hour).                                            |
| `section_id`                   | slug                      | `bar`, `restaurant`, `deck`, `functions`.                                                                           |
| `scheduled_minutes`            | minutes                   | Minutes of the interval inside the section's sessions (less than 15 at an odd open or close).                       |
| `covers`                       | count                     | Guests served (≥ transactions).                                                                                     |
| `transactions`                 | count                     | Sales transactions (bills).                                                                                         |
| `net_sales_ex_gst_cents`       | cents, **ex GST**         | Net sales.                                                                                                          |
| `gst_cents`                    | cents                     | GST on net sales, on the interval total (see Conventions).                                                          |
| `gross_sales_inc_gst_cents`    | cents, **inc GST**        | `net_sales_ex_gst_cents + gst_cents`.                                                                               |
| `labour_minutes_foh`           | staff-minutes             | Front-of-house rostered minutes (staff × scheduled minutes).                                                        |
| `labour_minutes_boh`           | staff-minutes             | Back-of-house (kitchen) rostered minutes.                                                                           |
| `labour_cost_foh_no_gst_cents` | cents, **no GST** (wages) | FOH cost: minutes × invented loaded rate × day loading (Sat 125%, Sun 150%, public holiday 225%). Not award advice. |
| `labour_cost_boh_no_gst_cents` | cents, **no GST** (wages) | BOH cost, same basis.                                                                                               |

Day loadings use the trading day's weekday, so the hours after midnight on a Saturday night are costed at Saturday rates. Real award rules differ; the synthetic data does not model them.

### `people_counts.csv`: one row per entry point × 15-minute interval while a section behind it is open

| Column                                                                 | Meaning                                                          |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `interval_start_utc`, `interval_end_utc`, `trading_day`, `local_start` | As above.                                                        |
| `entry_point_id`                                                       | `main-entrance` or `deck-gate`.                                  |
| `section_id`                                                           | Section the counter belongs to; empty for a venue-wide entrance. |
| `people_in`, `people_out`                                              | Counts. In and out balance per entry point per trading day.      |

### `weather.csv`: one row per trading day

| Column              | Meaning                                        |
| ------------------- | ---------------------------------------------- |
| `trading_day`       | Trading day.                                   |
| `max_temp_tenths_c` | Daily maximum, tenths of °C (`284` = 28.4 °C). |
| `rain_tenths_mm`    | Rainfall, tenths of a millimetre.              |

### `venue.json` and `manifest.json`

`venue.json` is the parsed venue configuration used (hours, holidays, closures). `manifest.json` records the generator version, PRNG, seed, start day, day count, time zone, anomaly flags, every anomaly injected (`closed_day`, `data_gap`, `late_duplicate`, with day, section and first interval) and row counts. No timestamps, so the output is byte-for-byte reproducible.
