# Data access checklist

What each client must arrange, or ask a vendor for, before a connector can go live. Connor sends vendor requests; engineers never contact vendors or create accounts. Each section is self-contained.

## People counters (Milesight VS135)

Push-based: the counter sends data to the client's app, so there is no API key to request. Details in `packages/connectors/src/counters/milesight/RUNBOOK.md`.

The client provides, in their own name:

- [ ] The counters (VS135 cellular recommended), one per entry point, with each device's serial number.
- [ ] A data SIM per 4G counter (account in the client's name).
- [ ] Power at each mounting point (DC 12 V / 2 A) and a mounting height within the sensor's range.
- [ ] An installer on site to mount the counter and draw the counting line, with Foresite on a call to enter the recipient settings.
- [ ] If remote management is wanted: a Milesight DeviceHub or Development Platform account in the client's name (Connor approves first).

Questions to put to Milesight (through Connor), because the docs do not answer them (runbook U1, U4, U5, U7):

- [ ] Does the HTTP(S) recipient send HTTP Basic auth with every request, or Digest, or only after a 401 challenge?
- [ ] What does the device do when the server answers 4xx, 429 or 5xx: retry, keep the data buffered, or drop it? Does it honour `Retry-After`?
- [ ] How quickly does Data Retransmission re-send buffered packets after reconnecting, and are they identical to the originals?
- [ ] What body does the "Connection Test" button send?
