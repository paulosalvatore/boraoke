# TICKET-158 plan

APPROVED-BY: tech-manager (brief)

Approach: cap code-login claim mints (per IP+room 10 and per room 30 per 10 min, live-token requests exempt, same 429 body as the failure throttle); full-jitter exponential backoff in the room write loop with a lower attempt bound for ordinary mints; the owner mint (revoke fallback) fences the room via a short self-expiring key checked inside the CAS script. Tests: unit, real-Redis flood harness, mutation pass.
