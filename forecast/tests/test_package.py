"""Smoke test: the package imports and exposes nothing yet."""

import foresite_forecast


def test_package_is_empty() -> None:
    assert foresite_forecast.__all__ == []
