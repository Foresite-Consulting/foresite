# Data dictionary

One definition for every term, field and KPI, used by the app, the reports and the forecast engine alike. If code and this page disagree, the code is wrong or this page is out of date: fix one of them in the same PR.

Implementation: `packages/core` (TypeScript). Golden test vectors that any other implementation (e.g. the Python forecast engine) must pass: `packages/core/test-vectors/trading-day.json`.

Each definition gives its formula, source fields, ex or inc GST, and the trading-day basis. Every fact is keyed by **trading day** (open to close in the venue's local time, not midnight to midnight) and **section**.

## Conventions

| Thing       | Rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Instant     | A point on the UTC timeline. Stored and exchanged as ISO 8601 UTC, e.g. `2026-10-17T12:00:00Z` (milliseconds shown only when non-zero, always three digits). Input is a `Date` or an ISO 8601 string that may carry an offset (`+08:00`). Rejected: a local time without an offset; a bracketed annotation such as `[Australia/Sydney]`; a bare number (epoch seconds and milliseconds look alike; convert with `fromEpochMs(ms)`). Precision: milliseconds.                     |
| Local time  | The venue's wall-clock time in its IANA time zone (`Australia/Perth` by default). Shown to people; never used as a key on its own.                                                                                                                                                                                                                                                                                                                                               |
| Trading day | `YYYY-MM-DD`: the local date on which the trading day **starts**. See [Trading day](#trading-day).                                                                                                                                                                                                                                                                                                                                                                               |
| Section     | A part of the venue that trades and reports on its own (bar, restaurant, deck, functions…). Id: lower-case slug, e.g. `bar`.                                                                                                                                                                                                                                                                                                                                                     |
| Money       | Integer cents (AUD). Never floating point. Every money field's name says its GST basis: `_ex_gst_cents`, `_inc_gst_cents`, or `_no_gst_cents` where GST does not apply (wages).                                                                                                                                                                                                                                                                                                  |
| GST         | 10% of the GST-exclusive amount, rounded half up to the cent: `gst_cents = floor((net_ex_gst_cents + 5) / 10)`. Rounded **per row** (in the synthetic data, per interval row). An aggregate's GST is the **sum of the rows' `gst_cents`**, never recomputed from the aggregate net (that can differ by a few cents). Real POS systems round per transaction (or per line), so their GST is the sum of those roundings; keep the source's `gst_cents` rather than recomputing it. |
| Durations   | Elapsed minutes (real time), not wall-clock minutes. They differ on a night the clocks change.                                                                                                                                                                                                                                                                                                                                                                                   |

## Venue configuration

Validated by `venueSchema` / `parseVenue` in `packages/core/src/venue/schema.ts`. Configuration is client data and lives in the client's database, not in this repo.

| Field          | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`, `name`   | Slug and display name.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `timeZone`     | **Canonical** IANA location name. Default `Australia/Perth`. Links are rejected with a message naming the canonical zone (`Australia/NSW` → use `Australia/Sydney`, `Australia/West` → `Australia/Perth`); so are `UTC`, `GMT`, abbreviations such as `EST`, `Etc/…` and fixed offsets such as `+08:00` (no location, no daylight-saving rules). The list is the runtime's `Intl.supportedValuesOf('timeZone')`, with the few names ICU still spells the old way mapped to their IANA names (`Asia/Calcutta` → `Asia/Kolkata`); all Australian zones are the same in both. |
| `cutOver`      | Local `HH:MM` at which one trading day ends and the next begins. Default `05:00`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `sections[]`   | `id`, `name`, `hours`: sessions per weekday (`mon` … `sun`), keyed by the weekday the trading day **starts** on. Missing or `[]` = closed.                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Session        | `{ open, close }`, local `HH:MM`. A close at or before the open is on the next calendar date (`11:00`–`02:00`). An **open** earlier than the cut-over is also on the next calendar date: with a 05:00 cut-over, trading day `2026-10-17` with a session `01:00`–`04:00` opens at 01:00 on `2026-10-18` (the early hours after that day's date, not the morning before). Must fit inside one trading day (may not cross the cut-over), so it is always under 24 hours. Sessions in a section may touch but not overlap.                                                     |
| `exceptions[]` | At most one per date. `closure` (whole venue, or `sectionIds`); `public_holiday`, `event` (label, optional replacement `hours`); `special_hours` (replacement `hours` required, for at least one section; `hours: {}` is rejected).                                                                                                                                                                                                                                                                                                                                        |

**Hours for trading day D and section S:** a `closure` on D that covers S → closed. Otherwise, if the exception on D lists hours for S → those (`[]` closes S). Otherwise → S's weekly hours for D's weekday.

## Trading day

`tradingDayFor(instant, venue, sectionId?)` and `tradingDayBounds(tradingDay, venue, sectionId?)` in `packages/core/src/trading-day.ts`.

1. **Window.** Trading day D is the half-open window `[cut-over on local date D, cut-over on local date D+1)`. Every instant is in exactly one trading day; the end of D is the start of D+1.
2. **Assignment.** An instant belongs to the trading day whose window contains it. In practice: local time at or after the cut-over → that local date; before the cut-over → the previous date. The instant exactly at the cut-over starts the new day.
3. **Sessions sit inside the window.** Validation guarantees it, so "the trading day of the session it falls in" and "the trading day by cut-over" are always the same day. An instant outside every session still has a trading day (late voids, early deliveries, stray device data).
4. **Within scheduled hours.** True when a session contains the instant. A session includes its open and excludes its close: `open ≤ instant < close`. For a section: that section's sessions. With no section: any section's.
5. **Length.** Usually 1440 minutes. On a daylight-saving night it is 1380 (clocks forward) or 1500 (clocks back); on Lord Howe Island 1410 or 1470 (30-minute shift). That assumes the cut-over is outside the 02:00–03:00 change band (the 05:00 default is). A cut-over inside it splits the change across two days: in Sydney with a 02:30 cut-over the spring night gives 1410 + 1410 (the skipped 02:30 maps to the jump) and the autumn night 1440 + 1500 (the boundary is the first 02:30).
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

`npm run synth -w packages/core -- --days 730 --seed 42 --out <dir>` (run from the repo root; a relative `--out` resolves from where npm was run). It will not write into a folder whose `manifest.json` describes a different dataset (seed, days, start day, time zone or anomaly flags) unless `--force` is given; rewriting the same dataset is allowed. Generator: `packages/core/src/synthetic/`. Fictional venue: **Harbourside Test Venue**. Every CSV starts with `# SYNTHETIC DATA - not from any real venue`. A text cell that starts with `=`, `+`, `-`, `@`, a tab or a carriage return is written with a leading `'` so a spreadsheet does not run it as a formula (numbers, including negative amounts, are never prefixed; no generated cell currently needs it). Committed fixture (14 days from `2024-12-20`, seed 42): `packages/core/fixtures/synthetic/`; regenerate with `npm run synth -w packages/core -- --days 14 --seed 42 --out packages/core/fixtures/synthetic`.

### `intervals.csv`: one row per section × 15-minute interval with scheduled hours

| Column                         | Type / unit               | Meaning                                                                                                                          |
| ------------------------------ | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `interval_start_utc`           | ISO 8601 UTC              | Interval start (inclusive). With `section_id`, the row key.                                                                      |
| `interval_end_utc`             | ISO 8601 UTC              | Interval end (exclusive).                                                                                                        |
| `trading_day`                  | `YYYY-MM-DD`              | Trading day (see above).                                                                                                         |
| `local_start`                  | `YYYY-MM-DDTHH:MM±HH:MM`  | Local start with the offset in force (unambiguous in the repeated hour).                                                         |
| `section_id`                   | slug                      | `bar`, `restaurant`, `deck`, `functions`.                                                                                        |
| `scheduled_minutes`            | minutes                   | Minutes of the interval inside the section's sessions (less than 15 at an odd open or close).                                    |
| `covers`                       | count                     | Guests served (≥ transactions).                                                                                                  |
| `transactions`                 | count                     | Sales transactions (bills).                                                                                                      |
| `net_sales_ex_gst_cents`       | cents, **ex GST**         | Net sales.                                                                                                                       |
| `gst_cents`                    | cents                     | GST on the interval row's net sales, rounded per row (see Conventions). Sum it to aggregate; never recompute from aggregate net. |
| `gross_sales_inc_gst_cents`    | cents, **inc GST**        | `net_sales_ex_gst_cents + gst_cents`.                                                                                            |
| `labour_minutes_foh`           | staff-minutes             | Front-of-house rostered minutes (staff × scheduled minutes).                                                                     |
| `labour_minutes_boh`           | staff-minutes             | Back-of-house (kitchen) rostered minutes.                                                                                        |
| `labour_cost_foh_no_gst_cents` | cents, **no GST** (wages) | FOH cost: minutes × invented loaded rate × day loading (Sat 125%, Sun 150%, public holiday 225%). Not award advice.              |
| `labour_cost_boh_no_gst_cents` | cents, **no GST** (wages) | BOH cost, same basis.                                                                                                            |

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

## Forecasts

Owner: `forecast/` (Python). Full rules and their rationale: `docs/adr/0004-forecast-baseline-and-accuracy.md`. Forecasts are estimates, never guarantees; every forecast shown carries its likely range and its accuracy to date.

### Inputs

| Field                    | Type                        | Basis                      | Definition                                                                                                     |
| ------------------------ | --------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `venue_id`               | identifier                  | -                          | Venue. 1-64 of `A-Z a-z 0-9 _ . -`, starting with a letter or digit                                            |
| `section_id`             | identifier                  | -                          | Section within the venue (bar, restaurant, deck...)                                                            |
| `trading_day`            | date                        | trading day, venue local   | The open-to-close trading day the figures belong to                                                            |
| `status`                 | `open`, `closed`, `missing` | trading day                | `open`: traded, figures known. `closed`: did not trade. `missing`: figures unknown. Blank means `open`         |
| `net_sales_ex_gst_cents` | integer ≥ 0                 | cents, **ex GST**, per day | Net sales after refunds and discounts, excluding GST. Required on open days                                    |
| `covers`                 | integer ≥ 0                 | count, per day             | Guests served. Optional                                                                                        |
| `labour_cost_cents`      | integer ≥ 0                 | cents, per day             | Labour cost for the trading day. Optional; whether on-costs are included is set by the client's KPI definition |
| calendar `kind`          | `public_holiday`, `closed`  | trading day                | Public holiday (with a stable `holiday_key`, e.g. `easter_monday`) or a planned closure                        |

### Forecast record (forecast log)

| Field            | Type           | Definition                                                                                                                                                                                            |
| ---------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `issued_at`      | UTC timestamp  | When the forecast was issued                                                                                                                                                                          |
| `model_id`       | identifier     | Model that made it, e.g. `baseline-swly-trend`                                                                                                                                                        |
| `model_version`  | identifier     | Rules or model version; `+cfg.<hash>` when baseline settings differ from the defaults                                                                                                                 |
| `metric`         | identifier     | The input column forecast, e.g. `net_sales_ex_gst_cents` (so the forecast is in cents ex GST)                                                                                                         |
| `as_of`          | date           | Last trading day whose actuals were complete when issued. Nothing after it is used                                                                                                                    |
| `target_day`     | date           | Trading day forecast                                                                                                                                                                                  |
| `horizon_days`   | integer 1-28   | `target_day − as_of`                                                                                                                                                                                  |
| `point`          | integer ≥ 0    | Point estimate, same unit and GST basis as the metric. Blank when `rule = unforecastable`                                                                                                             |
| `low`, `high`    | integer ≥ 0    | Likely range, `low ≤ point ≤ high`. About 8 in 10 actuals should fall inside with the default 10th-90th percentiles                                                                                   |
| `rule`           | identifier     | How the point was made: `closed_calendar`, `holiday_last_year`, `same_weekday_last_year`, `same_weekday_last_year_neighbours`, `recent_same_weekday_median`, `unforecastable` (or a model's own rule) |
| `trend_factor`   | number 0.5-2.0 | Baseline: last 8 weeks against the same 8 weeks a year earlier (364 days), usable day pairs only                                                                                                      |
| `trend_rule`     | identifier     | `trend_window`, `trend_capped`, `trend_insufficient_history`, `trend_zero_base`                                                                                                                       |
| `interval_rule`  | identifier     | How the range was made: `empirical_weekday_horizon`, `empirical_horizon`, `fallback_fixed_width`, `closed`, `zero_point_recent_max`                                                                   |
| `interval_n`     | integer        | Number of past errors behind the range                                                                                                                                                                |
| `reference_days` | dates          | Days the point was built from                                                                                                                                                                         |

### Accuracy measures

Computed per model × venue × metric over **scored** forecasts: the model gave a point, the target day was `open` and its actual is known, keeping only the latest issue per target and horizon (a later `unforecastable` re-issue retires an earlier point). Closed and missing days are never scored. Weeks are Monday to Sunday by target trading day.

| Measure                 | Formula                                                   | Notes                                                                                        |
| ----------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| WAPE (headline)         | Σ\|actual − point\| ÷ Σ actual                            | Shown as "typical error". Blank if Σ actual = 0                                              |
| MAPE                    | mean of \|actual − point\| ÷ actual, over actual > 0 only | Zero-actual days are left out (`mape_n` counts the rest)                                     |
| Bias                    | Σ(point − actual) ÷ Σ actual                              | Positive: forecasts run high                                                                 |
| Coverage                | share with low ≤ actual ≤ high                            | Shown as "in the likely range N of M times"                                                  |
| Rolling 4-week          | the above over the 4 calendar weeks ending each week      | `weeks_with_data` says how many of the 4 had scored forecasts                                |
| Accuracy to date (tile) | coverage and WAPE of 7-day-ahead forecasts, last 10 weeks | Needs at least 28 scored forecasts; labelled "based on a backtest" until live history exists |

### Champion/challenger

| Term              | Definition                                                                                                                                    |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Weekly comparison | WAPE of challenger and baseline on matched forecasts (same venue, section, metric, target day, horizon; both have a point; actual known)      |
| Evaluable week    | Complete week with ≥ 7 matched forecasts, ≥ 90% of the baseline's scored forecasts matched, and actuals summing to more than 0                |
| Worse week        | Challenger WAPE > baseline WAPE (a tie is not worse)                                                                                          |
| Rollback          | Last 4 complete weeks all evaluable and worse → serve the baseline and raise a `forecast_rollback` alert. Any evaluable not-worse week → keep |
| Phase 2 gate      | On the hold-out weeks (default last 8): all evaluable, pooled WAPE strictly lower, and better in at least ⌈0.75 × weeks⌉ weeks (6 of 8)       |
