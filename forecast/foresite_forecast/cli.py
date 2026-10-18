"""Command line: ``python -m foresite_forecast <command> ...``.

Commands
    ``baseline``   issue baseline forecasts for 1-28 days after ``--as-of``
    ``backtest``   baseline forecasts as they would have been issued on past days
    ``accuracy``   score a forecast log against actuals
    ``evaluate``   champion/challenger: rollback decision and the Phase 2 gate
    ``synthetic``  write SYNTHETIC actuals and calendar for demos and tests
    ``synthetic-challenger``  write a SYNTHETIC good or bad challenger log

File formats are documented in ``forecast/README.md``. Exit codes: 0 done
(including a rollback decision, which is a result, not an error), 2 bad
input or arguments.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from collections.abc import Sequence
from contextlib import nullcontext
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

import polars as pl

from foresite_forecast import __version__
from foresite_forecast.accuracy import (
    AccuracySummary,
    SummaryBasis,
    accuracy_report,
    forecasts_to_frame,
    frame_to_forecasts,
    read_forecast_log,
    score,
    summarise_accuracy,
    write_forecast_log,
)
from foresite_forecast.baseline import BaselineModel
from foresite_forecast.csvio import (
    LogLockedError,
    atomic_text_writer,
    exclusive_lock,
    parse_iso_date,
    write_csv,
)
from foresite_forecast.errors import DataValidationError
from foresite_forecast.model import MAX_HORIZON_DAYS
from foresite_forecast.schema import (
    DailyActuals,
    VenueCalendar,
    read_calendar,
    read_daily_actuals,
    write_daily_actuals,
)
from foresite_forecast.selection import (
    GateConfig,
    SelectionConfig,
    beats_baseline,
    decide_rollback,
    format_day,
    model_identity,
    read_rollback_state,
    reinstate,
    updated_state,
    write_rollback_state,
)
from foresite_forecast.synthetic import calendar_rows, generate_synthetic, synthetic_challenger

#: Weeks of backtest behind the 'accuracy to date' tile when there is no live log yet.
TILE_WEEKS = 10
TILE_HORIZON = 7


class CliError(Exception):
    """A problem with the command's arguments or inputs (exit code 2)."""


def _date(value: str) -> date:
    parsed = parse_iso_date(value)
    if parsed is None:
        raise argparse.ArgumentTypeError(f"not a date written YYYY-MM-DD: {value!r}")
    return parsed


def _utc_datetime(value: str) -> datetime:
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        raise argparse.ArgumentTypeError(f"not an ISO 8601 date and time: {value!r}") from None
    if parsed.tzinfo is None:
        raise argparse.ArgumentTypeError("issued-at needs a UTC offset, e.g. 2026-10-19T00:00:00Z")
    return parsed.astimezone(UTC)


def _horizon(value: str) -> int:
    try:
        h = int(value)
    except ValueError:
        raise argparse.ArgumentTypeError(f"not a whole number: {value!r}") from None
    if not 1 <= h <= MAX_HORIZON_DAYS:
        raise argparse.ArgumentTypeError(f"horizon must be 1-{MAX_HORIZON_DAYS} days")
    return h


def _existing(path: Path, label: str) -> Path:
    if not path.is_file():
        raise CliError(f"{label} file not found: {path}")
    return path


def _distinct_output(out: Path, *inputs: Path | None) -> None:
    for p in inputs:
        if p is not None and out.resolve() == p.resolve():
            raise CliError(f"output {out} would overwrite an input file")


def _load(args: argparse.Namespace) -> tuple[DailyActuals, VenueCalendar | None]:
    actuals = read_daily_actuals(_existing(args.input, "actuals"))
    calendar = read_calendar(_existing(args.calendar, "calendar")) if args.calendar else None
    if args.metric not in actuals.metrics:
        raise CliError(
            f"metric {args.metric} is not in {args.input} ({', '.join(actuals.metrics)})"
        )
    return actuals, calendar


def _tile_lines(summary: AccuracySummary, label: str) -> list[str]:
    return [f"  {label}: {summary.headline} {summary.detail} {summary.disclaimer}"]


def _cmd_baseline(args: argparse.Namespace) -> int:
    _distinct_output(args.out, args.input, args.calendar, args.log)
    actuals, calendar = _load(args)
    model = BaselineModel()
    issued_at = args.issued_at or datetime.now(UTC)
    horizons = tuple(range(1, args.horizon + 1))
    forecasts = model.forecast(
        actuals,
        args.as_of,
        metric=args.metric,
        horizons=horizons,
        issued_at=issued_at,
        calendar=calendar,
    )
    write_forecast_log(args.out, forecasts)
    print(f"Wrote {len(forecasts)} forecasts to {args.out} (as of {format_day(args.as_of)}).")
    rules = Counter(f.rule for f in forecasts)
    print("Rules used: " + ", ".join(f"{r} {n}" for r, n in sorted(rules.items())))

    live: pl.DataFrame | None = None
    if args.log is not None:
        write_forecast_log(args.log, forecasts, append=True)
        live = score(forecasts_to_frame(read_forecast_log(args.log)), actuals)
        print(f"Appended to forecast log {args.log}.")
    # Accuracy to date: live forecasts when there are enough, otherwise a labelled backtest.
    origins = [args.as_of - timedelta(days=i) for i in range(1, 7 * TILE_WEEKS + TILE_HORIZON)]
    backtest = score(
        forecasts_to_frame(
            model.backtest(
                actuals, origins, metric=args.metric, horizons=(TILE_HORIZON,), calendar=calendar
            )
        ),
        actuals,
    )
    print("Accuracy to date:")
    for venue, section in actuals.series_keys():

        def tile(
            scored: pl.DataFrame, basis: SummaryBasis, venue: str = venue, section: str = section
        ) -> AccuracySummary:
            return summarise_accuracy(
                scored,
                as_of=args.as_of,
                model_id=model.model_id,
                venue_id=venue,
                metric=args.metric,
                section_id=section,
                horizon_days=TILE_HORIZON,
                weeks=TILE_WEEKS,
                basis=basis,
            )

        summary = tile(live, "live") if live is not None else None
        if summary is None or summary.status != "ok":
            summary = tile(backtest, "backtest")
        print("\n".join(_tile_lines(summary, f"{venue} / {section}")))
    return 0


def _cmd_backtest(args: argparse.Namespace) -> int:
    _distinct_output(args.out, args.input, args.calendar)
    actuals, calendar = _load(args)
    if args.end < args.start:
        raise CliError("--end must not be before --start")
    origins = [args.start + timedelta(days=i) for i in range((args.end - args.start).days + 1)]
    horizons = tuple(range(1, args.horizon + 1))
    forecasts = BaselineModel().backtest(
        actuals, origins, metric=args.metric, horizons=horizons, calendar=calendar
    )
    write_forecast_log(args.out, forecasts)
    print(
        f"Wrote {len(forecasts)} backtest forecasts for {len(origins)} origin days to {args.out}."
    )
    return 0


def _fmt_pct(value: object) -> str:
    return "-" if value is None else f"{float(str(value)):.1%}"


def _print_table(title: str, df: pl.DataFrame, key: str | None) -> None:
    print(title)
    for row in df.iter_rows(named=True):
        label = f"{row['model_id']} {row['venue_id']} {row['metric']}"
        if key is not None:
            label += f" {key}={row[key]}"
        print(
            f"  {label}: n={row['n']} WAPE {_fmt_pct(row['wape'])}, MAPE {_fmt_pct(row['mape'])}, "
            f"bias {_fmt_pct(row['bias'])}, in range {_fmt_pct(row['coverage'])}"
        )


def _write_table(path: Path, table: pl.DataFrame) -> None:
    write_csv(path, table.columns, table.iter_rows())


def _cmd_accuracy(args: argparse.Namespace) -> int:
    actuals = read_daily_actuals(_existing(args.actuals, "actuals"))
    log = forecasts_to_frame(read_forecast_log(_existing(args.forecasts, "forecast log")))
    scored = score(log, actuals)
    report = accuracy_report(scored)
    if args.out_dir is not None:
        targets = {name: args.out_dir / f"accuracy_{name}.csv" for name in report.tables()}
        for target in targets.values():
            _distinct_output(target, args.actuals, args.forecasts)
        args.out_dir.mkdir(parents=True, exist_ok=True)
        for name, table in report.tables().items():
            _write_table(targets[name], table)
    if args.json:
        print(
            json.dumps({k: v.to_dicts() for k, v in report.tables().items()}, default=str, indent=2)
        )
        return 0
    print(
        f"Scored {scored.height} of {log.height} forecasts (the rest have no actual yet, "
        "fall on closed or missing days, or have no point)."
    )
    _print_table("Overall:", report.overall, None)
    _print_table("By horizon bucket (days ahead):", report.by_horizon_bucket, "horizon_bucket")
    _print_table("By section:", report.by_section, "section_id")
    _print_table("By weekday (1 = Monday):", report.by_weekday, "weekday")
    latest = report.rolling_4_weeks.group_by(["model_id", "venue_id", "metric"]).agg(
        pl.all().last()
    )
    _print_table("Latest rolling 4 weeks:", latest.sort("model_id"), "week_start")
    if args.out_dir is not None:
        print(f"Wrote every table to {args.out_dir}.")
    return 0


def _cmd_evaluate(args: argparse.Namespace) -> int:
    inputs = (args.actuals, args.challenger, args.baseline)
    if args.alerts_out is not None:
        _distinct_output(args.alerts_out, *inputs, args.state)
    if args.state is not None:
        _distinct_output(args.state, *inputs)
    if args.reinstate and args.state is None:
        raise CliError("--reinstate needs --state (the rollback state file to update)")
    if args.reinstate and not args.sign_off:
        raise CliError("--reinstate needs --sign-off: reinstating is a fresh Phase 2 sign-off")
    actuals = read_daily_actuals(_existing(args.actuals, "actuals"))
    challenger = forecasts_to_frame(read_forecast_log(_existing(args.challenger, "challenger log")))
    baseline = forecasts_to_frame(read_forecast_log(_existing(args.baseline, "baseline log")))
    selection = SelectionConfig()
    gates = beats_baseline(
        challenger,
        baseline,
        actuals,
        holdout_weeks=args.holdout_weeks,
        training_end=args.training_end,
        evaluation_day=args.evaluation_day,
        config=GateConfig(selection=selection),
        require_training_end=args.sign_off,
    )
    with exclusive_lock(args.state) if args.state is not None else nullcontext():
        state = read_rollback_state(args.state) if args.state is not None else []
        notes: list[str] = []
        if args.reinstate:
            challenger_id, version = model_identity(challenger)
            state, notes = reinstate(
                state,
                gates,
                challenger_model_id=challenger_id,
                challenger_model_version=version,
                on=args.evaluation_day or actuals.last_day(),
            )
        decisions = decide_rollback(
            challenger,
            baseline,
            actuals,
            evaluation_day=args.evaluation_day,
            config=selection,
            state=state,
        )
        if args.state is not None:
            write_rollback_state(args.state, updated_state(state, decisions))
    alerts = [d.alert for d in decisions if d.alert is not None]
    if args.alerts_out is not None:
        with atomic_text_writer(args.alerts_out) as handle:
            for alert in alerts:
                handle.write(json.dumps(alert.as_dict(), sort_keys=True) + "\n")
    if args.json:
        payload = {
            "rollback": [d.as_dict() for d in decisions],
            "gate": [g.as_dict() for g in gates],
            "reinstate": notes,
        }
        print(json.dumps(payload, indent=2, sort_keys=True))
        return 0
    for note in notes:
        print(note)
    for d in decisions:
        print(f"Rollback check {d.venue_id} {d.metric}: {d.decision} (serve {d.serve_model_id})")
        if d.weekly_verdict != d.decision:
            print(f"  {d.reasons[0]}")
        for w in d.weeks:
            print(f"  week of {format_day(w.week_start)}: {w.verdict} - {w.note}")
        if d.alert is not None:
            label = "ALERT" if d.alert.new else "ALERT (still standing)"
            print(f"  {label} {d.alert.alert_id}: {d.alert.message}")
    for g in gates:
        print(f"Phase 2 gate {g.venue_id} {g.metric}: {g.status}")
        for reason in g.reasons:
            print(f"  {reason}")
    if args.alerts_out is not None:
        print(f"Wrote {len(alerts)} alert(s) to {args.alerts_out}.")
    if args.state is not None:
        print(f"Updated rollback state {args.state}.")
    return 0


def _cmd_synthetic(args: argparse.Namespace) -> int:
    if args.end < args.start:
        raise CliError("--end must not be before --start")
    args.out_dir.mkdir(parents=True, exist_ok=True)
    dataset = generate_synthetic(args.start, args.end, seed=args.seed)
    write_daily_actuals(args.out_dir / "synthetic_actuals.csv", dataset.actuals)
    write_csv(
        args.out_dir / "synthetic_calendar.csv",
        ("venue_id", "trading_day", "kind", "holiday_key"),
        calendar_rows(dataset),
    )
    print(
        f"Wrote SYNTHETIC actuals ({len(dataset.actuals.rows)} rows) "
        f"and calendar to {args.out_dir}."
    )
    return 0


def _cmd_synthetic_challenger(args: argparse.Namespace) -> int:
    _distinct_output(args.out, args.baseline_log, args.actuals)
    actuals = read_daily_actuals(_existing(args.actuals, "actuals"))
    baseline = forecasts_to_frame(read_forecast_log(_existing(args.baseline_log, "baseline log")))
    frame = synthetic_challenger(
        baseline,
        actuals,
        quality=args.quality,
        degrade_from=args.degrade_from,
        training_end=args.training_end,
    )
    forecasts = frame_to_forecasts(frame)
    write_forecast_log(args.out, forecasts)
    name = str(frame["model_id"][0]) if frame.height else "none"
    print(f"Wrote {len(forecasts)} SYNTHETIC challenger forecasts ({name}) to {args.out}.")
    return 0


def build_parser() -> argparse.ArgumentParser:
    """The argument parser (exposed for tests and ``--help``)."""
    parser = argparse.ArgumentParser(
        prog="python -m foresite_forecast",
        description="Foresite forecast engine. Forecasts are estimates, not guarantees.",
    )
    parser.add_argument("--version", action="version", version=f"%(prog)s {__version__}")
    sub = parser.add_subparsers(dest="command", required=True)

    def data_args(p: argparse.ArgumentParser) -> None:
        p.add_argument("--input", type=Path, required=True, help="daily actuals CSV")
        p.add_argument("--calendar", type=Path, help="venue calendar CSV (holidays, closures)")
        p.add_argument(
            "--metric", default="net_sales_ex_gst_cents", help="metric column to forecast"
        )
        p.add_argument(
            "--horizon", type=_horizon, default=MAX_HORIZON_DAYS, help="days ahead, 1-28"
        )

    p = sub.add_parser("baseline", help="issue baseline forecasts")
    data_args(p)
    p.add_argument(
        "--as-of", type=_date, required=True, help="last trading day with complete actuals"
    )
    p.add_argument("--out", type=Path, required=True, help="forecasts CSV (forecast log format)")
    p.add_argument("--issued-at", type=_utc_datetime, help="issue time (default now, UTC)")
    p.add_argument("--log", type=Path, help="forecast log CSV to append to")
    p.set_defaults(func=_cmd_baseline)

    p = sub.add_parser("backtest", help="baseline forecasts as issued on each past day")
    data_args(p)
    p.add_argument("--start", type=_date, required=True, help="first origin (as-of) day")
    p.add_argument("--end", type=_date, required=True, help="last origin (as-of) day")
    p.add_argument("--out", type=Path, required=True, help="forecast log CSV")
    p.set_defaults(func=_cmd_backtest)

    p = sub.add_parser("accuracy", help="score a forecast log against actuals")
    p.add_argument("--forecasts", type=Path, required=True, help="forecast log CSV")
    p.add_argument("--actuals", type=Path, required=True, help="daily actuals CSV")
    p.add_argument("--out-dir", type=Path, help="write every accuracy table as CSV here")
    p.add_argument("--json", action="store_true", help="print JSON instead of text")
    p.set_defaults(func=_cmd_accuracy)

    p = sub.add_parser("evaluate", help="rollback decision and Phase 2 gate")
    p.add_argument("--challenger", type=Path, required=True, help="challenger forecast log CSV")
    p.add_argument("--baseline", type=Path, required=True, help="baseline forecast log CSV")
    p.add_argument("--actuals", type=Path, required=True, help="daily actuals CSV")
    p.add_argument("--evaluation-day", type=_date, help="default: last trading day in the actuals")
    p.add_argument("--holdout-weeks", type=int, default=GateConfig().holdout_weeks)
    p.add_argument("--training-end", type=_date, help="challenger's last training day")
    p.add_argument("--alerts-out", type=Path, help="write rollback alerts as JSON lines")
    p.add_argument(
        "--state",
        type=Path,
        help="rollback state JSON to read and update (keeps a rollback in force across weeks)",
    )
    p.add_argument(
        "--sign-off",
        action="store_true",
        help="Phase 2 sign-off run: every challenger row must log training_end",
    )
    p.add_argument(
        "--reinstate",
        action="store_true",
        help="put a rolled-back challenger back live where the gate passes (--state, --sign-off)",
    )
    p.add_argument("--json", action="store_true", help="print JSON instead of text")
    p.set_defaults(func=_cmd_evaluate)

    p = sub.add_parser("synthetic", help="write SYNTHETIC actuals and calendar")
    p.add_argument("--out-dir", type=Path, required=True)
    p.add_argument("--start", type=_date, default=date(2023, 7, 1))
    p.add_argument("--end", type=_date, default=date(2026, 10, 18))
    p.add_argument("--seed", type=int, default=20261019)
    p.set_defaults(func=_cmd_synthetic)

    p = sub.add_parser("synthetic-challenger", help="write a SYNTHETIC challenger log (testing)")
    p.add_argument("--baseline-log", type=Path, required=True)
    p.add_argument("--actuals", type=Path, required=True)
    p.add_argument("--quality", choices=("good", "bad"), required=True)
    p.add_argument("--degrade-from", type=_date, help="good before this day, bad from it")
    p.add_argument("--training-end", type=_date, help="log this training_end on every row")
    p.add_argument("--out", type=Path, required=True)
    p.set_defaults(func=_cmd_synthetic_challenger)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    """Run the command line. Returns the exit code."""
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        code: int = args.func(args)
    except (DataValidationError, CliError, LogLockedError, ValueError, KeyError) as exc:
        message = exc.args[0] if isinstance(exc, KeyError) and exc.args else exc
        print(f"error: {message}", file=sys.stderr)
        return 2
    except BrokenPipeError:
        # Output piped into something like `head` that stopped reading: not an error.
        return 0
    except OSError as exc:
        print(f"error: {exc.strerror or exc}: {exc.filename or ''}".rstrip(": "), file=sys.stderr)
        return 2
    return code
