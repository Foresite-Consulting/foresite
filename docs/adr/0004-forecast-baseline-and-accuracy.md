# ADR 0004: Forecast baseline, likely range, accuracy tracking and rollback

Status: Proposed (for Lachlan)
Date: 19 Oct 2026

## Context

The business has promised clients four things about forecasts (CLAUDE.md, the data-forecasting-engineer brief):

1. Every forecast has a point estimate, a low/high **likely range** and its **accuracy to date**.
2. Before Phase 2 sign-off the ML forecast must beat a simple benchmark: **same weekday last year, adjusted for trend**.
3. **Auto-rollback**: if the live model is worse than that baseline for **4 weeks running**, serve the baseline and raise an alert.
4. Forecasts are estimates, never guarantees.

All four need exact, testable definitions before LightGBM arrives, so that "beats the baseline" and "worse for 4 weeks" mean one thing in code, in reports and in conversations with clients. This ADR fixes those definitions. Input is daily actuals already keyed by trading day (open to close, venue local time) and section; the trading-day model itself lives in `packages/core` and is built separately.

Constraints: Python 3.12, few and mature dependencies, pinned and audited; synthetic data only; deterministic; the interfaces must let a LightGBM model plug in without changing logging, accuracy or rollback.

## Options

Benchmark shift:

1. **364 days (52 weeks).** Pros: keeps the weekday, which drives hospitality sales more than the date does. Cons: drifts 1 day a year against the calendar (2 after 29 February), so date-fixed events need separate handling. Cost: a holiday-matching rule.
2. **Same date last year (365/366 days).** Pros: matches date-fixed events. Cons: compares a Saturday with a Friday most years, which is a far bigger error. Rejected.

Range method:

1. **Empirical quantiles of the baseline's own past errors.** Pros: no distribution assumption; calibrated by construction; the same calibrator can wrap any model's backtest residuals. Cons: needs history; wide while history is short. Cost: a rolling backtest per series (about 0.3 s per venue per issue on two sections).
2. **Normal approximation (point ± z·σ).** Pros: simple. Cons: sales errors are skewed and multiplicative; under-covers busy days. Rejected.

Frame library:

1. **polars 1.44.2.** Pros: ships its own type hints, so `mypy --strict` stays clean with no stubs or ignores; fast group-bys and joins for accuracy tables; no pyarrow needed for CSV. Cons: younger API than pandas; the default runtime wheel targets modern x86 CPU features, with a separate compatibility runtime for older CPUs (`UNVERIFIED` against the eventual hosting target for the forecast job; GitHub's runners are fine). We pin the last 1.x patch, not the two-week-old 2.0 major.
2. **pandas.** Pros: most familiar; LightGBM accepts it directly. Cons: needs `pandas-stubs` and still returns `Any` widely under strict mypy. LightGBM also accepts NumPy arrays, which polars produces, so this is not a blocker.

Forecast log format:

1. **CSV.** Pros: no extra dependency, human-readable, appendable, opens in Excel, and the volumes are tiny (tens of thousands of rows a year per venue). Cons: no schema in the file itself (we validate every row on read).
2. **Parquet.** Pros: typed, compact. Cons: unreadable without tools; nothing gained at this size. In production the log becomes a Postgres table with the same columns anyway.

## Decision

Implemented in `forecast/foresite_forecast/` (`baseline.py`, `intervals.py`, `accuracy.py`, `selection.py`). Defaults are configurable; changing any baseline setting changes the logged `model_version` (`1.0.0+cfg.<hash>`).

### Terms

- `as_of`: the last trading day whose actuals are complete. Forecasts are for `t = as_of + h`, horizon `h` = 1-28 days. **Only actuals on or before `as_of` are used.**
- **Usable day**: status `open`, value known, not a calendar public holiday, not a calendar closed day. A **usable holiday day** is the same but holidays are allowed.
- **Week**: Monday to Sunday by target trading day. **Complete** once its Sunday is on or before the evaluation day.

### Baseline point (first rule that applies; the rule is logged as `rule`)

1. `closed_calendar`: calendar says the venue is closed on `t` → 0, range 0-0.
2. `holiday_last_year`: `t` is a public holiday with key K, and K's previous occurrence `d` (330-400 days before `t`, nearest to 364) is a usable holiday day → `value(d) × trend`. Easter matches Easter although its date moves.
3. `same_weekday_last_year`: `r = t − 364` is usable → `value(r) × trend`.
4. `same_weekday_last_year_neighbours`: mean of the usable days among `r ± 7` and `r ± 14` (at least 2) `× trend`.
5. `recent_same_weekday_median`: median of the usable days among the 8 most recent same-weekday days on or before `as_of` (at least 3). No trend factor: these days already show the current level.
6. `unforecastable`: no point and no range, logged rather than dropped.

The 364-day shift is deliberate (option 1 above). The point is rounded half up to whole cents; the low is rounded down and the high up, so `0 ≤ low ≤ point ≤ high` always holds.

### Trend factor (once per `as_of`; logged as `trend_factor`, `trend_rule`)

Pair each day `d` in `[as_of − 55, as_of]` (8 × 7 days, each weekday equally) with `d − 364`; keep pairs where both are usable, which drops holidays, closures and gaps on either side.

- Fewer than 28 pairs → 1.0 (`trend_insufficient_history`).
- Both sums 0 → 1.0 (`trend_zero_base`); year-earlier sum 0 and recent sum > 0 → the cap (`trend_capped`).
- Otherwise `sum(recent) / sum(year earlier)`, clamped to **0.5-2.0** (`trend_window`, or `trend_capped` if clamped). Near-zero denominators therefore hit the cap rather than exploding.

### Likely range (logged as `interval_rule`, `interval_n`)

From the baseline's own rolling backtest: every forecast issued in the **364 days** before `as_of` whose target is on or before `as_of` gives `ratio = actual / point` (point > 0, target open and known). Pools, most specific first, each needing **at least 30 ratios**:

1. `empirical_weekday_horizon`: same target weekday and horizon bucket (1-7, 8-14, 15-28 days);
2. `empirical_horizon`: same bucket, any weekday;
3. `fallback_fixed_width`: 0.70× to 1.30× the point while history is short.

`low = point × min(q10, 1)`, `high = point × max(q90, 1)` (quantiles configurable). Clamping at 1 only ever widens a range. A point of 0 on an open day gets `zero_point_recent_max`: 0 to the highest of the last 8 same-weekday actuals.

### Accuracy (per model × venue × metric; also by horizon, bucket, weekday, section, week and rolling 4 weeks)

Scored rows: the model gave a point, the target day was open and its actual is known; if the same model issued the same target at the same horizon twice, only the latest issue counts. De-duplication happens _before_ rows without a point are dropped, so a later `unforecastable` re-issue retires the earlier point from scoring (the model withdrew it; see decision 5 below). Closed and missing days are never scored.

- **WAPE** = Σ|actual − point| / Σ actual (primary; blank if Σ actual = 0).
- **MAPE** = mean |actual − point| / actual over rows with actual > 0 only.
- **Bias** = Σ(point − actual) / Σ actual (positive = forecasts too high).
- **Coverage** = share of rows with low ≤ actual ≤ high.
- **Accuracy to date (UI tile)**: forecasts made 7 days ahead for target days in the last 10 weeks, per section: "In the likely range N of M times in the last 10 weeks. Typical error X% (a week ahead)." plus "Tends to run high/low by Y%" when |bias| ≥ 5%. Fewer than 28 scored forecasts shows "Not enough history yet to show accuracy." Before live history exists the tile uses the baseline backtest and says so.

### Rollback (weekly, per venue × metric)

Compare the challenger (live model) with the baseline on **matched pairs** (same venue, section, metric, target day and horizon; both have a point; actual known). A week is **evaluable** if it has at least 7 matched pairs, the pairs are at least 90% of the baseline's scored forecasts that week (a model can't look good by skipping hard days), and actuals sum to more than 0. The challenger is **worse** when its WAPE is greater than the baseline's (margin 0: **a tie is not worse**).

Over the **last 4 complete calendar weeks**:

- any evaluable week not worse → `keep`;
- all 4 evaluable and worse → `rollback_to_baseline`: serve the baseline and emit an alert;
- anything else (a missing or thin week, no clean week) → `insufficient_data`: keep serving the challenger and report why.

A missing week can never trigger a rollback, and can never hide a good week.

**Rollback is one-way, and enforced.** The weekly rule is stateless, so the decision carries a `RollbackRecord` that `evaluate --state <file>` persists (JSON, written atomically under an advisory lock). While a record is `active` for a challenger id + version at a venue × metric, every later check decides `rollback_to_baseline` and serves the baseline even if the weekly rule alone says `keep` (reported as `weekly_verdict`); each check's verdict is added to the record as a weekly re-confirmation. The only way back is a person re-running the Phase 2 gate and passing it: `evaluate --state <file> --reinstate --sign-off` marks the record `reinstated` for each venue × metric whose gate passed, and leaves it active otherwise. A new challenger version is a new challenger (it must pass the gate before it goes live), so an old record does not hold it.

**Alert de-duplication.** `alert_id` = hash of venue, metric, challenger id, challenger version and the **trigger week** (the last week of the first all-worse run of 4 in the current unbroken streak of worse weeks). It is therefore the same on every re-run and in every later week while the challenger stays worse, with or without a state file; with a state file it comes from the record. `new` is true only on the check that started the rollback. Consumers de-duplicate on `alert_id`.

### Phase 2 gate (`beats_baseline`)

On the hold-out weeks (default the **last 8 complete weeks**, or explicit Mondays; optional `training_end` must be before the first hold-out week):

- no hold-out forecast (either log) may have a logged `training_end` on or after its target week's Monday, so the model has never seen the week it is scored on; the forecast log carries `training_end` (nullable date, `≤ as_of`; blank for the baseline, which is not trained), and a sign-off run (`evaluate --sign-off`, also required for `--reinstate`) makes it mandatory on every challenger row;

- every hold-out week evaluable (as above), else `insufficient_data`;
- pooled challenger WAPE **strictly lower** than the baseline's (configurable minimum improvement, default 0);
- challenger strictly better in at least **N of M** weeks, N = ⌈0.75 × M⌉ (**6 of 8** by default).

Interval coverage is reported but not part of the gate (see below).

## Consequences

- Easier: LightGBM plugs in through `ForecastModel` (`model.py`), writes the same forecast log, and gets accuracy, rollback and the gate for free. It can reuse `IntervalCalibrator` for conformal-style ranges if its quantile range under-covers.
- Easier: every number on screen can be traced to a rule (`rule`, `trend_rule`, `interval_rule`, `reference_days`).
- Harder: holiday handling depends on a correct venue calendar with stable holiday keys; until `packages/core` provides one, holidays fall back to the normal chain. The synthetic calendar is an approximation of WA holidays for tests only.
- Harder: the range needs about a year of history to be fully empirical; new venues get the wide fallback band for their first weeks.
- Backtest on two years of synthetic data (`forecast/README.md`): WAPE about 9.5% at every horizon and 79% of actuals inside the 10-90 range. These numbers describe the synthetic generator, not any client.
- Reusable in the core: all of it. Client-specific: the calendar and any non-default thresholds (as data).

### For Lachlan to decide

1. Gate defaults: 8 hold-out weeks and 6 of 8 winning weeks, with no minimum improvement margin. Should Phase 2 require a margin (for example 5% lower WAPE) and a coverage floor for the challenger's range (for example 70-90% for a 10-90 range)?
2. Rollback pools all horizons 1-28. Should it weight the horizons managers use most (for example 1-7 days for rostering)?
3. Weeks run Monday to Sunday. Confirm this matches how venues report.
4. `insufficient_data` keeps the challenger live (unless a rollback already stands). The alternative is to fall back to the baseline after N insufficient weeks (an outage signal). Which do we want?
5. A later `unforecastable` re-issue of the same target and horizon supersedes an earlier point, so that point is no longer scored ("only the latest issue counts", applied literally). The alternative is to keep scoring the last issue that _had_ a point. The chosen rule means a model cannot be judged on a number it withdrew, but it also means a model that withdraws hard days drops them from its own accuracy; the rollback and gate comparison still requires the challenger to cover 90% of the baseline's scored forecasts each week, which limits that. Confirm.
