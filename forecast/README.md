# forecast

The Python forecast engine: the **baseline** forecast, its **likely range**, **accuracy tracking**, and the **champion/challenger** rules that roll back to the baseline when a model goes wrong. LightGBM arrives in a later PR and plugs into the same interfaces.

Forecasts are estimates, never guarantees.

## How it works, in plain English

- **The forecast.** To forecast a Saturday, we take the Saturday 52 weeks earlier and scale it by how the venue has been tracking lately compared with a year ago (the last 8 weeks against the same 8 weeks last year). Public holidays are matched with last year's same holiday, even when the date moves (Easter). If last year's day can't be used (closed, no data, or a holiday when this year's day isn't), we use the same weekday in the surrounding weeks, then the recent same-weekday median, and if there is still nothing, we say we can't forecast that day rather than guess.
- **The likely range.** We look at how far off this forecast has been over the past year, for the same weekday and a similar distance ahead, and draw the range so roughly 8 in 10 actuals land inside it. It is a likely range, not a promise. While a venue is new and there isn't enough history, the range is deliberately wide.
- **Accuracy to date.** Every forecast is logged. Once the day has happened we check it: "In the likely range 57 of 70 times in the last 10 weeks. Typical error 8% (a week ahead)."
- **Rollback.** When the smarter model (LightGBM) is live, we compare it with this simple forecast every week. If it is worse four complete weeks running, we switch back to the simple forecast and raise an alert. One bad week, a week with missing data or a week that hasn't finished never triggers it.
- **The Phase 2 test.** Before sign-off, the model must beat this simple forecast on recent weeks it was not trained on: lower error overall and in at least 6 of 8 weeks.

Every number records the rule that produced it, so anyone can see why a forecast is what it is.

## Technical summary

The exact definitions (baseline chain, trend, range, metrics, rollback, gate) are in [`docs/adr/0004-forecast-baseline-and-accuracy.md`](../docs/adr/0004-forecast-baseline-and-accuracy.md). Metric and column definitions are in the `## Forecasts` section of [`docs/data-dictionary.md`](../docs/data-dictionary.md).

| Module         | What it does                                                                                              |
| -------------- | --------------------------------------------------------------------------------------------------------- |
| `schema.py`    | Data contract: daily actuals, optional interval actuals and venue calendar; validation with line numbers  |
| `model.py`     | The `Forecast` record (invariants checked on construction) and the `ForecastModel` interface              |
| `baseline.py`  | Same weekday last year × trend, fallback chain, provenance; `BaselineModel.forecast` and `.backtest`      |
| `intervals.py` | Empirical likely range from past errors by weekday and horizon bucket; works for any model's residuals    |
| `accuracy.py`  | Forecast log (CSV and in-memory), scoring, WAPE/MAPE/bias/coverage tables, the "accuracy to date" summary |
| `selection.py` | Weekly challenger vs baseline comparison, rollback decision and alert, Phase 2 gate                       |
| `synthetic.py` | SYNTHETIC data (weekday pattern, Southern Hemisphere seasons, growth, holidays, a closure, a gap, noise)  |
| `cli.py`       | `python -m foresite_forecast ...`                                                                         |

Dependencies: **numpy 2.5.3** (arrays, quantiles) and **polars 1.44.2** (joins and group-bys for accuracy; fully typed, so `mypy --strict` needs no stubs or ignores). CSV is parsed with the standard library so every malformed line is reported with its line number. Dev: hypothesis (property tests), pytest-cov (coverage gate at 95%), plus the scaffold's ruff, mypy, pytest and pip-audit. All pinned in `pyproject.toml` and locked in `uv.lock`.

A LightGBM model implements `ForecastModel.forecast(actuals, as_of, metric=, horizons=, issued_at=, calendar=)` and returns `Forecast` records with its own `model_id`, `rule` (e.g. `lightgbm_quantile`) and `interval_rule`. Logging, accuracy, rollback and the gate then work unchanged.

## Command line

All commands print plain text; `accuracy` and `evaluate` also take `--json`. Exit code 0 when the command ran (a rollback decision is a result, not an error) and 2 for bad input, with a message and no traceback.

```sh
cd forecast
uv sync --locked

# SYNTHETIC demo data: synthetic_actuals.csv and synthetic_calendar.csv
uv run python -m foresite_forecast synthetic --out-dir /tmp/fs

# Issue forecasts 1-28 days after the as-of day (the last day with complete actuals)
uv run python -m foresite_forecast baseline --input /tmp/fs/synthetic_actuals.csv \
  --calendar /tmp/fs/synthetic_calendar.csv --as-of 2026-10-18 --horizon 28 \
  --out /tmp/fs/forecasts.csv [--log /tmp/fs/forecast_log.csv] [--issued-at 2026-10-19T00:00:00Z]

# Forecasts as they would have been issued on each past day
uv run python -m foresite_forecast backtest --input /tmp/fs/synthetic_actuals.csv \
  --calendar /tmp/fs/synthetic_calendar.csv --start 2024-10-19 --end 2026-10-17 \
  --out /tmp/fs/baseline_log.csv

# Accuracy tables (overall, by horizon, bucket, weekday, section, week, rolling 4 weeks)
uv run python -m foresite_forecast accuracy --forecasts /tmp/fs/baseline_log.csv \
  --actuals /tmp/fs/synthetic_actuals.csv [--out-dir /tmp/fs/accuracy] [--json]

# A SYNTHETIC challenger that is good, bad, or good until a day and bad from then (testing only)
uv run python -m foresite_forecast synthetic-challenger --baseline-log /tmp/fs/baseline_log.csv \
  --actuals /tmp/fs/synthetic_actuals.csv --quality good --degrade-from 2026-09-21 \
  --out /tmp/fs/challenger.csv

# Rollback decision and Phase 2 gate
uv run python -m foresite_forecast evaluate --challenger /tmp/fs/challenger.csv \
  --baseline /tmp/fs/baseline_log.csv --actuals /tmp/fs/synthetic_actuals.csv \
  [--evaluation-day 2026-10-18] [--holdout-weeks 8] [--training-end 2026-08-01] \
  [--alerts-out /tmp/fs/alerts.jsonl] [--json]
```

`baseline` also prints the accuracy-to-date line for each section: from the live log if `--log` holds enough history, otherwise from a backtest of the last 10 weeks, labelled as such.

## File formats

All files are UTF-8 CSV with a header row (a byte-order mark from Excel is fine). Dates are `YYYY-MM-DD`; money is whole **cents, ex GST**; counts are whole numbers. Identifiers are 1-64 letters, digits, `_`, `.` or `-` and start with a letter or digit (so no value can be read as a spreadsheet formula). Unknown columns are rejected, so a typo in a header is caught.

**Daily actuals** (input): one row per venue × section × trading day.

| Column                   | Required | Notes                                                                      |
| ------------------------ | -------- | -------------------------------------------------------------------------- |
| `venue_id`, `section_id` | yes      |                                                                            |
| `trading_day`            | yes      | Open-to-close trading day in venue local time                              |
| `status`                 | no       | `open` (default when blank), `closed` (did not trade), `missing` (unknown) |
| `net_sales_ex_gst_cents` | yes      | Required on open days; blank or 0 on closed days; blank on missing days    |
| `covers`                 | no       | Blank on an open day means unknown for that metric                         |
| `labour_cost_cents`      | no       | As for `covers`                                                            |

Each series must be contiguous from its first to its last day: a day without data needs a row with `status=missing` (or `closed`). Duplicates, negatives, decimals in cents and silent gaps are rejected with every problem listed by line.

**Calendar** (input, optional): `venue_id` (blank = every venue), `trading_day`, `kind` (`public_holiday` or `closed`), `holiday_key` (required for a holiday, the same every year, e.g. `easter_monday`). A `closed` day is forecast as 0 with a 0-0 range.

**Interval actuals** (input, optional): `venue_id`, `section_id`, `trading_day`, `interval_start` (local `YYYY-MM-DDTHH:MM`, on the trading day or the next calendar day), `interval_minutes` (15, 30 or 60, start aligned), metric columns. `daily_actuals_from_intervals` sums them; days with no intervals become explicit `missing` rows.

**Forecasts / forecast log** (output of `baseline` and `backtest`, input of `accuracy` and `evaluate`): `issued_at` (ISO 8601 with offset, written in UTC with `Z`), `model_id`, `model_version`, `venue_id`, `section_id`, `metric`, `as_of`, `target_day`, `horizon_days` (1-28), `point`, `low`, `high` (blank for `unforecastable`), `rule`, then optional provenance columns `interval_rule`, `interval_n`, `trend_factor`, `trend_rule`, `reference_days` (`;`-separated). Every row is re-checked on read (`0 ≤ low ≤ point ≤ high`, horizon matches the dates, provenance set). `--log` appends; the latest issue of the same target and horizon wins when scoring.

**Alerts** (output of `evaluate --alerts-out`): one JSON object per line with `alert_id`, `kind` (`forecast_rollback`), `severity`, `venue_id`, `metric`, model ids, the four weeks with both WAPEs, and a plain-English `message`. No personal data.

## Backtest on SYNTHETIC data

Two years of daily origins (19 Oct 2024 to 17 Oct 2026, all 28 horizons, two sections, about 40 000 forecasts) on the default synthetic series (8% day-level noise):

| Horizon       | WAPE | In the 10-90 range |
| ------------- | ---- | ------------------ |
| 1 day         | 9.5% | 78.1%              |
| 7 days        | 9.5% | 77.8%              |
| 14 days       | 9.5% | 78.2%              |
| 28 days       | 9.5% | 80.6%              |
| All 1-28 days | 9.5% | 79.2%              |

The baseline's error barely changes with the horizon because the trend factor is fixed at issue time. These numbers describe the synthetic generator only; real venues will differ. The end-to-end test (`tests/test_end_to_end.py`) pins them within tolerance and runs a degrading challenger through the rollback rule (rolls back after the fourth worse week, not the third).

## Run the checks

```sh
cd forecast
uv sync --locked
uv run ruff check .
uv run ruff format --check .
uv run mypy
uv run pytest          # includes coverage, fails under 95%
uv run pip-audit --skip-editable
```

Property-based tests run deterministically (`derandomize=True`), so CI sees the same examples every time. Update the lock with `uv lock` and commit it.
