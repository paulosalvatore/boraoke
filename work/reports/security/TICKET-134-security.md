# TICKET-134 security audit (Cyber Security)

Audited head: 4981be0 (code identical to e9159eb). Verdict: PASS-WITH-NOTES.

## Findings
- Salt: read only via process.env.TELEMETRY_HASH_SALT in lib/repeat-hash.ts, imported only by three server route handlers. No NEXT_PUBLIC variant, no client import, never logged; the catch returns undefined without echoing. PASS.
- No fallback: unset or blank salt returns undefined, the prop is omitted, the event is unchanged. No default salt in the repo, so no cross-environment correlation unless the same salt is deliberately reused. PASS.
- Reversal: HMAC-SHA256 keyed by a secret salt, so a dictionary of common queries or videoIds cannot be hashed offline without the salt. Truncation to 64 bits does not weaken this (only adds collision risk, noted as negligible). Domain separation key/video. PASS.
- Raw q and videoId: only hashed values are added to props; no new log or error path touches q or videoId. The ck input goes into HMAC only. PASS.
- Report script: read-only (lrange only, no write/del calls). Uses UPSTASH_REDIS_REST_URL/TOKEN from the operator environment; if the operator supplies the read-write prod token the script could write in principle, but the code does not. Prefer a read-only Upstash token. No new endpoint or input surface (--days clamped to 1..90). PASS.

## Notes (non-blocking)
1. Salt strength is operator-dependent: require a long random value (>=32 bytes); a short guessable salt makes the hash brute-forceable. Documented in .env.example as "long random".
2. Rotating the salt breaks series continuity (documented). If the salt leaks, query and videoId hashes become reversible by dictionary, so treat it as a secret (Vercel env, not committed).
3. Hash is stored alongside roomId/uuid, so it enables per-patron song history, same as the existing event content; no new PII class.
4. Use a read-only Upstash token for the report script.
