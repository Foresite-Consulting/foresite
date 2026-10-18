# foresite-core

The reusable base for every Foresite client build: standards, the Claude Code delivery team, workflows, theme layers, the design system and the app shell. Each client app starts as a copy of this repo, gets the client's branding on top, and is handed over as the client's IP. General-purpose components are licensed back to Foresite.

**Private. Owned by Foresite (a Wardmark company).** No client data lives here.

## What's here now

| Path                       | What it is                                                                                                                                                                                                                                                                        |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CLAUDE.md`                | Instructions every Claude Code session follows: stack, layout, rules, how a job runs                                                                                                                                                                                              |
| `.claude/agents/`          | The delivery team: architect, integrations, data & forecasting, app, UI/UX, QA, security, docs & handover                                                                                                                                                                         |
| `.claude/skills/`          | Workflows: `new-client`, `add-connector`, `release-handover`                                                                                                                                                                                                                      |
| `apps/web/`                | Next.js 15 (App Router) PWA shell: demo dashboard, theme-driven manifest and icons, offline page, service worker, security headers, `/api/health`, smoke tests                                                                                                                    |
| `packages/ui/`             | Foresite design system: theme loader and schema, CSS variables, Tailwind preset, WCAG contrast checker, components (`KpiTile`, `Card`, `Alert`, `Button`, `BuiltByCredit`), format helpers (AUD ex/inc GST, percentages, `18 Oct 2026` dates in the venue's timezone)             |
| `packages/core/`           | Trading-day and section model (crosses midnight and daylight saving), venue config, 15-minute and hourly bucketing, same weekday last year, golden test vectors, and a seeded synthetic data generator for a fictional venue (`npm run synth`)                                    |
| `packages/connectors/`     | Vendor connectors, one folder per vendor with a runbook. `src/counters/`: vendor-neutral people-counter model and the Milesight VS13x adapter (`milesight/RUNBOOK.md`)                                                                                                            |
| `apps/web/app/api/ingest/` | Device ingest: `POST /api/ingest/counters/<provider>` with per-device HTTP Basic auth, limits, validation and deduplicated storage (`apps/web/lib/ingest/`)                                                                                                                       |
| `db/migrations/`           | SQL migrations. `0001_counter_ingest.sql`: counter devices, credentials, raw payloads, readings, ingest events                                                                                                                                                                    |
| `forecast/`                | Python forecast engine: same-weekday-last-year baseline with trend, likely range from past errors, forecast log and accuracy tracking (WAPE, MAPE, bias, coverage), weekly rollback to the baseline and the Phase 2 gate, plus a CLI and SYNTHETIC data. See `forecast/README.md` |
| `themes/foresite/`         | Foresite base tokens from Brand Guidelines v1.0, plus placeholder app icons (not the logo)                                                                                                                                                                                        |
| `themes/_client-template/` | Copy per client for their logo, colours and name                                                                                                                                                                                                                                  |
| `docs/adr/`                | Architecture decision records (`0001` monorepo and tooling, `0002` trading-day model, `0003` counter ingest, `0004` forecast baseline, accuracy and rollback)                                                                                                                     |
| `docs/data-dictionary.md`  | One definition per term, field and KPI: trading day, sessions, intervals, money and GST, synthetic data columns; the `Forecasts` section covers forecast records and accuracy measures; the `Counter readings` section covers every counter table and mapped field                |
| `docs/pwa-offline.md`      | What the service worker caches and how the offline page works                                                                                                                                                                                                                     |
| `docs/templates/`          | ADR and handover checklist templates                                                                                                                                                                                                                                              |
| `.github/`                 | CI (format, lint, typecheck, unit and smoke tests, Python checks, secret scan, dependency audit), Dependabot, PR template with the QA and security gates                                                                                                                          |

Reusable parts proven on client builds are brought back here as separate PRs, stripped of anything client-specific.

## Using it

### Run it locally

Needs Node 22 (`.nvmrc`), npm 10 and, for the forecast folder, Python 3.12 with [uv](https://docs.astral.sh/uv/).

```sh
npm ci                 # install exactly what package-lock.json says
npm run dev            # http://localhost:3000, demo data, hot reload
npm run check          # format, lint, typecheck, unit tests, build: what CI runs
```

Other useful commands:

```sh
npm run test:watch                 # unit tests on change
npm run build -w apps/web && npm run test:e2e   # Playwright smoke tests against the production build
npm run theme:check -- foresite    # WCAG AA contrast table for a theme folder
npm run coverage                   # unit tests with coverage thresholds (packages/core: 95%)
npm run synth -w packages/core -- --days 730 --seed 42 --out ./synthetic   # SYNTHETIC venue data as CSV, into the git-ignored /synthetic/
cd forecast && uv sync --locked && uv run pytest
cd forecast && uv run python -m foresite_forecast --help   # forecast CLI (baseline, accuracy, evaluate)
```

Copy `.env.example` to `.env.local` for local settings. `NEXT_PUBLIC_THEME` picks the folder under `themes/` (default `foresite`).

### People counters

```sh
npm run device:create -w apps/web -- --device ven1-door-01 --venue ven1 --entry front   # secret shown once, SQL to stdout
```

Without a database, set `INGEST_STORAGE=memory` and paste the output of `device:create ... --memory-json` into `INGEST_MEMORY_DEVICES` (in-memory storage is for local runs only and is refused on Vercel production). Device set-up, failure modes and secret rotation are in `packages/connectors/src/counters/milesight/RUNBOOK.md`.

The PostgreSQL tests run in-process with PGlite, so no database server is needed. To also run them against a real server through the production driver: `TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5432/postgres npx vitest run --project web lib/ingest/postgres-live.test.ts` (creates and drops a throwaway database).

Playwright downloads its own Chromium with `npx playwright install chromium`. On a machine that already has one, set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` instead.

Playwright starts its own production server on the port in `PLAYWRIGHT_BASE_URL` (default `http://127.0.0.1:3000`). If something already listens there it stops with an error rather than testing someone else's server; pick a free port (e.g. `PLAYWRIGHT_BASE_URL=http://127.0.0.1:3517`) or, to reuse a server you started yourself with the same `E2E_INGEST_SECRET`, set `PLAYWRIGHT_REUSE_SERVER=1`.

### Work with Claude Code

1. Open the repo in Claude Code. `CLAUDE.md` and the agents load automatically.
2. New client: "Run the new-client skill for FS-B0X" (only once the quote is accepted).
3. Day to day: ask for a ticket by number; the right agent picks it up. QA and security review every PR before Lachlan merges.

### Branding in two layers

Components only use semantic tokens (`bg`, `surface`, `text-primary`, `action`, `on-action`, `link`, `positive`, `negative`, `forecast`, …). A client theme in `themes/<slug>/tokens.json` re-maps those tokens to the client's palette and supplies the logo, app name and icons; nothing in code names a client. `npm run theme:check -- <slug>` prints the contrast results to record in the theme's README.

## People

Connor Wormall (Founder & CEO, approvals) · Lachlan Graham (CTO, engineering lead, reviews and merges) · Joel Keeble (CPO, product and design lead)
