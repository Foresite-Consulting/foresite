# foresite-core

The reusable base for every Foresite client build: standards, the Claude Code delivery team, workflows, theme layers and templates. Each client app starts as a copy of this repo, gets the client's branding on top, and is handed over as the client's IP. General-purpose components are licensed back to Foresite.

**Private. Owned by Foresite (a Wardmark company).** No client data lives here.

## What's here now
| Path | What it is |
|---|---|
| `CLAUDE.md` | Instructions every Claude Code session follows: stack, layout, rules, how a job runs |
| `.claude/agents/` | The delivery team: architect, integrations, data & forecasting, app, UI/UX, QA, security, docs & handover |
| `.claude/skills/` | Workflows: `new-client`, `add-connector`, `release-handover` |
| `themes/foresite/` | Foresite base tokens from Brand Guidelines v1.0 |
| `themes/_client-template/` | Copy per client for their logo, colours and name |
| `docs/templates/` | ADR and handover checklist templates |

Code (the PWA, connectors, forecast engine) is added as the first build needs it, following the layout in `CLAUDE.md`. Reusable parts proven on FS-B01 are brought back here.

## Using it
1. Open the repo in Claude Code. `CLAUDE.md` and the agents load automatically.
2. New client: "Run the new-client skill for FS-B0X" (only once the quote is accepted).
3. Day to day: ask for a ticket by number; the right agent picks it up. QA and security review every PR before Lachlan merges.

## People
Connor Wormall (Founder & CEO, approvals) · Lachlan Graham (CTO, engineering lead, reviews and merges) · Joel Keeble (CPO, product and design lead)
