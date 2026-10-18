# ADR 0001: Monorepo layout, toolchain and automatic checks

Status: Proposed (for Lachlan)
Date: 19 Oct 2026

## Context

`CLAUDE.md` settles the stack (Next.js App Router + TypeScript strict, Tailwind driven by theme tokens, Python forecast engine, Supabase, Vercel) and the folder layout (`apps/web`, `packages/ui`, `packages/core`, `packages/connectors`, `forecast`). This ADR records how those folders are wired together and which checks every PR must pass, so client builds copied from this template start green and stay green.

Constraints: one repo per client copied from this template and transferred at handover, so the tooling must be plain and documented; no paid services (the repo is private, so licensed GitHub actions such as `gitleaks-action` are out); Australian English, AUD ex/inc GST, `18 Oct 2026` dates and venue-local time everywhere.

## Options

1. **npm workspaces, no task runner.** Pros: nothing to learn, ships with Node, one lockfile, `npm ci` is the whole install. Cons: no remote cache; `npm run <script> --workspaces` runs serially. Cost: none.
2. **pnpm or Turborepo.** Pros: faster installs, cached task graph. Cons: another tool for the client's next developer to install and understand; Turborepo's remote cache is a paid-tier feature on Vercel. Cost: time now, possible subscription later.
3. **Separate repos per package.** Pros: clear ownership. Cons: cross-package changes become multi-PR affairs; the design system and app would drift. Cost: ongoing friction.

For the Content-Security-Policy:

1. **Static CSP in `next.config.ts` with `'unsafe-inline'`.** Simple, but inline scripts are allowed, which defeats the point.
2. **Per-request nonce set in `middleware.ts`.** Next.js reads the nonce from the request's CSP header and applies it to its own inline scripts; the app adds it to the one inline `<style>` that carries the theme variables. Pages render dynamically (no static prerender), which a dashboard needs anyway.

## Decision

- **Option 1: npm workspaces** (`apps/*`, `packages/*`), Node 22 (`.nvmrc`, `engines`), exact dependency versions (no `^`/`~`), `package-lock.json` committed. Root scripts: `lint`, `typecheck`, `test`, `build`, `format:check`, `theme:check`, and `check` (all of them in order).
- **TypeScript** strict with `noUncheckedIndexedAccess`, from one `tsconfig.base.json`; each workspace has its own `tsconfig.json` and `typecheck` script.
- **ESLint 9 flat config** at the root (typescript-eslint type-aware, React, hooks, jsx-a11y strict, Next.js rules) plus a repo-specific rule that forbids hex or `rgb()` literals in product code, which enforces the two-layer branding rule. **Prettier** owns formatting.
- **Vitest 4** with projects per workspace, Testing Library and jest-axe for components; **Playwright** for smoke tests against the production build, in two projects (phone, light; desktop, dark).
- **Tailwind CSS 3.4** with a preset in `packages/ui` that replaces the default palette with semantic tokens read from CSS variables. The theme loader validates `themes/<slug>/tokens.json` with zod, deep-merges it over the Foresite base (null = fall back) and fails the build on a bad theme.
- **CSP via nonce in middleware** (option 2); the remaining security headers are static in `next.config.ts`. Fonts are self-hosted by `next/font`, so no third-party origin is allowed anywhere.
- **Service worker** hand-written in `apps/web/public/sw.js`: precache the offline page, cache hashed static assets, never cache API or auth responses, network-first for pages with the offline page as fallback (see `docs/pwa-offline.md`).
- **Python** under `forecast/` with `uv`, a committed `uv.lock`, ruff, mypy strict and pytest.
- **CI** on every push and on pull requests from forks (same-repo PRs would otherwise run twice), with `workflow_dispatch` for manual runs: node, e2e, python, secrets (pinned gitleaks binary with checksum, whole history) and deps (`npm audit --omit=dev --audit-level=high` blocking, dev audit report-only, `pip-audit` blocking). Every action is pinned to a commit SHA; `permissions: contents: read`; superseded runs are cancelled. Dependabot watches npm, uv and GitHub Actions weekly.

Versions were chosen on the latest patch of each stable line that is free of known high or critical advisories at the time of writing (Next 15.5.28, React 19.2.4, TypeScript 5.9.3, Tailwind 3.4.19, Vitest 4.1.11, Playwright 1.56.1, zod 3.25.76). Three `overrides` keep transitive packages on patched versions (`postcss`, `sharp`, `playwright-core`) and one (`vite`) works around an npm 10 resolver crash on Vitest 4.1's peer dependency graph.

## Consequences

- Easier: one install, one command (`npm run check`) mirrors CI; a client's next developer needs only Node, npm and uv.
- Harder: no build cache, so CI time grows with the codebase; revisit Turborepo if a job passes ~10 minutes.
- Every page is server-rendered on demand because of the nonce. Static export is not an option; Vercel hosting (already settled) is fine with this. `UNVERIFIED`: the theme folder is included in the Vercel server bundle via `outputFileTracingIncludes`; confirm on the first Vercel deploy.
- Tailwind 3's build tooling carries dev-only advisories (`braces`, `micromatch`, `postcss-selector-parser`) that have no fix short of Tailwind 4. They never ship to the browser; the dev audit in CI reports them without blocking. Moving to Tailwind 4 is a separate ADR because it changes how the preset is written.
- Reusable in the core: all of it. Client-specific: only `themes/<slug>/`.
