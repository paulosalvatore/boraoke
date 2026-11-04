# TICKET-151 security audit (PR #101)

**Audited head:** `7fec64f` (code unchanged since `1ab13be`). **Verdict: PASS-WITH-NOTES** (security scope). The authoritative local-Docker GREEN verdict was not re-run by this agent; the TM must confirm it before merge.

Probes ran against the in-memory `MemoryKv` only (a temporary jest file, removed afterwards). No prod, no Redis.

## Authorization (who may delete)

- The only credential is `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` from the process environment (scripts/delete-room.ts `upstashKv`). It is never printed. Whoever holds the app's read-write token can already do everything this script does, so the script adds no privilege.
- A read-only token fails closed: the plan and snapshot reads succeed, then the first `DEL` (the room record, deleted first) errors and nothing is removed. A stray snapshot may remain locally; harmless.
- No HTTP path: `grep` over `app/`, `lib/`, `components/`, `middleware.ts` finds `room-delete` only in `lib/room-delete.ts` itself. No route imports it.

## Blast radius

- Slug is validated with the app's own `isValidRoomId` (`^[a-z0-9-]{1,64}$`, anchored) before any key is built. Probed and rejected: `*`, `a*`, `a?`, `[a]`, `a:b`, `..`, empty, unicode, 65 chars, trailing newline, space, uppercase. A prefix room (`ab` vs `abc`) is not swept in: plan for `ab` lists only `room:ab:meta`.
- Deletion is an explicit `DEL` of the code-derived list only. Pending item ids come from the room's own index but are interpolated into the fixed `room:<slug>:pending:item:` prefix, so they cannot leave the room's namespace.
- The `room:<slug>:*` SCAN is report-only and makes the plan refuse. The `identity:*:rooms` scan is read-only (`TYPE`, `SMEMBERS`); removal is `SREM <set> <exact slug>`.

## Snapshot files

- Path `.room-delete-snapshots/` is gitignored (`/` anchored at repo root; see LOW-2). Directory mode 0700, file 0600, unique timestamped names.
- stdout shows key names, source tags, the snapshot path and counts; no values.
- Contents: room record (host-code hash, claim hashes), queue entries, patron uuids.

## Confirmation and dry-run

- Dry-run is the default. No flag combination skips the gate: `--apply` is required, `confirm()` must equal the slug exactly, and `--confirm <slug>` is the deliberate non-interactive form. `--restore` takes precedence over `--room`/`--apply`. Probed: empty confirmation yields `confirmation-mismatch` and the record is intact.

## Findings

### MEDIUM-1: `--restore` writes any key in a forged snapshot (violates the "must refuse keys outside the room's key set" requirement)

`restoreSnapshot` (lib/room-delete.ts) only checks `version`, a valid slug and that the keys do not already exist. It never checks that each `snap.keys[].key` belongs to the slug's code-derived set, nor that `snap.memberships` entries match `identity:*:rooms`. Probe: a snapshot with slug `ab`, key `admin:secret` and membership `identity:victim:rooms` wrote both (`FORGED_WROTE pwn ['ab']`). A forged room record could also plant an attacker `hostCodeHash`.

Exploitability is low: it needs a file the operator is tricked into restoring, and the operator's token already has full write. Severity MEDIUM, not blocking by rule, but it is an explicit ticket requirement. Remediation direction: before writing, require every key to be in the set `buildPlan`'s derivation yields for `snap.slug` (plus pending items under the exact `room:<slug>:pending:item:` prefix), require memberships to match `identity:<uuid>:rooms`, and add a test with a forged snapshot.

### LOW-1: restore has no dry-run or confirmation

It writes immediately. Consider printing the key list and asking for the slug, as delete does.

### LOW-2: snapshot dir is relative to `process.cwd()`

Run from a subdirectory, the snapshot lands outside the root-anchored ignore. Resolve against the repo root. Also `mkdirSync` mode does not tighten a pre-existing directory.

## Friction

Restore/import paths that take a serialized file need an allow-list of what they may write; worth a checklist line.

## Delta re-gate at `e5b69a6` (fix commit `f8eff09`): PASS

Probed `restoreSnapshot` against `MemoryKv` (temporary jest file, removed). Results:

| Attempt | Outcome |
|---|---|
| Forged key `admin:secret` | refused, whole snapshot |
| Pending item id not in the snapshot's index | refused |
| Index (wrong shape) plus another room's item key `room:other:pending:item:q` | refused |
| Index naming `room:other:meta` as an id | accepted, but the key written is `room:ab:pending:item:room:other:meta`, inside this room's own prefix, so no other room is touched |
| Header slug `ab` with key `room:cd:meta` | refused |
| Membership as a non-string, or with a newline, empty id or extra colon | refused |
| Room record typed as list; duplicate keys; `__proto__` key | refused |

MEDIUM-1 resolved; LOW-1 (restore dry-run) and LOW-2 (repo-root anchor) accepted per the Dev's claim, not re-probed beyond the code read.

Residual INFO: a forged snapshot can still SADD this snapshot's own slug into any `identity:<id>:rooms` set (the id pattern is the only constraint). Impact is limited to adding one room slug to a "my rooms" list and needs a forged local file; no key outside the room is written or overwritten. Local-Docker GREEN was not re-run by this agent.
