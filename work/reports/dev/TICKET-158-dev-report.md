# TICKET-158 dev report

Status: implemented, self-verified, PR open (draft). Commits: b10cca9 (code, tests, evidence).

## Limits
- Mint cap: 10 per IP per room and 30 per room, per 10 minutes. Only the code-login path that has to mint is charged. A request presenting any live claim token (owner or staff) mints nothing and is never charged. Venue holds at most 5 devices and returning devices present their token, so real use is a handful per hour.
- Response: same 429 status and copy as the existing failure throttle. No visible string changed.
- Backoff: full jitter, 4 ms base doubling, 80 ms cap. Ordinary mint: 12 attempts. Other writers: 32. Owner mint: 4 open attempts then a fenced stage of 8.

## Fallback choice
A bigger attempt budget alone still lost the pin at 200/500 attackers when the flood bypassed the cap (measured 5/6 and 6/6). The owner mint therefore raises a 3 s self-expiring fence key that the CAS script checks (-2 for every non-priority writer), commits, and drops the fence in finally. It never competes with ordinary mints, adds no cost when uncontended, and is not a rate limit.

## Flood (real Redis, 5+3 ms hops, host load 9-18, 6 trials, revoke route as victim)
See work/evidence/TICKET-158/before-flood-main.txt and after-flood.txt.

## Prove-your-test-can-fail
(a) mutations in work/evidence/TICKET-158/mutations.txt, all KILLED except noted there. (b) new tests on main: new-tests-on-main.txt (9 of 13 fail). (c) no primitive beneath existing assertions changed except update() now takes two keys: room-session-epoch-backend expectation and the ROOM_WRITE_ATTEMPTS assertion for a login mint were updated deliberately. (d) triggered mutation pass: not triggered, no new parsing/normalisation function on a money/quantity/identity path.
