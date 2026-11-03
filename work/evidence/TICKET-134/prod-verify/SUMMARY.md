# TICKET-134 prod smoke (PR #99, 11f63a0)

Checked 2026-11-03. GitHub Production deployment for 11f63a0 has status success.

| # | request | status | detail |
|---|---------|--------|--------|
| 1 | GET https://boraoke.com/api/search?q=bohemian+rhapsody+karaoke&v=2&live=1 | 200 | 2 results, source index |
| 2 | GET https://boraoke.com/ (queue-free page load) | 200 | normal page |

TELEMETRY_HASH_SALT is unset in prod by design, so the hash fields are omitted; nothing regressed. No tokens used, set-cookie headers stripped.
