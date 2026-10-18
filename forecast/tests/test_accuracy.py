"""Forecast log and accuracy metrics, checked against hand-worked numbers (SYNTHETIC)."""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta
from pathlib import Path

import polars as pl
import pytest

from foresite_forecast.accuracy import (
    LOG_COLUMNS,
    ForecastLog,
    accuracy_report,
    forecasts_to_frame,
    frame_to_forecasts,
    metrics,
    read_forecast_log,
    rolling_weeks,
    score,
    summarise_accuracy,
    write_forecast_log,
)
from foresite_forecast.errors import DataValidationError
from foresite_forecast.model import Forecast
from tests.helpers import ISSUED, METRIC, SECTION, VENUE, build_actuals, make_forecast

MON = date(2026, 1, 5)


def day(i: int) -> date:
    return MON + timedelta(days=i)


def worked_example() -> tuple[list[Forecast], pl.DataFrame]:
    actuals = build_actuals(MON, [100, 100, 0, "closed", None, 100])
    forecasts = [
        make_forecast(day(0), 500, low=400, high=600, issued_at=ISSUED - timedelta(days=1)),
        make_forecast(day(0), 110, low=90, high=120),  # later issue replaces the one above
        make_forecast(day(1), 80, low=70, high=95),
        make_forecast(day(2), 50, low=0, high=60),
        make_forecast(day(3), 10),  # closed: not scored
        make_forecast(day(4), 10),  # missing: not scored
        make_forecast(day(5), None),  # unforecastable: not scored
        make_forecast(day(6), 10),  # no actual yet: not scored
    ]
    return forecasts, score(forecasts_to_frame(forecasts), actuals)


def test_score_keeps_only_known_open_days_and_latest_issue() -> None:
    _, scored = worked_example()
    assert scored["target_day"].to_list() == [day(0), day(1), day(2)]
    assert scored["point"].to_list() == [110, 80, 50]
    assert scored["error"].to_list() == [10, -20, 50]
    assert scored["in_range"].to_list() == [True, False, True]
    assert scored["weekday"].to_list() == [1, 2, 3]
    assert set(scored["week_start"].to_list()) == {MON}
    assert set(scored["horizon_bucket"].to_list()) == {"1-7"}


def test_identical_issue_times_keep_the_later_row() -> None:
    actuals = build_actuals(MON, [100])
    first = make_forecast(day(0), 90)
    second = make_forecast(day(0), 95)
    for order, expected in (([first, second], 95), ([second, first], 90)):
        scored = score(forecasts_to_frame(order), actuals)
        assert scored["point"].to_list() == [expected]


def test_metric_definitions() -> None:
    _, scored = worked_example()
    (row,) = metrics(scored).iter_rows(named=True)
    assert row["n"] == 3
    assert row["wape"] == pytest.approx(80 / 200)
    assert row["mape"] == pytest.approx((0.10 + 0.20) / 2)  # zero actual left out of MAPE
    assert row["mape_n"] == 2
    assert row["bias"] == pytest.approx(40 / 200)
    assert row["coverage"] == pytest.approx(2 / 3)


def test_wape_and_bias_are_blank_when_actuals_sum_to_zero() -> None:
    actuals = build_actuals(MON, [0, 0])
    scored = score(
        forecasts_to_frame([make_forecast(day(0), 5), make_forecast(day(1), 0)]), actuals
    )
    (row,) = metrics(scored).iter_rows(named=True)
    assert row["wape"] is None
    assert row["bias"] is None
    assert row["mape"] is None
    assert row["mape_n"] == 0


def test_rolling_four_weeks() -> None:
    values: list[int | None | str] = [100] * 35
    actuals = build_actuals(MON, values)
    errors = {0: 10, 1: 20, 3: 40, 4: 50}  # no forecast in week 3 (index 2)
    forecasts = [make_forecast(day(7 * w), 100 + e) for w, e in errors.items()]
    rolled = rolling_weeks(score(forecasts_to_frame(forecasts), actuals))
    rows = {r["week_start"]: r for r in rolled.iter_rows(named=True)}
    assert rows[day(0)]["wape"] == pytest.approx(0.10)
    assert rows[day(0)]["weeks_with_data"] == 1
    assert rows[day(28)]["wape"] == pytest.approx((20 + 40 + 50) / 300)
    assert rows[day(28)]["weeks_with_data"] == 3
    assert day(14) not in rows  # a week with no forecasts has no row


def test_accuracy_report_tables() -> None:
    _, scored = worked_example()
    report = accuracy_report(scored)
    assert set(report.tables()) == {
        "overall",
        "by_horizon",
        "by_horizon_bucket",
        "by_weekday",
        "by_section",
        "by_week",
        "rolling_4_weeks",
    }
    assert report.by_weekday.height == 3
    assert report.by_section["section_id"].to_list() == [SECTION]
    assert report.by_horizon["horizon_days"].to_list() == [1]


def test_horizon_buckets_sort_numerically() -> None:
    actuals = build_actuals(MON, [100] * 40)
    forecasts = [make_forecast(day(30), 100, horizon=h) for h in (20, 9, 2)]
    report = accuracy_report(score(forecasts_to_frame(forecasts), actuals))
    assert report.by_horizon_bucket["horizon_bucket"].to_list() == ["1-7", "8-14", "15-28"]


# -- forecast log --------------------------------------------------------------------


def test_log_round_trip_and_append(tmp_path: Path) -> None:
    forecasts, _ = worked_example()
    path = tmp_path / "log.csv"
    assert write_forecast_log(path, forecasts[:3]) == 3
    assert write_forecast_log(path, forecasts[3:], append=True) == len(forecasts) - 3
    again = read_forecast_log(path)
    assert again == forecasts
    header = path.read_text().splitlines()[0]
    assert header == ",".join(LOG_COLUMNS)
    assert path.read_text().splitlines()[1].startswith("2025-12-31T00:00:00Z,model-a,1,SYNTH-V")


def test_writes_leave_no_temporary_files(tmp_path: Path) -> None:
    write_forecast_log(tmp_path / "log.csv", [make_forecast(day(0), 1)])
    assert [p.name for p in tmp_path.iterdir()] == ["log.csv"]


def test_append_refuses_a_file_that_is_not_a_log(tmp_path: Path) -> None:
    path = tmp_path / "actuals.csv"
    path.write_text("venue_id,section_id,trading_day,net_sales_ex_gst_cents\n")
    with pytest.raises(DataValidationError, match="required column is missing"):
        write_forecast_log(path, [make_forecast(day(0), 1)], append=True)
    assert path.read_text().startswith("venue_id")  # untouched


def test_log_keeps_sub_second_issue_times_and_provenance(tmp_path: Path) -> None:
    issued = datetime(2026, 1, 1, 8, 30, 15, 123456, tzinfo=UTC)
    fc = Forecast(
        issued_at=issued,
        model_id="baseline-swly-trend",
        model_version="1.0.0+cfg.1a2b3c4d",
        venue_id=VENUE,
        section_id=SECTION,
        metric=METRIC,
        as_of=day(0),
        target_day=day(3),
        horizon_days=3,
        point=10,
        low=9,
        high=11,
        rule="same_weekday_last_year_neighbours",
        interval_rule="empirical_horizon",
        interval_n=42,
        trend_factor=1.034567,
        trend_rule="trend_window",
        reference_days=(day(-364), day(-357)),
    )
    path = tmp_path / "log.csv"
    write_forecast_log(path, [fc])
    assert read_forecast_log(path) == [fc]


LOG_HEADER = ",".join(LOG_COLUMNS) + "\n"
GOOD = (
    "2026-01-01T00:00:00Z,m,1,SYNTH-V,s,net_sales_ex_gst_cents,2026-01-01,2026-01-02,1,"
    "10,5,15,r,i,0,1.0,trend_window,2025-01-03\n"
)


@pytest.mark.parametrize(
    ("replace_from", "replace_to", "expected"),
    [
        ("2026-01-01T00:00:00Z", "2026-01-01T00:00:00", "UTC offset"),
        ("2026-01-01T00:00:00Z", "yesterday", "UTC offset"),
        (",m,1,", ",=m,1,", "starting with a letter or digit"),
        (",m,1,", ",m,1 0,", "'_', '.', '+' or '-'"),
        ("2026-01-02,1,", "2026-02-30,1,", "real date"),
        (",1,10,5,15,", ",x,10,5,15,", "whole, non-negative"),
        (",1,10,5,15,", ",,10,5,15,", "is required"),
        (",1,10,5,15,", ",1,10,11,15,", "low <= point <= high"),
        (",1,10,5,15,", ",1,10,-5,15,", "whole, non-negative"),
        (",1,10,5,15,", ",2,10,5,15,", "must equal"),
        (",1,10,5,15,r,", ",1,,,,r,", "rule 'unforecastable'"),
        (",1.0,", ",abc,", "must be a number"),
        (",1.0,", ",nan,", "must be a number"),
        (",trend_window,", ",trend window,", "letters, digits"),
        (",2025-01-03\n", ",2025-01-03;x\n", "separated by ';'"),
    ],
)
def test_log_rejects_bad_rows(replace_from: str, replace_to: str, expected: str) -> None:
    body = GOOD.replace(replace_from, replace_to, 1)
    assert body != GOOD
    with pytest.raises(DataValidationError) as info:
        read_forecast_log((LOG_HEADER + body).encode())
    assert any(expected in str(i) for i in info.value.issues), info.value.issues


def test_log_without_optional_columns() -> None:
    header = "issued_at,model_id,model_version,venue_id,section_id,metric,as_of,target_day,"
    header += "horizon_days,point,low,high,rule\n"
    body = "2026-01-01T08:00:00+08:00,lgbm,3,SYNTH-V,s,covers,2026-01-01,2026-01-02,1,"
    body += ",,,unforecastable\n"
    (fc,) = read_forecast_log((header + body).encode())
    assert fc.issued_at == datetime(2026, 1, 1, tzinfo=UTC)
    assert not fc.forecastable


def test_in_memory_log(tmp_path: Path) -> None:
    forecasts, _ = worked_example()
    log = ForecastLog()
    log.add(forecasts[:2])
    log.add(forecasts[2:])
    assert len(log) == len(forecasts)
    assert log.forecasts == tuple(forecasts)
    actuals = build_actuals(MON, [100, 100, 0, "closed", None, 100])
    assert log.score(actuals).height == 3
    path = tmp_path / "log.csv"
    log.write(path)
    assert ForecastLog.read(path).forecasts == tuple(forecasts)
    assert frame_to_forecasts(log.to_frame()) == forecasts


def test_frame_to_forecasts_checks_types() -> None:
    frame = forecasts_to_frame([make_forecast(day(0), 1)]).with_columns(
        model_id=pl.lit(None, dtype=pl.String)
    )
    with pytest.raises(TypeError, match="model_id must be str"):
        frame_to_forecasts(frame)


# -- accuracy to date (UI tile) ------------------------------------------------------


def tile_scored(points: list[int], horizon: int = 7) -> pl.DataFrame:
    actuals = build_actuals(MON, [100] * len(points))
    forecasts = [
        make_forecast(day(i), p, horizon=horizon, low=p - 15, high=p + 4)
        for i, p in enumerate(points)
    ]
    return score(forecasts_to_frame(forecasts), actuals)


def test_tile_reports_range_hits_and_typical_error() -> None:
    points = [106] * 60 + [140] * 10  # 10 misses well above the range
    summary = summarise_accuracy(
        tile_scored(points), as_of=day(69), model_id="model-a", venue_id=VENUE, metric=METRIC
    )
    assert summary.status == "ok"
    assert (summary.scored, summary.in_range) == (70, 60)
    assert summary.typical_error_pct == round(100 * (60 * 6 + 10 * 40) / 7000)
    assert summary.headline == "In the likely range 60 of 70 times in the last 10 weeks."
    assert summary.detail == "Typical error 11% (a week ahead). Tends to run high by 11%."
    assert summary.disclaimer == "Forecasts are estimates, not guarantees."
    assert summary.as_dict()["headline"] == summary.headline


def test_tile_low_bias_backtest_label_and_other_horizons() -> None:
    summary = summarise_accuracy(
        tile_scored([90] * 30, horizon=1),
        as_of=day(29),
        model_id="model-a",
        venue_id=VENUE,
        metric=METRIC,
        section_id=SECTION,
        horizon_days=1,
        basis="backtest",
    )
    assert summary.detail == (
        "Typical error 10% (a day ahead). Tends to run low by 10%. "
        "Based on a backtest, not live forecasts yet."
    )
    small_bias = summarise_accuracy(
        tile_scored([102] * 30, horizon=14),
        as_of=day(29),
        model_id="model-a",
        venue_id=VENUE,
        metric=METRIC,
        horizon_days=14,
    )
    assert small_bias.detail == "Typical error 2% (14 days ahead)."


def test_tile_needs_enough_history() -> None:
    summary = summarise_accuracy(
        tile_scored([100] * 10), as_of=day(9), model_id="model-a", venue_id=VENUE, metric=METRIC
    )
    assert summary.status == "insufficient_history"
    assert summary.typical_error_pct is None
    assert summary.headline == "Not enough history yet to show accuracy."
    assert "(10 so far)" in summary.detail
    empty = summarise_accuracy(
        tile_scored([100] * 10), as_of=day(9), model_id="other", venue_id=VENUE, metric=METRIC
    )
    assert (empty.scored, empty.in_range) == (0, 0)


def test_tile_with_zero_actuals() -> None:
    actuals = build_actuals(MON, [0] * 30)
    scored = score(
        forecasts_to_frame([make_forecast(day(i), 0, horizon=7) for i in range(30)]), actuals
    )
    summary = summarise_accuracy(
        scored, as_of=day(29), model_id="model-a", venue_id=VENUE, metric=METRIC
    )
    assert summary.typical_error_pct is None
    assert summary.detail == "Typical error can't be worked out because actuals were zero."
