# Milesight fixtures

**Synthetic, shaped from vendor docs.** None of these came from a real device or venue. Serial numbers start with `TEST`, MAC and IP addresses are from the documentation ranges (RFC 7042, RFC 5737), and SIM identifiers are placeholders.

| File                      | Shaped from                                                                       |
| ------------------------- | --------------------------------------------------------------------------------- |
| `periodic-line.json`      | VS135 cellular user guide, Communication Protocol > Periodic Report               |
| `periodic-two-lines.json` | VS135-P user guide (Feb 2024) section 7.1, plus the cellular Periodic Report page |
| `trigger-line.json`       | VS135 cellular user guide, Trigger Report > Line Crossing People Counting         |
| `trigger-region.json`     | VS135 cellular user guide, Trigger Report > Region People Counting                |
| `occlusion-alarm.json`    | VS135 cellular user guide, Trigger Report > Occlusion Detection Alarm             |

Each file carries a `_synthetic` key saying so. The adapter ignores unknown keys, so the marker does not affect parsing.

The vendor's printed examples are not valid JSON (trailing commas, curly quotes). These fixtures keep the vendor's field names and nesting and fix the syntax.

Links are in `../RUNBOOK.md`.
