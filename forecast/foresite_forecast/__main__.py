"""``python -m foresite_forecast``: see :mod:`foresite_forecast.cli`."""

import sys

from foresite_forecast.cli import main

if __name__ == "__main__":  # pragma: no cover - exercised through main() in tests
    sys.exit(main())
