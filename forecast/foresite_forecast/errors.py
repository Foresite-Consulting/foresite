"""Errors raised when input data breaks the data contract.

Every problem is collected (up to a limit) before raising, so a user fixing a
file sees all the issues at once rather than one per run.
"""

from __future__ import annotations

from dataclasses import dataclass

#: Most issues listed in an error message. The full list stays on ``issues``.
MAX_ISSUES_SHOWN = 20
#: Values echoed back in messages are cut to this length.
MAX_VALUE_ECHO = 40


@dataclass(frozen=True)
class ValidationIssue:
    """One problem found in an input file or table.

    ``line`` is the 1-based line in the CSV file (the header is line 1), or
    ``None`` for problems that are not tied to one line.
    """

    message: str
    line: int | None = None
    column: str | None = None
    value: str | None = None

    def __str__(self) -> str:
        where = []
        if self.line is not None:
            where.append(f"line {self.line}")
        if self.column is not None:
            where.append(f"column '{self.column}'")
        prefix = f"{', '.join(where)}: " if where else ""
        shown = ""
        if self.value is not None:
            value = self.value
            if len(value) > MAX_VALUE_ECHO:
                value = value[:MAX_VALUE_ECHO] + "..."
            shown = f" (got {value!r})"
        return f"{prefix}{self.message}{shown}"


class DataValidationError(ValueError):
    """Input data does not meet the data contract. ``issues`` lists every problem."""

    def __init__(self, source: str, issues: list[ValidationIssue]) -> None:
        if not issues:
            raise ValueError("DataValidationError needs at least one issue")
        self.source = source
        self.issues = list(issues)
        shown = "\n".join(f"  - {issue}" for issue in self.issues[:MAX_ISSUES_SHOWN])
        more = len(self.issues) - MAX_ISSUES_SHOWN
        tail = f"\n  ... and {more} more" if more > 0 else ""
        noun = "problem" if len(self.issues) == 1 else "problems"
        super().__init__(f"{source}: {len(self.issues)} {noun} found\n{shown}{tail}")
