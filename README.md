# foresite-core

The reusable base for every Foresite client build: standards, the Claude Code delivery team, workflows, theme layers, the design system and the app shell. Each client app starts as a copy of this repo, gets the client's branding on top, and is handed over as the client's IP. General-purpose components are licensed back to Foresite.

**Private. Owned by Foresite (a Wardmark company).** No client data lives here.

## What's here now

| Path                       | What it is                                                                                                                                                                                                                                                            |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CLAUDE.md`                | Instructions every Claude Code session follows: stack, layout, rules, how a job runs                                                                                                                                                                                  |
| `.claude/agents/`          | The delivery team: architect, integrations, data & forecasting, app, UI/UX, QA, security, docs & handover                                                                                                                                                             |
| `.claude/skills/`          | Workflows: `new-client`, `add-connector`, `release-handover`                                                                                                                                                                                                          |
| `apps/web/`                | Next.js 15 (App Router) PWA shell: demo dashboard, theme-driven manifest and icons, offline page, service worker, security headers, `/api/health`, smoke tests                                                                                                        |
| `packages/ui/`             | Foresite design system: theme loader and schema, CSS variables, Tailwind preset, WCAG contrast checker, components (`KpiTile`, `Card`, `Alert`, `Button`, `BuiltByCredit`), format helpers (AUD ex/inc GST, percentages, `18 Oct 2026` dates in the venue's timezone) |
| `packages/core/`           | Trading-day and section model (crosses midnight and daylight saving), venue config, 15-minute and hourly bucketing, same weekday last year, golden test vectors, and a seeded synthetic data generator for a fictional venue (`npm run synth`)                        |
| `packages/connectors/`     | Placeholder for vendor connectors (one folder per vendor, each with a runbook)                                                                                                                                                                                        |
| `forecast/`                | Placeholder for the Python forecast engine, with ruff, mypy and pytest wired up                                                                                                                                                                                       |
| `themes/foresite/`         | Foresite base tokens from Brand Guidelines v1.0, plus placeholder app icons (not the logo)                                                                                                                                                                            |
| `themes/_client-template/` | Copy per client for their logo, colours and name                                                                                                                                                                                                                      |
| `docs/adr/`                | Architecture decision records (`0001` monorepo and tooling, `0002` trading-day model)                                                                                                                                                                                 |
| `docs/data-dictionary.md`  | One definition per term, field and KPI: trading day, sessions, intervals, money and GST, synthetic data columns                                                                                                                                                       |
| `docs/pwa-offline.md`      | What the service worker caches and how the offline page works                                                                                                                                                                                                         |
| `docs/templates/`          | ADR and handover checklist templates                                                                                                                                                                                                                                  |
| `.github/`                 | CI (format, lint, typecheck, unit and smoke tests, Python checks, secret scan, dependency audit), Dependabot, PR template with the QA and security gates                                                                                                              |

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
npm run synth -w packages/core -- --days 730 --seed 42 --out ./synthetic   # SYNTHETIC venue data as CSV
cd forecast && uv sync --locked && uv run pytest
```

Copy `.env.example` to `.env.local` for local settings. `NEXT_PUBLIC_THEME` picks the folder under `themes/` (default `foresite`).

Playwright downloads its own Chromium with `npx playwright install chromium`. On a machine that already has one, set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` instead.

### Work with Claude Code

1. Open the repo in Claude Code. `CLAUDE.md` and the agents load automatically.
2. New client: "Run the new-client skill for FS-B0X" (only once the quote is accepted).
3. Day to day: ask for a ticket by number; the right agent picks it up. QA and security review every PR before Lachlan merges.

### Branding in two layers

Components only use semantic tokens (`bg`, `surface`, `text-primary`, `action`, `on-action`, `link`, `positive`, `negative`, `forecast`, …). A client theme in `themes/<slug>/tokens.json` re-maps those tokens to the client's palette and supplies the logo, app name and icons; nothing in code names a client. `npm run theme:check -- <slug>` prints the contrast results to record in the theme's README.

## People

Connor Wormall (Founder & CEO, approvals) · Lachlan Graham (CTO, engineering lead, reviews and merges) · Joel Keeble (CPO, product and design lead)
