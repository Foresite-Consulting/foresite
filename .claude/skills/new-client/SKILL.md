---
name: new-client
description: Start a new Foresite client build from the foresite-core template - repo, theme, environments, docs and Phase 0 tickets. Use when a quote has been accepted and Connor says to start the build.
---

# Start a new client build

Only start once Connor has confirmed the quote is accepted. Account creation and anything that costs money need his approval first.

## 1. Gather (ask for anything missing; don't guess)
- Job code (e.g. `FS-B02`) and client legal name; venue(s), timezone, trading hours per section.
- The Technical Build Spec (link or text from the Foresite Project).
- The client's brand files: logo (SVG preferred), colours, app name. If none, use the placeholder and flag it.
- Who will own the accounts on the client's side (name, role).

## 2. Repo
- Repo name: `<job-code-lowercase>-app` (e.g. `fs-b02-app`). Created by Connor or Lachlan from the `foresite-core` template, initially under Foresite-Consulting. It transfers to the client's GitHub organisation at handover.
- Update `README.md` with the client name, job code and spec link. Keep `CLAUDE.md`, and add a "Client context" section at its foot (venues, sections, systems, trading hours, contacts by role).

## 3. Theme
- Copy `themes/_client-template/` to `themes/<client-slug>/`.
- Map the client's colours onto the semantic tokens (light and dark). Check WCAG AA contrast for every text pairing and record the results in the theme README.
- Add the logo, app icons (192, 512, maskable) and favicon from the client's files. Set the app name and short name.
- Keep the "Built by Foresite" credit only.

## 4. Environments (list them; Connor approves creation)
Write `docs/environments.md` with what's needed, all in the **client's** name: Vercel project, Supabase project (Sydney region), Twilio (if alerts by SMS), and vendor API access for each connected system. List the variables each one sets in `.env.example`.

## 5. Phase 0
- Ask the `solution-architect` agent to produce `docs/architecture.md`, `docs/data-dictionary.md` (draft), ADRs and `docs/tickets/phase-0.md` … `phase-4.md` from the spec.
- List every vendor API need as `UNVERIFIED` in `docs/data-access-checklist.md` until confirmed in writing.

## 6. Report back
A summary for the Foresite Project's Engagement File: repo link, theme status, environments needed (awaiting approval), open questions, and the first tickets.
