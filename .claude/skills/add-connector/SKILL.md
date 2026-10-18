---
name: add-connector
description: Add a connector to a client system (POS, rostering, payments, accounting, bookings, weather, people counters) in the standard Foresite shape. Use whenever a build needs data from a new vendor.
---

# Add a connector

Hand the build itself to the `integrations-engineer` agent. This skill is the checklist it works to.

1. **Docs first.** Find the vendor's official API documentation. Record in `packages/connectors/<vendor>/RUNBOOK.md`: auth method, scopes, endpoints, pagination, rate limits, webhooks, history depth, sandbox availability, each with a link. Anything unconfirmed is marked `UNVERIFIED`.
2. **Check the core.** If `packages/connectors/<vendor>` already exists in foresite-core, reuse it and add client config. Don't fork it.
3. **Scaffold** `client.ts`, `sync.ts`, `map.ts`, `fixtures/` (synthetic, shaped from the documented responses), `RUNBOOK.md` and tests.
4. **Map** to the core model: trading day, section, venue. Add every field to `docs/data-dictionary.md`.
5. **Sync design:** staging table for raw payloads, then idempotent upsert, a stored cursor, backfill mode, back-off on 429/5xx, and an alert when a sync fails twice in a row.
6. **Env vars** go in `.env.example` with comments. No real values anywhere.
7. **Test:** pagination, retries, duplicates, late data, timezone and cross-midnight trading days. Then run `qa-test` and `security-privacy`.
8. **Access request.** Write what the client must ask the vendor for (scopes, history, rate limits) in `docs/data-access-checklist.md`. Connor sends it; you don't contact the vendor.
9. **Upstream.** If you improved a general-purpose connector inside a client repo, open a matching PR to foresite-core with client details removed.
