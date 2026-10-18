## What

<!-- One ticket per PR. Link it: docs/tickets/phase-N.md#ticket -->

## Why

## How it was tested

<!-- Exact commands and results. Screenshots at phone and desktop width, light and dark, for UI changes. -->

## QA gate (`qa-test`)

- [ ] `npm run check` passes (format, lint, typecheck, unit tests, build)
- [ ] Playwright smoke tests pass against the production build
- [ ] Python checks pass (`ruff check`, `ruff format --check`, `mypy`, `pytest`)
- [ ] Tests added for what this change touches (edge cases: trading days crossing midnight, bad or late vendor data, empty states, large and negative values, forecast range and accuracy shown)
- [ ] UI checked at phone width in light and dark; copy is Australian English; AUD states ex/inc GST; dates as `18 Oct 2026`; venue local time
- [ ] Load check done for anything on the live path (ingest, alerts, dashboard), or stated as not applicable

## Security and privacy gate (`security-privacy`)

- [ ] No secrets in code, commits, fixtures or logs; `.env.example` lists every new variable with a comment
- [ ] No real client data; fixtures and tests use synthetic data
- [ ] Server-side authorisation on every new API route; row-level security on every new table; no service-role key in client code
- [ ] Device ingest changes are authenticated per device, rate-limited, validated and idempotent
- [ ] Personal data kept to the minimum; logs carry no personal data or tokens
- [ ] New dependencies justified; `npm audit --omit=dev --audit-level=high` and `pip-audit` clean
- [ ] Any Privacy Act 1988 / APP question is described for an adviser (no legal conclusions)
- [ ] No account created, API key requested or vendor contacted without Connor's approval

## Branding rule

- [ ] No hard-coded colours, fonts, logos or client names; everything comes from `themes/<slug>/tokens.json`
- [ ] Only Foresite mark is the "Built by Foresite" credit

## For Lachlan

<!-- Decisions needed, UNVERIFIED items, risks, follow-ups. -->
