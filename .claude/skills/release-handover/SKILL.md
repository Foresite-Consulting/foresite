---
name: release-handover
description: Run a milestone release (phase sign-off) or the final client handover for a Foresite build. Use when a phase's tickets are merged and the client is due to sign off, or at the end of the job.
---

# Milestone release and handover

## Milestone release (each phase sign-off)
1. Check every ticket in `docs/tickets/phase-N.md` is merged or explicitly deferred (with Lachlan's OK).
2. Run `qa-test` and `security-privacy` on the release branch. Both must pass with no blocking findings.
3. Have `docs-handover` update `CHANGELOG.md` and write release notes: plain-language client section, then technical section.
4. Tag `vN.0-phaseN`. Deploy to the client's production environment (with Lachlan).
5. Produce the sign-off summary for the Foresite Project: what was delivered against the acceptance criteria, evidence (links, screenshots, test results), known issues, and the next phase. Milestone invoicing is triggered by Connor from the Project, never from here.

## Final handover
1. Everything in "Milestone release" for the last phase.
2. Complete `docs/templates/handover-checklist.md` as `docs/handover/handover.md`.
3. Confirm every account is in the client's name. List Foresite's remaining access and how it's removed.
4. Running costs per service as at handover, from providers' pricing pages (linked, dated, AUD, ex/inc GST stated).
5. Training delivered (who, when, which guides).
6. Repo transfer to the client's GitHub organisation (Connor approves; Lachlan does it).
7. General-purpose improvements are already upstream in foresite-core. Check, and list them under the licence-back schedule.
8. Record the warranty start date (30 days of defect fixes) in the handover doc and the Engagement File.
