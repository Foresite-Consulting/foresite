"""Strict CSV reading and writing shared by every file format in the package.

The standard library ``csv`` module is used rather than a dataframe reader so
that every malformed line (wrong number of fields, bad quoting, bad encoding)
is reported with its line number instead of being padded or guessed.
"""

from __future__ import annotations

import csv
import fcntl
import io
import os
import re
from collections.abc import Iterable, Iterator, Sequence
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import TextIO

from foresite_forecast.errors import DataValidationError, ValidationIssue

#: Refuse input files larger than this. A venue's daily history for ten years
#: across twenty sections is well under 10 MB; anything far bigger is a mistake.
MAX_INPUT_BYTES = 100 * 1024 * 1024

#: Identifiers (venue, section, model, metric): start with a letter or digit so
#: a value can never be read as a spreadsheet formula (``=``, ``+``, ``-``, ``@``).
ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$")
DATE_PATTERN = re.compile(r"^\d{4}-\d{2}-\d{2}$")
#: Whole, non-negative numbers of at most 13 digits (A$100 billion in cents),
#: so every value is exact in a 64-bit float as well as an integer.
NON_NEGATIVE_INT_PATTERN = re.compile(r"^\d{1,13}$")
NEGATIVE_INT_PATTERN = re.compile(r"^-\d+$")


@dataclass(frozen=True)
class CsvRow:
    """One data line: its 1-based line number in the file and its fields by column."""

    line: int
    fields: dict[str, str | None]


class LogLockedError(Exception):
    """Another process is writing the same log (its ``.lock`` file is held)."""


def _too_large(source: str) -> DataValidationError:
    return DataValidationError(
        source,
        [ValidationIssue(f"file is larger than the {MAX_INPUT_BYTES // (1024 * 1024)} MB limit")],
    )


def _decode(raw: bytes, source: str) -> str:
    if len(raw) > MAX_INPUT_BYTES:
        raise _too_large(source)
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise DataValidationError(
            source,
            [ValidationIssue(f"file is not valid UTF-8 (byte {exc.start}); save it as CSV UTF-8")],
        ) from None
    return text


def read_csv(
    data: bytes | Path,
    *,
    source: str,
    required: Sequence[str],
    optional: Sequence[str] = (),
) -> tuple[list[str], list[CsvRow]]:
    """Read a CSV file strictly.

    Empty fields (after nothing; whitespace is *not* stripped) become ``None``.
    Raises :class:`DataValidationError` listing every structural problem: missing,
    unknown or repeated columns, and lines with the wrong number of fields.
    """
    if isinstance(data, Path):
        # Check the size before reading, so a huge file is refused without loading it.
        if data.stat().st_size > MAX_INPUT_BYTES:
            raise _too_large(source)
        raw = data.read_bytes()
    else:
        raw = data
    text = _decode(raw, source)
    reader = csv.reader(io.StringIO(text, newline=""), strict=True)
    issues: list[ValidationIssue] = []
    try:
        header = next(reader, None)
    except csv.Error as exc:
        raise DataValidationError(source, [ValidationIssue(f"bad CSV: {exc}", line=1)]) from None
    if header is None or header == []:
        raise DataValidationError(source, [ValidationIssue("file is empty (no header line)")])

    allowed = set(required) | set(optional)
    seen: set[str] = set()
    for name in header:
        if name in seen:
            issues.append(ValidationIssue("column appears more than once", line=1, column=name))
        seen.add(name)
        if name not in allowed:
            expected = ", ".join([*required, *optional])
            issues.append(
                ValidationIssue(f"unknown column; expected only: {expected}", line=1, column=name)
            )
    for name in required:
        if name not in seen:
            issues.append(ValidationIssue("required column is missing", line=1, column=name))
    if issues:
        raise DataValidationError(source, issues)

    rows: list[CsvRow] = []
    try:
        for fields in reader:
            line = reader.line_num
            if fields == []:
                continue  # blank line
            if len(fields) != len(header):
                issues.append(
                    ValidationIssue(
                        f"expected {len(header)} fields, found {len(fields)}", line=line
                    )
                )
                continue
            rows.append(
                CsvRow(
                    line,
                    {
                        name: (v if v != "" else None)
                        for name, v in zip(header, fields, strict=True)
                    },
                )
            )
    except csv.Error as exc:
        issues.append(ValidationIssue(f"bad CSV: {exc}", line=reader.line_num))
    if issues:
        raise DataValidationError(source, issues)
    return header, rows


def _fsync_dir(folder: Path) -> None:
    """Flush a folder's entry list to disk, where the platform allows it (not Windows)."""
    try:
        fd = os.open(folder, os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(fd)
    except OSError:
        pass  # some file systems refuse fsync on a directory; the rename has still happened
    finally:
        os.close(fd)


@contextmanager
def atomic_text_writer(path: Path) -> Iterator[TextIO]:
    """Open a UTF-8 text handle whose content replaces ``path`` only once complete.

    Writes to a temporary file in the same folder, flushes and ``fsync``s it,
    renames it over ``path`` and then ``fsync``s the folder, so a crash or power
    cut part-way leaves either the old file or the new one, never half of one.
    If the ``with`` block raises, ``path`` is untouched.
    """
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    try:
        with tmp.open("w", encoding="utf-8", newline="") as handle:
            yield handle
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, path)
        _fsync_dir(path.parent)
    finally:
        tmp.unlink(missing_ok=True)


def write_csv(path: Path, header: Sequence[str], rows: Iterable[Sequence[object]]) -> None:
    """Write rows as UTF-8 CSV with ``\\n`` line endings. ``None`` is written as an empty field.

    Atomic and durable (see :func:`atomic_text_writer`): a crash part-way never
    leaves a half-written log behind.
    """
    with atomic_text_writer(path) as handle:
        writer = csv.writer(handle, lineterminator="\n")
        writer.writerow(header)
        for row in rows:
            writer.writerow(["" if v is None else _format(v) for v in row])


@contextmanager
def exclusive_lock(path: Path) -> Iterator[None]:
    """Hold an advisory lock on ``<path>.lock`` for a read-modify-write of ``path``.

    One writer per log: a second process trying to append at the same time
    gets :class:`LogLockedError` straight away instead of silently losing
    rows. The lock is ``fcntl.flock`` (POSIX; the forecast job runs on Linux)
    and is released when the block ends or the process dies. The ``.lock``
    file is left in place on purpose: deleting it would let two writers lock
    different files.
    """
    lock_path = path.with_name(f"{path.name}.lock")
    with lock_path.open("a") as handle:
        try:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise LogLockedError(
                f"{path} is being written by another process (lock {lock_path} is held); "
                "only one writer per log at a time, so try again when it has finished"
            ) from None
        try:
            yield
        finally:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def _format(value: object) -> str:
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


def check_id(row: CsvRow, column: str, issues: list[ValidationIssue]) -> str | None:
    """Return the identifier in ``column`` or record an issue."""
    value = row.fields.get(column)
    if value is None:
        issues.append(ValidationIssue("is required", line=row.line, column=column))
        return None
    if not ID_PATTERN.match(value):
        issues.append(
            ValidationIssue(
                "must be 1-64 letters, digits, '_', '.' or '-', starting with a letter or digit",
                line=row.line,
                column=column,
                value=value,
            )
        )
        return None
    return value


def parse_iso_date(value: str) -> date | None:
    """Parse a strict ``YYYY-MM-DD`` date, or return ``None``."""
    if not DATE_PATTERN.match(value):
        return None
    try:
        return date.fromisoformat(value)
    except ValueError:
        return None


def check_date(row: CsvRow, column: str, issues: list[ValidationIssue]) -> date | None:
    """Return the date in ``column`` or record an issue."""
    value = row.fields.get(column)
    if value is None:
        issues.append(ValidationIssue("is required", line=row.line, column=column))
        return None
    parsed = parse_iso_date(value)
    if parsed is None:
        issues.append(
            ValidationIssue(
                "must be a real date written YYYY-MM-DD", line=row.line, column=column, value=value
            )
        )
    return parsed


def check_count(row: CsvRow, column: str, issues: list[ValidationIssue]) -> int | None:
    """Return a whole non-negative number in ``column`` (``None`` if empty) or record an issue."""
    value = row.fields.get(column)
    if value is None:
        return None
    if NON_NEGATIVE_INT_PATTERN.match(value):
        return int(value)
    if NEGATIVE_INT_PATTERN.match(value):
        message = "must not be negative (record refunds inside the day's net figure)"
    elif column.endswith("_cents"):
        message = (
            "must be a whole number of cents with no decimal point, '$' or ',' (at most 13 digits)"
        )
    else:
        message = "must be a whole number (at most 13 digits)"
    issues.append(ValidationIssue(message, line=row.line, column=column, value=value))
    return None
