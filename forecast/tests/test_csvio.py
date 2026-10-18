"""Low-level CSV reading and writing: size limit, durable atomic writes, the log lock."""

from __future__ import annotations

import fcntl
import os
from datetime import date
from pathlib import Path

import pytest

from foresite_forecast import csvio
from foresite_forecast.accuracy import read_forecast_log, write_forecast_log
from foresite_forecast.csvio import (
    LogLockedError,
    atomic_text_writer,
    exclusive_lock,
    read_csv,
    write_csv,
)
from foresite_forecast.errors import DataValidationError
from tests.helpers import make_forecast

DAY = date(2026, 1, 5)


def test_oversized_file_is_refused_before_it_is_read(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    big = tmp_path / "big.csv"
    with big.open("wb") as handle:  # sparse: one byte past the limit, no disk used
        handle.truncate(csvio.MAX_INPUT_BYTES + 1)
    assert big.stat().st_size == csvio.MAX_INPUT_BYTES + 1

    def no_read(self: Path) -> bytes:
        raise AssertionError("read_bytes must not be called for an oversized file")

    monkeypatch.setattr(Path, "read_bytes", no_read)
    with pytest.raises(DataValidationError, match="larger than the 100 MB limit"):
        read_csv(big, source="big.csv", required=("a",))


def test_file_at_the_limit_is_read(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(csvio, "MAX_INPUT_BYTES", 6)
    path = tmp_path / "ok.csv"
    path.write_bytes(b"a\n1\n2\n")  # exactly 6 bytes
    _, rows = read_csv(path, source="ok.csv", required=("a",))
    assert [r.fields["a"] for r in rows] == ["1", "2"]


def test_write_csv_fsyncs_file_and_folder_before_and_after_rename(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    events: list[str] = []
    real_fsync, real_replace = os.fsync, os.replace

    def fsync(fd: int) -> None:
        events.append("fsync-dir" if Path(f"/proc/self/fd/{fd}").resolve().is_dir() else "fsync")
        real_fsync(fd)

    def replace(src: str | os.PathLike[str], dst: str | os.PathLike[str]) -> None:
        events.append("replace")
        real_replace(src, dst)

    monkeypatch.setattr(os, "fsync", fsync)
    monkeypatch.setattr(os, "replace", replace)
    write_csv(tmp_path / "x.csv", ("a", "b"), [(True, False), (None, DAY)])
    assert events == ["fsync", "replace", "fsync-dir"]
    assert (tmp_path / "x.csv").read_text() == "a,b\ntrue,false\n,2026-01-05\n"
    assert [p.name for p in tmp_path.iterdir()] == ["x.csv"]


def test_folder_fsync_is_best_effort(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    real_open, real_fsync = os.open, os.fsync

    def open_fails_on_dirs(path: str | os.PathLike[str], flags: int, *a: int) -> int:
        if Path(path).is_dir():
            raise PermissionError("no directory handles here (e.g. Windows)")
        return real_open(path, flags, *a)

    monkeypatch.setattr(os, "open", open_fails_on_dirs)
    write_csv(tmp_path / "a.csv", ("a",), [(1,)])
    monkeypatch.setattr(os, "open", real_open)

    def fsync_fails_on_dirs(fd: int) -> None:
        if Path(f"/proc/self/fd/{fd}").resolve().is_dir():
            raise OSError("fsync not supported on this directory")
        real_fsync(fd)

    monkeypatch.setattr(os, "fsync", fsync_fails_on_dirs)
    write_csv(tmp_path / "b.csv", ("a",), [(2,)])
    assert (tmp_path / "a.csv").read_text() == "a\n1\n"
    assert (tmp_path / "b.csv").read_text() == "a\n2\n"


def test_failed_atomic_write_keeps_the_old_file(tmp_path: Path) -> None:
    path = tmp_path / "keep.txt"
    path.write_text("old\n")

    def crash() -> None:
        with atomic_text_writer(path) as handle:
            handle.write("half")
            raise RuntimeError("crash part-way")

    with pytest.raises(RuntimeError):
        crash()
    assert path.read_text() == "old\n"
    assert [p.name for p in tmp_path.iterdir()] == ["keep.txt"]


def test_log_append_is_refused_while_another_writer_holds_the_lock(tmp_path: Path) -> None:
    log = tmp_path / "log.csv"
    write_forecast_log(log, [make_forecast(DAY, 1)])
    with (tmp_path / "log.csv.lock").open("a") as other:  # a second process's lock
        fcntl.flock(other.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        with pytest.raises(LogLockedError, match="only one writer per log"):
            write_forecast_log(log, [make_forecast(DAY, 2)], append=True)
        fcntl.flock(other.fileno(), fcntl.LOCK_UN)
    assert [f.point for f in read_forecast_log(log)] == [1]
    assert write_forecast_log(log, [make_forecast(DAY, 2)], append=True) == 1
    assert [f.point for f in read_forecast_log(log)] == [1, 2]


def test_lock_is_released_after_an_error(tmp_path: Path) -> None:
    path = tmp_path / "x.csv"

    def fail() -> None:
        with exclusive_lock(path):
            raise RuntimeError("boom")

    with pytest.raises(RuntimeError):
        fail()
    with exclusive_lock(path):  # free again
        pass
