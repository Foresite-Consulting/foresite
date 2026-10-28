# Handover: <client> (<job code>)
Handover date: <date> · Warranty (defect fixes) ends: <date + 30 days> · Prepared by: <name>

## 1. Delivered
- [ ] All phase tickets merged or deferred with sign-off (links)
- [ ] Final QA and security reviews passed (links)
- [ ] Final `security-audit` passed: `docs/security/audit-<date>.md` (link)
- [ ] Client bundle scan clean (`scripts/scan-client-bundle.sh`)
- [ ] Accessibility: keyboard-only run and axe check passed
- [ ] Release tag: <tag>

## 2. Accounts and access (all in the client's name)
| Service | Account owner | Foresite access now | How it's removed | Done |
|---|---|---|---|---|
| GitHub (repo transferred) | | | | [ ] |
| Vercel | | | | [ ] |
| Supabase | | | | [ ] |
| Twilio | | | | [ ] |
| <vendor API> | | | | [ ] |

## 3. Running costs as at handover (AUD; state ex or inc GST)
| Service | Plan | Monthly cost | Source (link, date) |
|---|---|---|---|

## 4. Spend caps (set by the client or Connor in the client's accounts)
Budget alerts only warn. Where the provider offers a hard cap or automatic pause, it is on.
| Service | Cap or pause setting | Limit | Alert goes to | Set (date) |
|---|---|---|---|---|

## 5. Operations
- [ ] Monitoring and failed-sync alerts go to: <client role>
- [ ] Backups on; restore tested on <date>
- [ ] Forecast retrain schedule and rollback explained
- [ ] Runbook per connector complete

## 6. Training
| Who | Role | Date | Guides covered |
|---|---|---|---|

## 7. IP
- Assigned to the client: per the agreement, clause <ref> (quoted, not interpreted).
- Licensed back to Foresite (general-purpose components): <list, cross-referenced to foresite-core PRs>.
- Client data, branding and confidential information: not licensed back, not held by Foresite after handover.

## 8. Sign-off
Client: <name, role, date> · Foresite: Connor Wormall, Founder & CEO, <date>
