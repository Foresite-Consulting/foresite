"""Data contract: daily actuals, calendar and interval actuals (SYNTHETIC data)."""

from __future__ import annotations

import math
from datetime import date
from pathlib import Path

import pytest

from foresite_forecast import csvio
from foresite_forecast.errors import DataValidationError, ValidationIssue
from foresite_forecast.schema import (
    CLOSED,
    MISSING,
    OPEN,
    DailyActuals,
    Series,
    VenueCalendar,
    daily_actuals_from_intervals,
    daily_actuals_from_rows,
    read_calendar,
    read_daily_actuals,
    read_interval_actuals,
    write_daily_actuals,
)

HEADER = "venue_id,section_id,trading_day,status,net_sales_ex_gst_cents,covers,labour_cost_cents\n"


def csv(body: str, header: str = HEADER) -> bytes:
    return (header + body).encode()


def issues_of(data: bytes) -> list[str]:
    with pytest.raises(DataValidationError) as info:
        read_daily_actuals(data)
    return [str(i) for i in info.value.issues]


def test_reads_valid_file_and_builds_series() -> None:
    actuals = read_daily_actuals(
        csv(
            "SYNTH-V,bar,2026-01-01,open,1000,10,300\n"
            "SYNTH-V,bar,2026-01-02,closed,,,\n"
            "SYNTH-V,bar,2026-01-03,missing,,,\n"
            "SYNTH-V,bar,2026-01-04,,2000,,\n"
            "SYNTH-V,deck,2026-01-02,open,5,1,0\n"
        )
    )
    assert actuals.metrics == ("net_sales_ex_gst_cents", "covers", "labour_cost_cents")
    assert actuals.series_keys() == [("SYNTH-V", "bar"), ("SYNTH-V", "deck")]
    assert actuals.last_day() == date(2026, 1, 4)
    s = actuals.series("SYNTH-V", "bar", "net_sales_ex_gst_cents")
    assert s.start == date(2026, 1, 1)
    assert s.end == date(2026, 1, 4)
    assert list(s.status) == [OPEN, CLOSED, MISSING, OPEN]
    assert s.value_on(date(2026, 1, 1)) == 1000.0
    assert s.value_on(date(2026, 1, 2)) is None
    assert s.value_on(date(2025, 12, 31)) is None
    assert s.status_on(date(2030, 1, 1)) == MISSING
    covers = actuals.series("SYNTH-V", "bar", "covers")
    assert math.isnan(float(covers.values[3]))  # blank optional metric on an open day
    scored = actuals.scored_actuals("net_sales_ex_gst_cents")
    assert scored.height == 3  # closed and missing days are never scored
    with pytest.raises(KeyError, match="metric"):
        actuals.series("SYNTH-V", "bar", "nope")
    with pytest.raises(KeyError, match="no actuals"):
        actuals.series("SYNTH-V", "nope", "covers")
    with pytest.raises(KeyError, match="metric"):
        actuals.scored_actuals("nope")


def test_minimal_columns_and_bom_and_blank_lines(tmp_path: Path) -> None:
    path = tmp_path / "a.csv"
    path.write_bytes(
        b"\xef\xbb\xbfvenue_id,section_id,trading_day,net_sales_ex_gst_cents\r\n"
        b"SYNTH-V,bar,2026-01-01,1\r\n\r\nSYNTH-V,bar,2026-01-02,0\r\n"
    )
    actuals = read_daily_actuals(path)
    assert actuals.metrics == ("net_sales_ex_gst_cents",)
    assert len(actuals.rows) == 2


@pytest.mark.parametrize(
    ("body", "expected"),
    [
        ("SYNTH-V,bar,2026-01-01,open,-5,,\n", "must not be negative"),
        ("SYNTH-V,bar,2026-01-01,open,12.50,,\n", "whole number of cents"),
        ('SYNTH-V,bar,2026-01-01,open,"1,000",,\n', "whole number of cents"),
        ("SYNTH-V,bar,2026-01-01,open,12345678901234,,\n", "at most 13 digits"),
        ("SYNTH-V,bar,2026-01-01,open,1,2.5,\n", "whole number (at most 13 digits)"),
        ("SYNTH-V,bar,2026-01-01,open,,,\n", "is required on an open day"),
        ("SYNTH-V,bar,2026-01-01,closed,100,,\n", "blank or 0 on a closed day"),
        ("SYNTH-V,bar,2026-01-01,missing,0,,\n", "blank on a missing day"),
        ("SYNTH-V,bar,2026-01-01,shut,1,,\n", "open, closed or missing"),
        ("SYNTH-V,bar,2026-02-30,open,1,,\n", "real date"),
        ("SYNTH-V,bar,2026-1-5,open,1,,\n", "real date"),
        ("SYNTH-V,,2026-01-01,open,1,,\n", "column 'section_id': is required"),
        (",bar,2026-01-01,open,1,,\n", "column 'venue_id': is required"),
        ("SYNTH-V,bar,,open,1,,\n", "column 'trading_day': is required"),
        ("=HYPERLINK(1),bar,2026-01-01,open,1,,\n", "starting with a letter or digit"),
        ("SYNTH-V,-bar,2026-01-01,open,1,,\n", "starting with a letter or digit"),
        ("SYNTH-V,bar bar,2026-01-01,open,1,,\n", "letters, digits"),
        (
            "SYNTH-V,bar,2026-01-01,open,1,,\nSYNTH-V,bar,2026-01-01,open,2,,\n",
            "duplicate of line 2",
        ),
        ("SYNTH-V,bar,2026-01-01,open,1,,\nSYNTH-V,bar,2026-01-04,open,2,,\n", "have no row"),
        ("SYNTH-V,bar,2026-01-01,open,1,,\nSYNTH-V,bar\n", "expected 7 fields, found 2"),
        ("SYNTH-V,bar,2026-01-01,open,1,,,extra\n", "expected 7 fields, found 8"),
        ('SYNTH-V,bar,2026-01-01,open,"1\n', "bad CSV"),
        ("", "no data rows"),
    ],
)
def test_rejects_bad_rows_with_clear_messages(body: str, expected: str) -> None:
    messages = issues_of(csv(body))
    assert any(expected in m for m in messages), messages


def test_line_numbers_point_at_the_bad_line() -> None:
    messages = issues_of(csv("SYNTH-V,bar,2026-01-01,open,1,,\nSYNTH-V,bar,2026-01-02,open,x,,\n"))
    assert messages[0].startswith("line 3, column 'net_sales_ex_gst_cents'")
    assert "(got 'x')" in messages[0]


def test_gap_message_lists_days() -> None:
    body = "SYNTH-V,bar,2026-01-01,open,1,,\nSYNTH-V,bar,2026-01-12,open,1,,\n"
    (message,) = issues_of(csv(body))
    assert "10 trading day(s)" in message
    assert "2026-01-02" in message
    assert "and 5 more" in message
    assert "status=missing" in message


@pytest.mark.parametrize(
    ("data", "expected"),
    [
        (b"", "file is empty"),
        (b"venue_id,section_id,trading_day\n", "required column is missing"),
        (
            b"venue_id,section_id,trading_day,net_sales_cents\n",
            "unknown column; expected only",
        ),
        (
            b"venue_id,venue_id,section_id,trading_day,net_sales_ex_gst_cents\n",
            "appears more than once",
        ),
        (b"\xff\xfe\x00", "not valid UTF-8"),
        (b'"venue_id\n', "bad CSV"),
    ],
)
def test_rejects_bad_files(data: bytes, expected: str) -> None:
    messages = issues_of(data)
    assert any(expected in m for m in messages), messages


def test_rejects_oversized_file(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(csvio, "MAX_INPUT_BYTES", 10)
    assert any("larger than" in m for m in issues_of(csv("SYNTH-V,bar,2026-01-01,open,1,,\n")))


def test_error_message_lists_problems_and_truncates() -> None:
    body = "".join(f"SYNTH-V,bar,2026-01-{d:02d},open,-1,,\n" for d in range(1, 26))
    with pytest.raises(DataValidationError) as info:
        read_daily_actuals(csv(body), source="upload.csv")
    text = str(info.value)
    assert text.startswith("upload.csv: 25 problems found")
    assert "... and 5 more" in text
    assert len(info.value.issues) == 25


def test_validation_issue_formatting() -> None:
    assert str(ValidationIssue("bad")) == "bad"
    long = ValidationIssue("bad", line=3, column="c", value="x" * 60)
    assert str(long) == f"line 3, column 'c': bad (got '{'x' * 40}...')"
    one = DataValidationError("f", [ValidationIssue("only")])
    assert str(one) == "f: 1 problem found\n  - only"
    with pytest.raises(ValueError, match="at least one issue"):
        DataValidationError("f", [])


def test_from_rows_uses_the_same_checks() -> None:
    actuals = daily_actuals_from_rows(
        [
            {
                "venue_id": "SYNTH-V",
                "section_id": "bar",
                "trading_day": date(2026, 1, 1),
                "net_sales_ex_gst_cents": 10,
            },
            {
                "venue_id": "SYNTH-V",
                "section_id": "bar",
                "trading_day": "2026-01-02",
                "net_sales_ex_gst_cents": "20",
                "status": "open",
            },
        ]
    )
    assert [r.metrics["net_sales_ex_gst_cents"] for r in actuals.rows] == [10, 20]
    with pytest.raises(DataValidationError, match="whole number of cents"):
        daily_actuals_from_rows(
            [
                {
                    "venue_id": "SYNTH-V",
                    "section_id": "bar",
                    "trading_day": date(2026, 1, 1),
                    "net_sales_ex_gst_cents": 10.5,
                }
            ]
        )
    with pytest.raises(DataValidationError, match="whole number of cents"):
        daily_actuals_from_rows(
            [
                {
                    "venue_id": "SYNTH-V",
                    "section_id": "bar",
                    "trading_day": date(2026, 1, 1),
                    "net_sales_ex_gst_cents": True,
                }
            ]
        )
    with pytest.raises(DataValidationError, match="unknown column"):
        daily_actuals_from_rows(
            [
                {
                    "venue_id": "a",
                    "section_id": "b",
                    "trading_day": "2026-01-01",
                    "net_sales_ex_gst_cents": 1,
                    "tips": 3,
                }
            ]
        )
    with pytest.raises(DataValidationError, match="required column is missing"):
        daily_actuals_from_rows([{"venue_id": "a", "section_id": "b"}])


def test_write_then_read_round_trip(tmp_path: Path) -> None:
    original = read_daily_actuals(
        csv("SYNTH-V,bar,2026-01-01,open,1000,10,\nSYNTH-V,bar,2026-01-02,closed,0,0,0\n")
    )
    path = tmp_path / "out.csv"
    write_daily_actuals(path, original)
    again = read_daily_actuals(path)
    assert again.rows == original.rows


def test_empty_actuals_has_no_last_day() -> None:
    with pytest.raises(ValueError, match="no actuals"):
        DailyActuals([], ("net_sales_ex_gst_cents",)).last_day()


def test_series_rejects_mismatched_arrays() -> None:
    import numpy as np

    with pytest.raises(ValueError, match="same length"):
        Series("a", "b", "m", date(2026, 1, 1), np.zeros(2), np.zeros(3, dtype=np.int8))


# -- calendar -------------------------------------------------------------------------

CAL_HEADER = "venue_id,trading_day,kind,holiday_key\n"


def test_calendar_reads_holidays_and_closures(tmp_path: Path) -> None:
    path = tmp_path / "cal.csv"
    path.write_text(
        CAL_HEADER
        + ",2026-12-25,public_holiday,christmas_day\n"
        + ",2026-12-25,closed,\n"
        + "SYNTH-V,2026-12-25,public_holiday,christmas_local\n"
        + "SYNTH-V,2026-06-01,closed,\n"
        + ",2025-12-25,public_holiday,christmas_day\n"
    )
    cal = read_calendar(path)
    assert cal.holiday_key("OTHER", date(2026, 12, 25)) == "christmas_day"
    assert cal.holiday_key("SYNTH-V", date(2026, 12, 25)) == "christmas_local"  # venue wins
    assert cal.holiday_key("SYNTH-V", date(2026, 12, 24)) is None
    assert cal.is_closed("OTHER", date(2026, 12, 25))
    assert cal.is_closed("SYNTH-V", date(2026, 6, 1))
    assert not cal.is_closed("OTHER", date(2026, 6, 1))
    assert cal.occurrences("OTHER", "christmas_day") == [date(2025, 12, 25), date(2026, 12, 25)]
    assert cal.occurrences("SYNTH-V", "christmas_day") == [date(2025, 12, 25)]
    assert cal.occurrences("SYNTH-V", "christmas_local") == [date(2026, 12, 25)]
    assert VenueCalendar.empty().holiday_key("x", date(2026, 1, 1)) is None


@pytest.mark.parametrize(
    ("body", "expected"),
    [
        (",2026-12-25,holiday,xmas\n", "public_holiday or closed"),
        (",2026-12-25,public_holiday,\n", "is required for a public holiday"),
        (",2026-12-25,public_holiday,Christmas Day\n", "lower-case"),
        (",2026-12-25,closed,xmas\n", "must be blank for a closed day"),
        (",2026-13-25,closed,\n", "real date"),
        ("=x,2026-12-25,closed,\n", "starting with a letter or digit"),
        (",2026-12-25,closed,\n,2026-12-25,closed,\n", "duplicate of line 2"),
    ],
)
def test_calendar_rejects_bad_rows(body: str, expected: str) -> None:
    with pytest.raises(DataValidationError) as info:
        read_calendar((CAL_HEADER + body).encode())
    assert any(expected in str(i) for i in info.value.issues), info.value.issues


# -- interval actuals ------------------------------------------------------------------

IV_HEADER = (
    "venue_id,section_id,trading_day,interval_start,interval_minutes,"
    "net_sales_ex_gst_cents,covers\n"
)


def test_intervals_aggregate_to_daily_with_explicit_missing_days() -> None:
    rows, metrics = read_interval_actuals(
        (
            IV_HEADER
            + "SYNTH-V,bar,2026-01-01,2026-01-01T23:45,15,100,2\n"
            + "SYNTH-V,bar,2026-01-01,2026-01-02T00:00,15,50,\n"  # after midnight, same trading day
            + "SYNTH-V,bar,2026-01-03,2026-01-03T18:00,60,70,1\n"
        ).encode()
    )
    assert metrics == ("net_sales_ex_gst_cents", "covers")
    daily = daily_actuals_from_intervals(rows, metrics)
    by_day = {r.trading_day: r for r in daily.rows}
    assert by_day[date(2026, 1, 1)].metrics == {"net_sales_ex_gst_cents": 150, "covers": None}
    assert by_day[date(2026, 1, 2)].status == "missing"
    assert by_day[date(2026, 1, 3)].metrics == {"net_sales_ex_gst_cents": 70, "covers": 1}


@pytest.mark.parametrize(
    ("body", "expected"),
    [
        ("SYNTH-V,bar,2026-01-01,2026-01-01 18:00,15,1,\n", "YYYY-MM-DDTHH:MM"),
        ("SYNTH-V,bar,2026-01-01,2026-01-01T25:00,15,1,\n", "not a real date and time"),
        ("SYNTH-V,bar,2026-01-01,2026-01-01T18:00,20,1,\n", "must be 15, 30 or 60"),
        ("SYNTH-V,bar,2026-01-01,2026-01-01T18:10,15,1,\n", "15-minute boundary"),
        ("SYNTH-V,bar,2026-01-01,2026-01-03T01:00,15,1,\n", "next calendar day"),
        ("SYNTH-V,bar,2026-01-01,2026-01-01T18:00,15,,\n", "is required"),
        ("SYNTH-V,bar,2026-01-01,2026-01-01T18:00,15,-1,\n", "must not be negative"),
        (
            "SYNTH-V,bar,2026-01-01,2026-01-01T18:00,15,1,\nSYNTH-V,bar,2026-01-01,2026-01-01T18:00,15,1,\n",
            "duplicate of line 2",
        ),
        ("", "no data rows"),
    ],
)
def test_intervals_reject_bad_rows(body: str, expected: str) -> None:
    with pytest.raises(DataValidationError) as info:
        read_interval_actuals((IV_HEADER + body).encode())
    assert any(expected in str(i) for i in info.value.issues), info.value.issues
