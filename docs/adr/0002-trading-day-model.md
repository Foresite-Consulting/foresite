# ADR 0002: Trading-day model, cut-over and daylight saving

Status: Proposed (for Lachlan)
Date: 19 Oct 2026

## Context

`CLAUDE.md` says every fact joins on a **trading day** (open to close, not midnight to midnight) and a **section**. Hospitality trades across midnight: a Saturday that opens at 11:00 and closes at 02:00 on Sunday is one trading day, Saturday. Sales, labour, people counts, budgets and forecasts all have to agree on which day an instant belongs to, or the numbers will not reconcile.

Constraints: Perth (no daylight saving) is the home market, but the core is reused for venues in Sydney, Melbourne, Adelaide (a half-hour zone) and possibly Lord Howe Island (a 30-minute daylight-saving shift). A trading day must still be defined on the nights the clocks change. The Python forecast engine must compute the same days, so the rules must be simple enough to port and pinned by shared test vectors. No real client data.

## Options

### What a trading day is

1. **Calendar day (midnight to midnight).** Simple, but splits a Saturday night across two days. Rejected by `CLAUDE.md`.
2. **First open to last close, per day.** Follows the hours exactly, but the boundary moves with the roster, instants between close and the next open (late voids, cleaning, early deliveries) have no day, and a change to the hours re-labels history.
3. **Fixed cut-over windows, with sessions required to sit inside them.** Day D runs from the cut-over on date D (default 05:00) to the cut-over on date D+1. Every instant has exactly one day; days are contiguous; the session rule and the cut-over rule always agree because validation rejects a session that crosses the cut-over.

### Time-zone handling

1. **Hand-written offset maths over `Intl`.** No dependency, but the DST edge cases are exactly where hand-written code goes wrong. Rejected by the brief.
2. **Luxon 3.7.2 / date-fns-tz.** Mature, but neither lets us choose the earlier/later resolution of repeated and skipped local times as explicitly as Temporal.
3. **Temporal (`@js-temporal/polyfill` 0.5.1).** The TC39 standard date-time API, the reference polyfill by the proposal's champions; explicit `disambiguation` for repeated and skipped times; built-in `getTimeZoneTransition`; reads the IANA database from Node's ICU. One dependency (`jsbi`). When Node ships Temporal natively the import can be swapped. Cost: it is slow per call (tens of microseconds), so results are cached per venue.

## Decision

- **Option 3 for the trading day.** Day D = `[cut-over on D, cut-over on D+1)`, named by the local date it starts on. Default cut-over **05:00**: later than any normal licensed close in Australia and earlier than breakfast, and clear of the 02:00–03:00 band where Australian clocks change. A venue that trades past 05:00 sets a later cut-over.
- **Boundaries.** Sessions are `[open, close)`: the open instant is inside, the close is not. The cut-over instant belongs to the new day. Sessions may touch (15:00 close, 15:00 open) but not overlap.
- **Sessions per weekday, keyed by the weekday the trading day starts on**, plus one exception per date: `closure` (venue or sections), `public_holiday`, `event`, `special_hours` (with replacement hours per section). A close at or before the open is on the next calendar date. Sessions must be under 24 hours (implied by fitting inside one day).
- **Local time → instant, one rule:** a repeated local time takes its **first** occurrence; a skipped local time takes **the moment the clocks jump**. This mapping is monotonic, so sessions keep their order and stay inside their day on change nights. Temporal's own `compatible` rule was not used because it moves a skipped time forward by the length of the gap (02:30 → 03:30), which can put a close before an open. Effect: a Sydney bar closing at 02:00 trades 15 elapsed hours on both change nights; a trading day is 23, 24 or 25 hours long (23.5 or 24.5 on Lord Howe Island).
- **Intervals** (15-minute and hourly) align to the local clock and are cut at offset changes and day boundaries: a repeated hour gives two buckets keyed by UTC start, a skipped hour none.
- **Same weekday last year = 364 days earlier.** `sameDateLastYear` exists for reference only.
- **Instants** are exchanged as ISO 8601 UTC. Input is a `Date` or an ISO 8601 string with `Z` or an offset; a string without an offset, or with a bracketed annotation (`[Australia/Sydney]`), is rejected. Bare numbers are rejected by the type and at runtime, because epoch seconds passed as milliseconds would land silently in January 1970; callers convert explicitly with `fromEpochMs(ms)`.
- **Temporal via `@js-temporal/polyfill` 0.5.1**, pinned. Also added: `fast-check` 4.10.2 (dev, property tests) and `@vitest/coverage-v8` 4.1.11 (dev, matches Vitest; the 95% coverage gate for `packages/core`).
- **Golden vectors** in `packages/core/test-vectors/trading-day.json` (hand-checked, each with a `why`) are the contract for any other implementation.

## Consequences

- Easier: every fact has exactly one trading day, with no gaps or overlaps, whatever the roster says; reports reconcile; DST is handled once, in one place, and pinned by vectors; the Python engine can port a short set of rules and check itself against the same JSON.
- Harder: a venue that trades through its cut-over (e.g. a 24-hour venue, or a New Year's Eve that runs to 06:00) must move its cut-over or split the session. Changing a venue's cut-over re-labels the instants near it, so it should be treated like a migration (recompute affected days), not a casual setting.
- Labour loadings, liquor-licence rules and award penalty rates that depend on the **calendar** day (e.g. hours after midnight on Saturday) are not part of this model; they need their own rule when wages are calculated.
- The polyfill is slow per call. The model caches per venue (bounded maps), and interval building reads fields through `PlainDateTime`. Generating 730 days of synthetic data takes about six seconds; a live ingest path should be load-checked when it is built.
- `UNVERIFIED`: whether NSW/Victorian venues trade the "extra hour" when the clocks go back, or close at the first 02:00. The model takes the first occurrence, so a 02:00 close keeps the usual elapsed length; a venue that trades the extra hour sets its close to 03:00 for that date with a `special_hours` exception.
- Reusable in the core: all of it. Client-specific: only each venue's configuration (sections, hours, exceptions, cut-over), which is client data.

## For Lachlan

1. Approve the 05:00 default cut-over and the rule that sessions may not cross it.
2. Approve "first occurrence" for repeated local times and "the jump" for skipped ones.
3. Approve `@js-temporal/polyfill` as the time-zone library for the core (and as the model for the Python port, which can use `zoneinfo` with `fold=0` and an explicit gap rule).
4. Approve `_no_gst_cents` as the suffix for money that GST does not apply to (wages), alongside `_ex_gst_cents` and `_inc_gst_cents`.
