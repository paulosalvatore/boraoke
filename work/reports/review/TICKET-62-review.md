# TICKET-62 — Reviewer gate (independent, clean context)

**Verdict: APPROVE** (was APPROVE-WITH-FOLLOWUPS on the first pass; upgraded after the targeted re-review in §8 — the gating item and both cheap nits are applied and independently re-verified.)

**Branch:** `ticket/62-tv-client-hygiene` @ base `origin/main` = `46d25cd`. All three source changes are still **uncommitted working-tree changes** (`git diff origin/main...HEAD` is empty); everything below was derived from `git diff` on the working tree.

**Note on a moving target:** the working tree changed *during* this review. I independently derived the TICKET-41c constructor-retry regression (finding 4) from the diff at `TvScreen.tsx` = 103 changed lines; while I was probing the deep-equal, the ticket owner shipped a fix for the same defect (tree grew to 119 changed lines) and messaged me about it. The fix below is reviewed as it now stands (`TvScreen.tsx` md5 `6dfa4f72…`, `self-heal.ts` md5 `8752b379…`, `tv-self-heal.test.ts` md5 `88b9604a…`). Anything landed after those hashes is unreviewed.

---

## 1. Independently observed test + build output

### `npm test`

```
Test Suites: 43 passed, 43 total
Tests:       653 passed, 653 total
Snapshots:   0 total
Time:        3.769 s
Ran all test suites.
```

### `npx jest __tests__/tv-self-heal.test.ts`

```
Test Suites: 1 passed, 1 total
Tests:       59 passed, 59 total
Snapshots:   0 total
Time:        0.505 s, estimated 1 s
Ran all test suites matching /__tests__\/tv-self-heal.test.ts/i.
```

**The dev report's quoted numbers (653 total / 43 suites / 59 in the self-heal suite) match reality exactly.** No discrepancy.

### `npm run build`

First run failed at the trace-collection step:

```
> Build error occurred
[Error: ENOENT: no such file or directory, open '.../.worktrees/ticket-62/.next/prerender-manifest.json']
```

This is a **concurrency artifact, not a defect** — the ticket owner was running a build in the same worktree at the same time and the two clobbered `.next`. After `rm -rf .next`, the build is green:

```
 ✓ Compiled successfully in 1888ms
   Linting and checking validity of types ...
 ✓ Generating static pages (31/31)
...
└ ƒ /tv                                    176 B         103 kB
+ First Load JS shared by all             102 kB
```

The one warning is the pre-existing multiple-lockfile workspace-root inference, unrelated to this diff.

**e2e:** not run. `e2e/tv.spec.ts` is the known-flaky spec owned by TICKET-65, and running Playwright would have contended for ports with five sibling agents. This diff touches no route, no DOM structure, and no test-id, so I judged the e2e signal not worth the interference risk. Flagged as an explicit non-verification, not a pass.

---

## 2. Deep-equal attack log (the highest-risk part)

**Method.** I transliterated `deepEqualJson`/`queueItemsEqual` 1:1 into a scratch Node probe (`<scratchpad>/probe.js`, outside the repo) and ran ~45 adversarial cases; then I **re-ran the decisive ones against the REAL compiled module** (`npx esbuild components/tv/self-heal.ts --format=cjs`) so no conclusion rests on my transliteration. Nothing was added to the repo.

### The reachability frame I established first

Both operands of `queueItemsEqual` are provably JSON-derived:

- `prev` is `useState<QueueEntry[]>([])` seeded with a literal `[]`, and thereafter is only ever whatever a previous `setQueue` stored.
- Both `setQueue` sites store `data.items ?? []` where `data = await res.json()`, i.e. `JSON.parse` output.

So "reachable" below means *constructible by `JSON.parse`*. This matters because several of the misses I found require object shapes `JSON.parse` cannot emit.

### What I executed and what it found

| Attack | Result | Reachable from `/api/queue`? |
| --- | --- | --- |
| Inherited property via `Object.create({table:"3"})` vs absent | correctly **changed** (`Object.keys` is own-only) | n/a |
| `Object.create(null)` shape with a differing value | correctly **changed** | n/a |
| `Object.prototype.__probe = "polluted"` then compare two `JSON.parse` objects | equal-case still equal; real change still seen. `hasOwnProperty` is called via `Object.prototype.hasOwnProperty.call`, so pollution cannot mask it | no |
| **Non-enumerable own property key-count trick**: `a={x:1}` vs `b` with non-enumerable `x:1` + enumerable `y:2` — key *counts* match (1 vs 1), `hasOwnProperty(b,'x')` is true, and **`b.y` is never compared** | **MISS — returns `true`** | **No.** `JSON.parse` only ever defines enumerable own props |
| **Symbol-keyed field added** (`b[Symbol("s")]="Ana"`) | **MISS — returns `true`** (`Object.keys` ignores symbols) | **No** |
| **Array hole** `[,1]` vs `[undefined,1]` | **MISS — returns `true`** | **No** |
| **Sparse `length:3` array** vs three explicit `undefined`s | **MISS — returns `true`** | **No** |
| **Array with an extra non-index own prop** (`a=["x"]; a.extra=1`) | **MISS — returns `true`** (only indices `0..length-1` are walked) | **No** |
| `{title: undefined}` vs `{}` | correctly **changed** (key-count) | yes-ish |
| `{title: null}` vs `{title: undefined}` / vs `{}` | correctly **changed** | yes |
| `0` vs `-0`, incl. `-0` nested two levels inside arrays | correctly **changed** (`Object.is`) | yes |
| `NaN` vs `NaN` | equal — correct and intended | yes |
| `NaN` vs `null` | correctly **changed** | yes |
| Getter with a side effect / unstable getter | getters ARE invoked (once), no crash; a differing getter value is correctly seen as changed. An *unstable* getter can read equal, but is unreachable | no |
| Array-like `{0:"a",length:1}` vs `["a"]` | correctly **changed** (`Array.isArray` XOR check) | no |
| Integer-like string keys `{"2":…,"1":…}` in different insertion order | correctly **equal** when values match, correctly **changed** when one differs | yes |
| `"1"` vs `1` as a value; `"3"` vs `3`; `false` vs `0`; `null` vs `false` | all correctly **changed** | yes |
| **`__proto__` key from `JSON.parse`** (`{"id":"e1","__proto__":{"t":1}}`) | `JSON.parse` makes it an **own enumerable** key (`Object.keys` → `['id','__proto__']`) and leaves the prototype as `Object.prototype`, so `isPlainObject` still passes and the key is compared. Presence-only and value-differing variants both correctly **changed** | yes — and handled |
| NFC `"Evidências"` vs NFD `"Evidências"` | correctly **changed** | yes |
| **Every one of the 9 real `QueueEntry` fields** (`id`, `videoId`, `title`, `nickname`, `patronUuid`, `table`, `mode`, `submittedAt`, `graceRequeue`), mutated one at a time through a real `JSON.stringify`/`parse` round trip | all 9 correctly **changed** | — |
| Optional field dropped by real JSON serialization (`title: undefined` → key absent) vs present | correctly **changed** | — |
| **Change only in the LAST element of a 200-entry queue** (`QUEUE_MAX`) | correctly **changed** | — |
| 1-millisecond `submittedAt` change at index 137 of 200 | correctly **changed** | — |
| Adjacent-pair reorder mid-queue, and a head swap, in a 200-entry queue (the rotation re-lay case) | both correctly **changed** | — |
| Two identical entries vs two distinct — length shortcut sanity | correctly **changed** | — |
| 200-entry unchanged JSON round trip (the case that MUST be equal) | correctly **equal** | — |
| Cyclic object | throws `RangeError: Maximum call stack size exceeded` rather than looping | no (JSON can't cycle) |
| `1e21` vs `1e21+1`, `9007199254740993` vs `…992` | reported equal — **correct, not a miss**: those literals are the *same* IEEE-754 double. Flagged by my crude harness, dismissed on inspection |

### Verdict on the deep-equal

**I found five genuine misses, and all five are unreachable from `/api/queue`'s payload.** They all require a shape `JSON.parse` cannot construct: non-enumerable own properties, symbol keys, array holes/sparse length, or extra non-index array properties. Since both operands are provably JSON-derived (see the reachability frame), none can occur.

**Every reachable attack I could construct was correctly reported as changed** — including the two I considered most likely to bite in production: a single-field change in the last entry of a full 200-deep queue, and a re-lay reorder. The comparator does genuinely fail toward "changed" on the reachable surface.

I could not construct a reachable false-"unchanged". The one structural note worth carrying forward is that the key-set check is *count + `hasOwnProperty`*, which is sound only because `Object.keys` and `hasOwnProperty` agree on JSON-parsed objects; a stricter `bKeys.every(k => hasOwnProperty(a,k))` would close the non-enumerable hole for free. That is a NIT, not a defect (finding 6).

### The React side — does bailing out wedge anything?

This is where the real risk turned out to be, and it is where I found the one genuine defect (finding 4). I enumerated every `useEffect` dependency array in `TvScreen.tsx` (18 of them) and every render-time consumer:

- **`queue` appears in exactly one dependency array** — the player effect, `[ytReady, queue, advance, skipUnplayable, playerEpoch]` (line 460).
- Everything else derives **primitives** from `queue` and is therefore unaffected by identity: the Layer-1 self-heal effect depends on `isPlaying` (a boolean) and has its own 60s interval; the mic-call effect depends on `nowPlayingId`/`nowPlayingIsSing` (string/boolean) — the countdown runs on its own `setInterval`, so skipping the identity change cannot stop or restart it; the watchdog effect depends on `[ytReady, skipUnplayable]` and never listed `queue` at all, and its interval is not recreated because `advance`/`skipUnplayable` remain stable (`selfHealReload` and `clearSelfHealMarker` are both `useCallback(…, [])`, exactly as the old `reactiveSelfHeal` was).
- **Nothing in the render depends on wall-clock time.** I grepped the whole JSX region for `Date`/`toLocale`/elapsed-time formatting: zero hits. So no "3 minutes ago"-style label silently relied on the poll forcing a re-render every 3s. The only sub-component is `<QrCode>`, fed `joinUrl`, not the queue.
- `advance()`'s return value is still read from the freshly fetched `items`, not from state, so the `prev`-returning branch cannot change what the ENDED handler loads next. Confirmed at the source.

That leaves the player effect, and it *did* have a load-bearing dependency on identity churn — finding 4.

---

## 3. Independent log-mode analysis

Prod runs `ADVANCE_AUTH` unset. I read the source rather than taking the dev report's word.

**Advance can never return 401 in log mode.** `lib/screen-token.ts`:

```ts
export function advanceAuthMode(): AdvanceAuthMode {
  return process.env.ADVANCE_AUTH?.trim().toLowerCase() === "enforce" ? "enforce" : "log";
}
```

`app/api/queue/advance/route.ts` is the only consumer:

```ts
const auth = await isAdvanceAuthorized(req, roomId);
const mode = advanceAuthMode();
if (!auth.ok) {
  if (mode === "enforce") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  console.warn(`[advance-auth] would-block advance room=${roomId} reason=${auth.reason} mode=log`);
}
```

`401` appears exactly once in the file and is unconditionally nested inside `mode === "enforce"`. Unset env ⇒ `"log"` ⇒ the 401 is unreachable. The only other non-2xx the route can produce is the 429 rate limit, which the client does not treat as a heal trigger. **Confirmed.**

Now each change:

1. **Layer 2 is dormant, unchanged.** `if (advanceRes.status === 401) { selfHealReload({...got401:true}); return; }` is the sole reactive caller and is unreachable in log mode. Delta: zero.

2. **The implementer's "strict conjunction" claim — verified against the actual code, and it holds.** `shouldSelfHealReload` is:

   ```ts
   if (!shouldReactivelyReload({ lastReloadAt, now })) return false;
   if (got401) return true;
   return shouldProactivelyReload({ tokenAgeMs, isPlaying });
   ```

   Layer 1 passes `got401` unset (defaults `false`), so the new Layer-1 condition reduces exactly to `shouldReactivelyReload(marker) && shouldProactivelyReload(old args)` — a literal conjunction with the old predicate. It cannot fire in any state where the old code did not. Claim confirmed. I additionally verified `git diff origin/main -- components/tv/self-heal.ts` contains **zero deleted lines**, so `shouldProactivelyReload`, `shouldReactivelyReload` and `shouldSelfHealReload` are byte-identical to `main` — the diff to that file is pure addition (comments + the two new comparators).

3. **The marker clear is log-mode inert.** `if (advanceRes.ok) clearSelfHealMarker()` adds a `sessionStorage.removeItem` per successful advance — a new DOM write, but on a key that in log mode can only have been written by Layer 1 (Layer 2 being unreachable). Removing it can only re-permit a Layer-1 reload that the old, marker-free code would have permitted anyway. Strictly *toward* the old behavior. Correctly gated on `.ok` (2xx) and not on 429/5xx, which is the right call: a rate-limit or server error says nothing about token validity, so the storm guard must stay armed. The clear is also placed *after* the 401 early-return and *before* the refetch, so a 401 can never reach it. **Cannot re-open a storm:** Layer 1 only fires when `isPlaying === false`, i.e. the queue is empty, and an empty-queue TV issues no advances — so in the skew scenario there is nothing to clear the marker. Verified independently against the code, not just accepted from the report.

4. **The `setQueue` diff is not server-observable at all** — the stored *contents* are identical in both branches; only object identity differs. See §2 for the client-side consequences, which is where the one real issue was.

**Net log-mode delta: zero**, plus the one caveat in finding 5 which applies only under `enforce`.

---

## 4. Test-quality audit

**Would any of the new tests pass against the OLD code?** Yes — and this is the significant gap.

`components/tv/self-heal.ts` has no deleted lines vs `origin/main`, so the three self-heal predicates are unchanged. Therefore **all 15 tests in the two blocks `TICKET-62: Layer 1 proactive path is clamped by the shared marker` and `TICKET-62: clearing the marker after a successful advance` would pass verbatim against `origin/main`.** They characterize the *decision* semantics — which were already correct — not the *wiring*, which was the entire defect. They are not tautologies (they assert real, non-trivial properties, including the useful negative-age and healthy-20h-cadence pins), but they provide **zero regression protection** for nits 1 and 2. A future refactor that reverts `TvScreen` to calling `shouldProactivelyReload` raw, or that drops the `removeItem`, would leave all 59 tests green. See finding 3.

The nit-3 tests are a different story and are good: `deepEqualJson`/`queueItemsEqual` are new, so all 44 comparator tests genuinely exercise new code. The negative-direction block is thorough (every real field, presence/absence, type shifts, reorder, nesting, non-plain objects) and the 20-entry "changed at index 17" case is the right shape of test. I found nothing tautological there. My own probing found no reachable gap they miss.

---

## 5. Scope check

`git status --porcelain`:

```
 M __tests__/tv-self-heal.test.ts
 M components/tv/TvScreen.tsx
 M components/tv/self-heal.ts
?? work/evidence/TICKET-62/
?? work/reports/dev/TICKET-62-dev-report.md
?? work/tickets/TICKET-62-tv-client-hygiene.md
```

All within the allowed set. `git diff --name-only origin/main -- components/tv/config.ts 'app/(patron)/[room]/tv/page.tsx' e2e jest.config.ts` returns **empty** — none of the forbidden, sibling-owned files was touched. ✅

---

## 6. Findings

**1. [SHOULD-FIX] The nit-1 residual is understated in one respect: the marker is a *shared* budget, so a skew storm also starves Layer 2.**
The residual is honestly stated as far as it goes — under sustained >20h skew the page reloads once per 5-minute window instead of once per 60s (a ~300x reduction), stays strictly idle-gated, and can never cut off a singer. I verified the mechanism end to end: `sessionStorage` survives `location.reload()` in the same tab, so the marker really does persist across the reload and really does bound the loop; after 5 minutes it goes stale and one more reload fires. That is proportionate to a fault mode implying broken TLS, and I agree the `tokenAgeMs >= 0` clamp is genuinely a no-op here — the failure produces a large *positive* age, and the negative case is already inert via `>=`. **The clamp really would be dead code shaped like a fix; the implementer's argument is correct on the merits.** What is *not* stated: because both layers now share one marker, every Layer-1 reload (legitimate or skew-driven) arms the debounce, so a genuine 401 arriving within 5 minutes of a proactive reload is now suppressed where previously it was not. Under skew that is a permanent condition. Bounded at 5 minutes and only reachable under `enforce`, so not a blocker — but it belongs in the ticket's residual paragraph rather than being discovered later.

**2. [SHOULD-FIX] The mount-anchored skew-proof follow-up is a paragraph, not a ticket.**
Both the ticket and the dev report describe the real fix (anchor token age to page-mount time via `performance.now()`, since a just-server-rendered page cannot legitimately observe a 20h-old token) and explicitly decline to build it. Fine — but it exists only as prose in a file that will be closed. File it as a real backlog card, or the "residual" quietly becomes permanent.

**3. [SHOULD-FIX] Nits 1 and 2 — the actual defects — have zero automated regression coverage.**
See §4: 15 of the 40 new tests would pass unchanged against `origin/main`. The wiring change in `TvScreen.tsx` (routing Layer 1 through `selfHealReload`, and the `removeItem` on 2xx) is untested, and a revert would go undetected. This is a structural limit, not laziness — `jest.config.ts` is `testEnvironment: "node"` with `testMatch: ["**/__tests__/**/*.test.ts"]`, so a `.tsx` component test cannot run, and `jest.config.ts` is a forbidden file on this ticket. Worth noting that `@testing-library/react` and `@testing-library/jest-dom` are *already* devDependencies, so a jsdom project is a small lift. Follow-up ticket: add a jsdom jest project and one `TvScreen` test that asserts the marker gates Layer 1.

**4. [SHOULD-FIX — found independently, already fixed by the owner mid-review; verifying the fix] The if-changed diff killed TICKET-41c's failed-constructor retry.**
The player effect's `catch` comment states the contract: "creation is try/caught so a failed constructor (half-loaded API on venue wifi) retries **on the next effect run**". That retry rode entirely on the queue poll writing a brand-new array identity every 3s. With the if-changed diff, a kiosk sitting on a static queue has no identity change left to re-fire it, and no other path re-arms: the watchdog interval early-returns on `!playerRef.current`, and its `recreate` rung (the only other `setPlayerEpoch` bump) is therefore unreachable. Net effect would have been a **permanently black TV with no self-heal** — exactly the freeze this ticket exists to prevent, and strictly worse than the churn being fixed. **The owner shipped a fix while I was probing, and I reviewed it:**

```ts
if (playerRetryTimerRef.current) clearTimeout(playerRetryTimerRef.current);
playerRetryTimerRef.current = setTimeout(() => {
  playerRetryTimerRef.current = null;
  setPlayerEpoch((n) => n + 1);
}, POLL_INTERVAL);
```

I verified: `POLL_INTERVAL` is `3000` (line 61), so the cadence is identical to the one the poll used to provide; `playerEpoch` is in the effect's dependency array, so the bump genuinely re-fires it; repeated failures produce a 3s retry loop, which is the same loop the old code had (and the same one re-render per 3s, so no new churn in the healthy path); the timer cannot leak — `clearTimeout` runs before each re-arm so at most one is outstanding, and the unmount effect at line 520 now clears it alongside `skipNoticeTimerRef`; a stale timer firing after the queue changed and the constructor already succeeded is harmless (the effect takes the "player already exists" branch and returns). One residual edge, benign: if the queue drains to empty before the timer fires, the player div is unmounted, the effect early-returns at `!playerDivRef.current`, and no new retry is armed — but `playerRef`/`currentVideoIdRef` are both null and the next submission re-fires the effect via the queue change, so it self-recovers. **The fix is correct.** Recording it as a finding because it is the strongest evidence in this diff that the "something depended on identity churn" class is real, and because the dev report has not yet been updated to describe it (finding 7).

**I re-swept for other members of that class and found none.** All 18 `useEffect` dependency arrays enumerated; `queue` appears in exactly one; every other queue-derived dependency is a primitive (`isPlaying`, `nowPlayingId`, `nowPlayingIsSing`); no render-time consumer depends on wall-clock time; the mic-call countdown, chrome auto-hide, reorder notice and skip notice all run on their own timers; `advance`/`skipUnplayable` identities are unchanged from `main`. I consider the class closed for this component.

**5. [NIT] `queueItemsEqual`'s key-set check could be tightened for free.**
`aKeys.length === bKeys.length` plus `hasOwnProperty(b, k)` for every `a` key is sound *only* because `Object.keys` and `hasOwnProperty` agree on JSON-parsed objects. It is defeated by a non-enumerable own property on `b` (probe §2 — a real `true` on genuinely different objects). Unreachable here, but the module's stated contract is "fail toward changed **regardless**" (it makes exactly that argument for the `Date` fallback), and `bKeys.every(k => Object.prototype.hasOwnProperty.call(a, k))` closes it at zero cost.

**6. [NIT] `deepEqualJson` overflows the stack on a cyclic or pathologically deep input.**
Confirmed: `RangeError: Maximum call stack size exceeded`. The "inputs come from `JSON.parse`, so cycles are impossible" reasoning is correct and I verified the reachability frame that backs it (both operands are always `JSON.parse` output or the initial `[]`). Worth noting only because the throw would happen inside React's updater, i.e. potentially during render and outside `fetchQueue`'s `try`, so it would white-screen the TV rather than being swallowed. Unreachable today; do not add a depth guard on my account, just be aware if the entry shape ever grows a patron-supplied nested field.

**7. [NIT] The dev report is now stale.**
Its file table and implementation notes do not mention `playerRetryTimerRef` or the finding-4 fix, and its "Files changed" summary predates it. The report is otherwise accurate and its verification numbers reproduce exactly — update it before the PR so the reviewed diff and the described diff match.

**8. [NIT] The test file's header docblock still says "TICKET-46 — Kiosk-TV screen-token self-heal: pure decision tests" and describes only the self-heal contract**, though the file is now ~45% queue-comparator tests. One line.

---

## 7. Why APPROVE-WITH-FOLLOWUPS rather than REQUEST-CHANGES

The one change that could have wedged a venue screen (finding 4) is fixed and I verified the fix rather than trusting it. The deep-equal — the part this review was told to attack hardest — survived a real, executed attack: five misses found, all provably unreachable from the only payload that can feed it, and every reachable attack correctly reported as changed. Log-mode neutrality holds, and the implementer's load-bearing "strict conjunction" claim is true against the actual source. The remaining findings are coverage and documentation debt, not correctness, and none of them should hold the merge.

Do not merge until finding 7 is addressed (the report must describe the diff that is actually shipping), and file findings 2 and 3 as follow-up cards.

---

## 8. Re-review after the owner's fixes — **final verdict: APPROVE**

Scoped to the items the owner changed. I did not re-do the full review; §§1–7 above stand as written.

### Finding 5 — key containment in both directions: closes the hole, and introduces no reachable false-"changed"

The patched `deepEqualJson` adds, after the `aKeys.length !== bKeys.length` check and before the existing `aKeys` loop:

```ts
for (const key of bKeys) {
  if (!Object.prototype.hasOwnProperty.call(a, key)) return false;
}
```

**Does it close the hole?** Yes. I rebuilt the module with esbuild and re-ran my original attack against the real compiled code. The exact `Object.defineProperty` shape now returns `false` in **both** argument orders, and so does the `writable: true` variant:

```
ok    non-enum mask, a vs b
ok    non-enum mask, b vs a
ok    same, writable non-enum
```

The reasoning is sound, not just the observation: with equal key counts, `aKeys ⊆ ownProps(b)` and `bKeys ⊆ ownProps(a)` together force the two *enumerable* key sets to coincide, which is exactly what the old count-plus-one-way check could not establish when one side hid a key non-enumerably.

**The question you said you cared about more — a new false-"changed" on a reachable payload.** No, and this is provable rather than merely untested. The new loop can only return `false` when `b` has an own enumerable key that is not an own property of `a`. On JSON-parsed objects `Object.keys` and `hasOwnProperty` enumerate the same set, so any pair the old code called equal already had identical key sets and the loop is a strict no-op. I still checked it empirically rather than resting on the argument — a false-"changed" regression sweep over reachable shapes, all clean:

```
ok    full 4-entry queue, JSON roundtrip
ok    queueItemsEqual roundtrip
ok    empty objects
ok    key order differs
ok    nested equal
ok    null-proto both sides
ok    __proto__ own key equal
ok    200-entry roundtrip with dropped optionals
ok    last-of-200 change still seen
ok    both sides missing the same optional
ok    still: title present vs dropped
ok    still: {t:undefined} vs {}
ok    NaN vs NaN
=== problems: 0 ===
```

The 200-entry case deliberately mixes present and JSON-dropped optional fields, since that is the shape most likely to trip a key-set check. The two directional guarantees I care about most both survive: an unchanged poll is still equal (no churn regression), and a change in the last entry of a full queue is still seen (no freeze regression).

The new test `a non-enumerable own property cannot mask an extra field` builds the shape correctly and asserts both argument orders. It is a real test of new code — it fails against the pre-patch comparator.

### Finding 8 — test-file docblock

Applied. The header now covers both tickets and states the negative-direction weighting rationale explicitly ("a missed change freezes the TV on a stale queue, which is far worse than the re-render churn it exists to avoid"). Resolved.

### Finding 1 — is the accepted reasoning *wrong*, or merely was-unstated?

**Merely unstated. The reasoning as now written is correct, and I endorse the decision to accept it.** A page that has just reloaded holds a freshly minted token, so a 401 arriving within the next 5 minutes cannot be an aged-token problem — it means the credential is being rejected for a reason another reload will not cure (bad config, a rotated room secret, a broken clock). Reloading again would not fix it, so suppressing the second heal is not merely tolerable, it is the *correct* behavior; that is precisely the storm case the debounce exists for. My original finding was that the second-order coupling was undocumented, not that it was a wrong trade. It is now its own paragraph in the ticket, attributed and reasoned. Resolved as recorded.

### Findings 2, 3, 6, 7 — dispositions confirmed

- **2 and 3:** both now sit in the ticket's out-of-scope section as follow-up cards to file, and finding 3's entry correctly captures the structural cause (`jest.config.ts` is node-env + `.test.ts`-only **and** sibling-owned, so the wiring is untestable *on this ticket*) plus the mitigating fact that `@testing-library/react` and `@testing-library/jest-dom` are already devDependencies. Accurate.
- **6:** recorded, no action, agreed — including the sharper framing that the throw would land in React's updater outside `fetchQueue`'s `try`. Unreachable today; the note is the right outcome.
- **7:** applied. The file table now names `playerRetryTimerRef`, §3a describes the regression and its fix, and a post-review section lists every finding with its disposition. The reviewed diff and the described diff now match. One cosmetic note, not worth a finding: §3a's heading frames the regression as "found and fixed during dev", which is true but sits slightly oddly next to the later line acknowledging it was derived independently in review; the report is honest about both, so leave it.

### Re-verification I ran myself

`npm test`:

```
Test Suites: 43 passed, 43 total
Tests:       654 passed, 654 total
Snapshots:   0 total
Time:        2.103 s
Ran all test suites.
```

**654 confirmed** — 653 + the one new finding-5 test, exactly as claimed.

`npm run build` (after `rm -rf .next`; no concurrent build this time, and no `.next` clobber recurred):

```
 ✓ Compiled successfully in 4.6s
 ✓ Generating static pages (31/31)
```

Scope re-checked and still clean: only `__tests__/tv-self-heal.test.ts`, `components/tv/TvScreen.tsx`, `components/tv/self-heal.ts` modified, plus the three untracked `work/` files. `git diff --name-only origin/main` against the four forbidden paths returns empty. `git diff origin/main -- components/tv/self-heal.ts` still has **zero deleted lines**, so the three pre-existing self-heal predicates remain byte-identical to `main`.

### Final verdict

**APPROVE.** The one gating item is closed and independently re-verified against the compiled module rather than a reading of the patch; the accepted trade-off in finding 1 is correctly reasoned, not merely disclosed; and findings 2 and 3 are properly parked as cards to file rather than left as prose in a closing ticket. Nothing outstanding blocks the merge. Nothing was committed by me — the ticket owner commits.
