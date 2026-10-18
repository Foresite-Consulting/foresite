"""Smoke test: the package imports and reports its version."""

import foresite_forecast


def test_package_exposes_version() -> None:
    assert foresite_forecast.__all__ == ["__version__"]
    assert foresite_forecast.__version__ == "0.2.0"
