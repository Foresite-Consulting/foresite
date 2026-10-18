# Changelog

Plain-language notes first, then the technical detail. Dates as `18 Oct 2026`.

## Unreleased

### For the client

- The app shell exists: a dashboard of key numbers (demo data only), installable on a phone, with an offline page that shows the last numbers it had and when they were updated.

### Technical

- Monorepo with npm workspaces: `apps/web`, `packages/ui`, `packages/core` (placeholder), `packages/connectors` (placeholder), `forecast` (placeholder). Node 22, exact dependency versions, `package-lock.json` committed. See `docs/adr/0001-monorepo-and-tooling.md`.
- Theme system: typed loader with zod validation, deep merge of `themes/<slug>/tokens.json` over the Foresite base, CSS variables for light and dark (`prefers-color-scheme` plus a `data-theme` override), Tailwind preset bound to those variables, WCAG AA contrast checker with tests and `npm run theme:check -- <slug>`.
- Foresite tokens: added `positive` and `negative` indicator colours (Moss/Ember on light, Jade/Coral on dark) and changed the dark-mode `link` from Coral to Mist, because Coral on Serpentine measures 4.49:1, just under AA. Recorded in `themes/foresite/README.md`.
- Design system components: `KpiTile`, `Card`, `Alert`, `Button`, `BuiltByCredit`, with Testing Library and axe tests. Format helpers for AUD (ex/inc GST stated), percentages, counts, dates and times in the venue's timezone.
- `apps/web`: Next.js 15 App Router, IBM Plex Sans/Mono via `next/font`, manifest and icons from the theme, service worker, offline page, nonce-based Content-Security-Policy and the other security headers, `GET /api/health`, Playwright smoke tests (phone light, desktop dark) with an axe scan.
- `forecast/`: Python 3.12 placeholder with ruff, mypy strict, pytest and a `uv.lock`.
- CI on GitHub Actions: node, Playwright, Python, gitleaks over the full history (pinned binary with checksum), `npm audit` and `pip-audit`. Actions pinned to commit SHAs. Dependabot for npm, uv and actions. PR template with the QA and security gates.

### Fixed (scaffold review)

- Keyboard focus is now visible everywhere: a 2px outline in the theme's `link` colour. `theme:check` requires `link` to reach 3:1 on `bg` and `surface` for the focus indicator. (#1)
- `formatAud` and `formatPercent` round halves away from zero correctly (`1.005` → `$1.01`, `-2.675` → `-$2.68`); new `formatAudCents` formats integer cents exactly. Money should flow as integer cents. Added `ES2023.Intl` to the TypeScript libs for `signDisplay: 'negative'` and decimal-string formatting. (#2)
- `Permissions-Policy` no longer lists `bluetooth` and `interest-cohort`, which Chromium rejects with a console warning. The smoke tests now fail on console warnings as well as errors. (#3)
