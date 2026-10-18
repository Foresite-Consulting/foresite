# Foresite core: instructions for Claude Code

Foresite (owned by Wardmark) builds custom web apps, one per client. Each app connects the client's existing systems (POS, rostering, payments, accounting), forecasts what's coming (revenue, labour, margin) and puts clear answers in front of managers.

This repo is the **Foresite core**: the reusable base every client build starts from. Client builds live in their own repos (`<client-code>-app`, e.g. `fs-b01-app`), created from this template and transferred to the client at handover. Under the IP model, the client owns its build and licenses general-purpose components back to Foresite. Their data, branding and confidential information are never part of that licence and never come back into this repo.

## Who's who
- Connor Wormall, Founder & CEO, approves anything that costs money, commits Foresite, or goes outside Foresite.
- Lachlan Graham, CTO, is the human lead for engineering. He reviews and merges every PR.
- Joel Keeble, CPO, is the human lead for product, brand and UI.
- Planning (specs, quotes, status) happens in the "Foresite" claude.ai Project. Code happens here.

## Stack (settled; change only by an ADR approved by Lachlan)
- Installable web app (PWA). Native only if a feature needs device hardware a browser can't reach.
- Next.js (App Router) + TypeScript (strict). Tailwind CSS driven by the theme tokens in `themes/`.
- PostgreSQL on Supabase, Sydney region. Migrations in `db/migrations/`, never edited after merge.
- Python forecast engine (LightGBM, weekly retrain, quantile low/high range, auto-rollback if worse than the same-weekday-last-year baseline for 4 weeks).
- Hosting on Vercel. Alerts by web push with Twilio SMS fallback.
- Every fact joins on a **trading day** (open to close, not midnight to midnight) and a **section** (bar, restaurant, deck…).
- Devices (counters, kiosks) post to an authenticated ingest endpoint. Devices never hold database credentials.

## Planned layout
```
apps/web/            Next.js PWA (screens, API routes, ingest endpoint)
packages/ui/         Foresite design system components (theme-driven, no client branding)
packages/connectors/ One folder per vendor connector, each with a runbook
packages/core/       Trading-day model, section model, budget upload, alert rules
forecast/            Python forecast engine and accuracy tracking
db/migrations/       SQL migrations
themes/foresite/     Foresite base tokens (from Brand Guidelines v1.0)
themes/_client-template/  Copy per client; the client's logo, colours, name
docs/                Architecture, ADRs, data dictionary, runbooks, handover
```
Folders that don't exist yet are created by the first build that needs them, following this layout.

## Branding rule (two layers)
Foresite is a services brand. Every client app looks like the **client's** app.
1. **Base layer:** the Foresite design system in `packages/ui` and `themes/foresite`: layout, spacing, type scale, components, chart rules, accessibility.
2. **Client layer:** `themes/<client>/` overrides logo, name, brand colours and favicon. Nothing else in the code names the client.
3. The only Foresite mark allowed in a client app is a small "Built by Foresite" credit (settings or footer).
4. Chart semantics never change per client: actuals solid, comparisons muted, forecasts dotted, forecast range shaded. Only the colours come from the theme.

## Rules for every change
- No secrets in code or commits. `.env.example` lists every variable, with a comment on each. Real values live in the client's Vercel/Supabase accounts.
- All client accounts (GitHub, Vercel, Supabase, Twilio, vendor APIs) are in the **client's** name. Never create an account, request an API key or contact a vendor without Connor's approval.
- Client data never leaves that client's systems. No real client data in this repo, in fixtures or in tests. Use synthetic data.
- Every claim about a vendor API is checked against its documentation and linked, or marked `UNVERIFIED`.
- Every forecast the app shows has its range and its accuracy to date.
- Australian English in the UI, AUD with ex/inc GST stated, metric, dates as `18 Oct 2026`, times in the venue's local timezone (Perth: AWST, `Australia/Perth`).
- UI copy follows the Foresite tone: plain speaking, short sentences, no jargon. A venue manager should understand every screen between services.
- Small PRs, one ticket each. Every PR passes the `qa-test` and `security-privacy` agents before Lachlan reviews it.

## The delivery team (subagents in `.claude/agents/`)
| Agent | Use it for |
|---|---|
| `solution-architect` | Spec → architecture, data model, ADRs, phased tickets. Start every job and every phase here. |
| `integrations-engineer` | Connectors to client systems; runbooks; backfills; rate limits; retries |
| `data-forecasting-engineer` | Trading-day model, forecast engine, accuracy tracking, budget upload logic |
| `app-engineer` | Next.js PWA screens, API routes, ingest endpoint, push/SMS alerts, offline behaviour |
| `ui-ux-designer` | Screen flows, layouts, the design system in `packages/ui`, client theme set-up |
| `qa-test` | Tests, acceptance against the spec, load checks for a busy service. A gate on every PR. |
| `security-privacy` | Auth, secrets, data handling, account ownership, dependency risk. A gate on every PR. |
| `docs-handover` | README, data dictionary, runbooks, training notes, the handover and IP transfer pack |

## Workflows (skills in `.claude/skills/`)
- `new-client`: start a client build from this template.
- `add-connector`: add a vendor connector the standard way.
- `release-handover`: milestone release and final handover checklist.

## How a job runs
1. Build & Data writes the Technical Build Spec in the Foresite Project. It is the source of truth for scope.
2. `solution-architect` turns it into `docs/architecture.md`, ADRs and tickets per phase.
3. Specialist agents build each ticket on its own branch.
4. `qa-test` and `security-privacy` review. Fix everything they flag as blocking.
5. Lachlan reviews and merges. Each merged milestone gets recorded in the client's Engagement File in the Project (link to the PR or release).
6. General-purpose improvements made during a client build are copied back here as a separate PR, stripped of anything client-specific.
