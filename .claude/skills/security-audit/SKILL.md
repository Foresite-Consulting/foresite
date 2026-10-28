---
name: security-audit
description: Full security, cost-abuse and accessibility audit of a whole Foresite build. Use before every milestone release and handover, before anything goes on a public URL, and whenever Connor or Lachlan asks "are we safe to launch?". Run by the security-privacy agent, with qa-test for the accessibility part.
---

# Security audit (whole codebase, before release)

The per-PR checks in `security-privacy` look at a diff. This looks at everything that will actually be live: the code, the history, the build output and the accounts it runs on. It reports; it doesn't fix. Fixes go back to the owning agent, then the flagged items are re-checked.

## The brief
Audit the entire codebase, build pipeline, environment configuration, source maps and production client-side bundles to make sure no credentials, API keys, secrets, access tokens, private keys, database connection strings or other sensitive information are ever embedded in or exposed to client-side code. Sensitive operations and credentials belong in server-side code behind authenticated endpoints. Verify the final production build is clean before it ships. Then check that the app can't be read without permission, can't be tricked by hostile input, can't run up an unbounded bill, and can be used by keyboard and screen reader.

## Steps
Record the exact command and result for each step.

1. **Secrets in the repo and its history.** Run a secret scanner over the full history (`gitleaks detect` or `trufflehog git file://.` — whichever is available; say which). Any real secret ever committed is **Blocking**: it must be rotated in the provider, not just deleted from the code, and the rotation needs Connor because the account is the client's.
2. **Secrets in what ships to the browser.**
   - Search client code for server-only names: `grep -rn "SERVICE_ROLE\|AUTH_TOKEN\|PRIVATE_KEY\|SECRET" apps/web --include='*.ts' --include='*.tsx'` and check each hit is in server-only code.
   - List every `NEXT_PUBLIC_*` variable and say why each is safe to be public.
   - Check `next.config.*` has `productionBrowserSourceMaps` off (or unset).
   - Build with the release environment's variables loaded, then run `scripts/scan-client-bundle.sh`. It must end `RESULT: clean.` with at least one server-only variable checked.
3. **Data access.** List every table. For each: RLS enabled, policies scoped by venue and role. Prove it with the anon key against a local or preview database: each table returns nothing it shouldn't. Staff names and wages visible only to the roles the spec allows.
4. **Hostile input.** Every API route and server action validates input against a schema on the server. Search for SQL or filters built from strings (`grep -rn "\`.*SELECT\|\.or(\`\|\.filter(\`\|EXECUTE " apps packages db`). Run qa-test's hostile-input cases against every public route.
5. **Runaway cost.** Make a table: each paid service (Vercel, Supabase, Twilio, vendor APIs, any AI API) → what can drive usage up → the guard in code (rate limit, retry cap, daily ceiling) → the provider-side cap. Check that no function, database trigger, webhook or scheduled job can call itself or set off its own trigger. Budget alerts only warn; they don't stop spending. Where a provider offers a hard cap or automatic pause, list the setting to turn on (for example Vercel spend management, the Supabase spend cap, Twilio usage triggers and SMS geo-permissions), each linked to the provider's current docs, or marked UNVERIFIED. Agents never change account settings: the list goes to Connor, who sets them in the client's accounts.
6. **Messages.** List every SMS and email the app sends, who receives it and why. Anything beyond operational alerts to the client's own staff is flagged for an adviser (consent records, unsubscribe, Spam Act 2003). Don't conclude.
7. **Accessibility** (with `qa-test`). Keyboard-only run of every key flow; text alternatives on images and icon buttons; axe check of every screen in light and dark mode. WCAG 2.1 AA is the bar.
8. **Dependencies.** `npm audit --omit=dev` and `pip-audit`. High or critical with a fix available is **Blocking**.
9. **Operations.** Backups on and a restore tested (date); failed-sync and failed-login alerts go to a named client role; access list reviewed (who has what, in whose name).

## Return
- Verdict: **Pass**, or **Fail** with the blocking items.
- Findings, each **Blocking** or **Follow-up**, with file/line, the risk in one sentence and the fix.
- The cost table from step 5 and the list of provider settings for Connor.
- The message list from step 6 and any questions for an adviser.
- Commands run and their results.

Save the report as `docs/security/audit-<yyyy-mm-dd>.md` in the client repo. It contains no secret values.
