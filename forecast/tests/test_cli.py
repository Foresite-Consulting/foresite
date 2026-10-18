"""The command line, end to end on SYNTHETIC files."""

from __future__ import annotations

import fcntl
import json
import subprocess
import sys
from pathlib import Path

import polars as pl
import pytest

from foresite_forecast.accuracy import LOG_COLUMNS, read_forecast_log
from foresite_forecast.cli import build_parser, main


@pytest.fixture(scope="module")
def files(tmp_path_factory: pytest.TempPathFactory) -> Path:
    """SYNTHETIC actuals and calendar (18 months), plus a baseline backtest log."""
    d = tmp_path_factory.mktemp("cli")
    assert (
        main(["synthetic", "--out-dir", str(d), "--start", "2024-01-01", "--end", "2025-06-30"])
        == 0
    )
    assert (
        main(
            [
                "backtest",
                "--input",
                str(d / "synthetic_actuals.csv"),
                "--calendar",
                str(d / "synthetic_calendar.csv"),
                "--start",
                "2025-03-01",
                "--end",
                "2025-06-28",
                "--out",
                str(d / "baseline_log.csv"),
            ]
        )
        == 0
    )
    return d


def run(capsys: pytest.CaptureFixture[str], *argv: str) -> tuple[int, str, str]:
    code = main(list(argv))
    out, err = capsys.readouterr()
    return code, out, err


def test_baseline_command(files: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    out_csv = tmp_path / "forecasts.csv"
    log = tmp_path / "log.csv"
    args = (
        "baseline",
        "--input",
        str(files / "synthetic_actuals.csv"),
        "--calendar",
        str(files / "synthetic_calendar.csv"),
        "--as-of",
        "2025-06-30",
        "--horizon",
        "14",
        "--out",
        str(out_csv),
        "--issued-at",
        "2025-07-01T00:00:00Z",
        "--log",
        str(log),
    )
    code, out, _ = run(capsys, *args)
    assert code == 0
    assert "Wrote 28 forecasts" in out
    assert "(as of 30 Jun 2025)" in out
    assert "Accuracy to date:" in out
    assert "Based on a backtest, not live forecasts yet." in out
    assert "Forecasts are estimates, not guarantees." in out
    forecasts = read_forecast_log(out_csv)
    assert {f.horizon_days for f in forecasts} == set(range(1, 15))
    assert out_csv.read_text().splitlines()[0] == ",".join(LOG_COLUMNS)
    # Running again appends to the log; the latest issue wins when scoring.
    assert run(capsys, *args)[0] == 0
    assert len(read_forecast_log(log)) == 56


def test_baseline_tile_uses_live_log_when_it_has_enough(
    files: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    out_csv = tmp_path / "f.csv"
    code, out, _ = run(
        capsys,
        "baseline",
        "--input",
        str(files / "synthetic_actuals.csv"),
        "--calendar",
        str(files / "synthetic_calendar.csv"),
        "--as-of",
        "2025-06-30",
        "--out",
        str(out_csv),
        "--log",
        str(files / "baseline_log.csv"),
    )
    assert code == 0
    assert "In the likely range" in out
    assert "Based on a backtest" not in out


def test_accuracy_command(files: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    code, out, _ = run(
        capsys,
        "accuracy",
        "--forecasts",
        str(files / "baseline_log.csv"),
        "--actuals",
        str(files / "synthetic_actuals.csv"),
        "--out-dir",
        str(tmp_path / "acc"),
    )
    assert code == 0
    assert "By horizon bucket" in out
    assert "WAPE" in out
    rolling = tmp_path / "acc" / "accuracy_rolling_4_weeks.csv"
    table = pl.read_csv(rolling, try_parse_dates=True)
    assert {"week_start", "wape", "coverage", "weeks_with_data"} <= set(table.columns)
    assert table.height > 0
    assert table["wape"].dtype == pl.Float64
    assert not [p.name for p in (tmp_path / "acc").iterdir() if p.name.startswith(".")]
    code, out, _ = run(
        capsys,
        "accuracy",
        "--forecasts",
        str(files / "baseline_log.csv"),
        "--actuals",
        str(files / "synthetic_actuals.csv"),
        "--json",
    )
    assert code == 0
    assert set(json.loads(out)) >= {"overall", "by_horizon", "rolling_4_weeks"}


def test_accuracy_out_dir_never_overwrites_an_input(
    files: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    inputs = tmp_path / "in"
    inputs.mkdir()
    victim = inputs / "accuracy_overall.csv"  # an input that happens to share a table's name
    victim.write_bytes((files / "baseline_log.csv").read_bytes())
    before = victim.read_bytes()
    code, _, err = run(
        capsys,
        "accuracy",
        "--forecasts",
        str(victim),
        "--actuals",
        str(files / "synthetic_actuals.csv"),
        "--out-dir",
        str(inputs),
    )
    assert code == 2
    assert "would overwrite an input file" in err
    assert victim.read_bytes() == before
    assert sorted(p.name for p in inputs.iterdir()) == ["accuracy_overall.csv"]


def test_alerts_out_is_written_atomically(
    files: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch
) -> None:
    bad = tmp_path / "bad.csv"
    code, _, _ = run(
        capsys,
        "synthetic-challenger",
        "--baseline-log",
        str(files / "baseline_log.csv"),
        "--actuals",
        str(files / "synthetic_actuals.csv"),
        "--quality",
        "bad",
        "--out",
        str(bad),
    )
    assert code == 0
    alerts = tmp_path / "alerts.jsonl"
    alerts.write_text("previous run\n")
    argv = [
        "evaluate",
        "--challenger",
        str(bad),
        "--baseline",
        str(files / "baseline_log.csv"),
        "--actuals",
        str(files / "synthetic_actuals.csv"),
        "--alerts-out",
        str(alerts),
    ]

    def disk_full(*_a: object, **_k: object) -> str:
        raise OSError("disk full")

    with monkeypatch.context() as patch:
        patch.setattr(json, "dumps", disk_full)
        code, _, err = run(capsys, *argv)
    assert code == 2
    assert "disk full" in err
    assert alerts.read_text() == "previous run\n"  # a failed write leaves the old file
    assert sorted(p.name for p in tmp_path.iterdir()) == ["alerts.jsonl", "bad.csv"]
    code, _, _ = run(capsys, *argv)
    assert code == 0
    (alert,) = [json.loads(line) for line in alerts.read_text().splitlines()]
    assert alert["kind"] == "forecast_rollback"


def test_locked_log_exits_2(
    files: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    log = tmp_path / "log.csv"
    argv = [
        "baseline",
        "--input",
        str(files / "synthetic_actuals.csv"),
        "--as-of",
        "2025-06-30",
        "--horizon",
        "2",
        "--out",
        str(tmp_path / "f.csv"),
        "--log",
        str(log),
    ]
    with (tmp_path / "log.csv.lock").open("a") as other:
        fcntl.flock(other.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        code, _, err = run(capsys, *argv)
    assert code == 2
    assert "only one writer per log at a time" in err
    assert not log.exists()


def test_evaluate_rollback_scenario(
    files: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    degrading = tmp_path / "degrading.csv"
    code, out, _ = run(
        capsys,
        "synthetic-challenger",
        "--baseline-log",
        str(files / "baseline_log.csv"),
        "--actuals",
        str(files / "synthetic_actuals.csv"),
        "--quality",
        "good",
        "--degrade-from",
        "2025-06-02",
        "--out",
        str(degrading),
    )
    assert code == 0
    assert "synthetic-degrading-challenger" in out
    alerts = tmp_path / "alerts.jsonl"
    code, out, _ = run(
        capsys,
        "evaluate",
        "--challenger",
        str(degrading),
        "--baseline",
        str(files / "baseline_log.csv"),
        "--actuals",
        str(files / "synthetic_actuals.csv"),
        "--alerts-out",
        str(alerts),
    )
    assert code == 0
    assert "rollback_to_baseline (serve baseline-swly-trend)" in out
    assert "ALERT" in out
    assert "Phase 2 gate SYNTH-VENUE-1 net_sales_ex_gst_cents: fail" in out
    (alert,) = [json.loads(line) for line in alerts.read_text().splitlines()]
    assert alert["kind"] == "forecast_rollback"

    good = tmp_path / "good.csv"
    assert (
        run(
            capsys,
            "synthetic-challenger",
            "--baseline-log",
            str(files / "baseline_log.csv"),
            "--actuals",
            str(files / "synthetic_actuals.csv"),
            "--quality",
            "good",
            "--out",
            str(good),
        )[0]
        == 0
    )
    code, out, _ = run(
        capsys,
        "evaluate",
        "--challenger",
        str(good),
        "--baseline",
        str(files / "baseline_log.csv"),
        "--actuals",
        str(files / "synthetic_actuals.csv"),
        "--holdout-weeks",
        "8",
        "--training-end",
        "2025-04-01",
        "--json",
    )
    assert code == 0
    payload = json.loads(out)
    assert payload["rollback"][0]["decision"] == "keep"
    assert payload["gate"][0]["status"] == "pass"


@pytest.mark.parametrize(
    ("argv", "expected"),
    [
        (
            ["baseline", "--input", "nope.csv", "--as-of", "2025-06-30", "--out", "x.csv"],
            "actuals file not found",
        ),
        (
            [
                "baseline",
                "--input",
                "{d}/synthetic_actuals.csv",
                "--calendar",
                "{d}/nope.csv",
                "--as-of",
                "2025-06-30",
                "--out",
                "{t}/x.csv",
            ],
            "calendar file not found",
        ),
        (
            [
                "baseline",
                "--input",
                "{d}/synthetic_actuals.csv",
                "--metric",
                "tips",
                "--as-of",
                "2025-06-30",
                "--out",
                "{t}/x.csv",
            ],
            "metric tips is not in",
        ),
        (
            [
                "baseline",
                "--input",
                "{d}/synthetic_actuals.csv",
                "--as-of",
                "2025-08-01",
                "--out",
                "{t}/x.csv",
            ],
            "after the last trading day",
        ),
        (
            [
                "baseline",
                "--input",
                "{d}/synthetic_actuals.csv",
                "--as-of",
                "2025-06-30",
                "--out",
                "{d}/synthetic_actuals.csv",
            ],
            "would overwrite an input file",
        ),
        (
            [
                "baseline",
                "--input",
                "{d}/synthetic_calendar.csv",
                "--as-of",
                "2025-06-30",
                "--out",
                "{t}/x.csv",
            ],
            "required column is missing",
        ),
        (
            [
                "baseline",
                "--input",
                "{d}/synthetic_actuals.csv",
                "--as-of",
                "2025-06-30",
                "--out",
                "{t}/no/such/dir/x.csv",
            ],
            "No such file or directory",
        ),
        (
            [
                "backtest",
                "--input",
                "{d}/synthetic_actuals.csv",
                "--start",
                "2025-06-02",
                "--end",
                "2025-06-01",
                "--out",
                "{t}/x.csv",
            ],
            "--end must not be before --start",
        ),
        (
            ["synthetic", "--out-dir", "{t}", "--start", "2025-06-02", "--end", "2025-06-01"],
            "--end must not be before --start",
        ),
        (
            [
                "evaluate",
                "--challenger",
                "{d}/baseline_log.csv",
                "--baseline",
                "{d}/baseline_log.csv",
                "--actuals",
                "{d}/synthetic_actuals.csv",
            ],
            "same model",
        ),
        (
            [
                "evaluate",
                "--challenger",
                "{d}/baseline_log.csv",
                "--baseline",
                "{d}/baseline_log.csv",
                "--actuals",
                "{d}/synthetic_actuals.csv",
                "--alerts-out",
                "{d}/baseline_log.csv",
            ],
            "would overwrite an input file",
        ),
    ],
)
def test_errors_exit_2_with_a_message(
    files: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str], argv: list[str], expected: str
) -> None:
    code, _, err = run(capsys, *[a.format(d=files, t=tmp_path) for a in argv])
    assert code == 2
    assert err.startswith("error: ")
    assert expected in err
    assert "Traceback" not in err


@pytest.mark.parametrize(
    "argv",
    [
        ["baseline", "--input", "a.csv", "--as-of", "18 Oct 2026", "--out", "x.csv"],
        [
            "baseline",
            "--input",
            "a.csv",
            "--as-of",
            "2026-10-18",
            "--out",
            "x.csv",
            "--horizon",
            "0",
        ],
        [
            "baseline",
            "--input",
            "a.csv",
            "--as-of",
            "2026-10-18",
            "--out",
            "x.csv",
            "--horizon",
            "x",
        ],
        [
            "baseline",
            "--input",
            "a.csv",
            "--as-of",
            "2026-10-18",
            "--out",
            "x.csv",
            "--issued-at",
            "2026-10-19T00:00:00",
        ],
        [
            "baseline",
            "--input",
            "a.csv",
            "--as-of",
            "2026-10-18",
            "--out",
            "x.csv",
            "--issued-at",
            "soon",
        ],
        [],
    ],
)
def test_bad_arguments_exit_2(argv: list[str], capsys: pytest.CaptureFixture[str]) -> None:
    with pytest.raises(SystemExit) as info:
        main(argv)
    assert info.value.code == 2
    capsys.readouterr()


def test_version_and_help(capsys: pytest.CaptureFixture[str]) -> None:
    with pytest.raises(SystemExit) as info:
        main(["--version"])
    assert info.value.code == 0
    assert "0.2.0" in capsys.readouterr().out
    assert "estimates, not guarantees" in build_parser().format_help()


def test_runs_as_a_module(tmp_path: Path) -> None:
    result = subprocess.run(  # noqa: S603  # fixed argv, no shell
        [
            sys.executable,
            "-m",
            "foresite_forecast",
            "synthetic",
            "--out-dir",
            str(tmp_path),
            "--start",
            "2025-01-01",
            "--end",
            "2025-01-31",
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    assert "SYNTHETIC" in result.stdout


def test_broken_pipe_is_not_an_error(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    def closed_pipe(*_args: object, **_kwargs: object) -> None:
        raise BrokenPipeError

    monkeypatch.setattr("builtins.print", closed_pipe)
    assert (
        main(
            [
                "synthetic",
                "--out-dir",
                str(tmp_path),
                "--start",
                "2025-01-01",
                "--end",
                "2025-01-02",
            ]
        )
        == 0
    )
