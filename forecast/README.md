# forecast

The Python forecast engine (see `CLAUDE.md`: LightGBM, weekly retrain, quantile low/high range, auto-rollback to the same-weekday-last-year baseline). This folder is a placeholder so CI is ready; the engine arrives in a later PR.

## Run the checks

```sh
cd forecast
uv sync --locked
uv run ruff check .
uv run ruff format --check .
uv run mypy
uv run pytest
```

Dependencies are pinned in `pyproject.toml` and locked in `uv.lock`. Update the lock with `uv lock` and commit it.
