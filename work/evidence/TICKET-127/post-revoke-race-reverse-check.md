# TICKET-127 post-revoke race test, reverse check (Reviewer optional item 1)

Test: __tests__/room-write-race.test.ts, 'a post-revoke login that logs out while the rebind is held'.

## Against origin/main lib/ (git checkout origin/main -- lib/, origin/main=41b77bf): FAILS

```
FAIL __tests__/room-write-race.test.ts
  TICKET-127: A reads, B commits, A writes — B's effect survives, for every pair
  TICKET-127: a post-revoke login that logs out while the rebind is held
    ✕ the logout is not undone by the revoke's write (4 ms)

  ● TICKET-127: a post-revoke login that logs out while the rebind is held › the logout is not undone by the revoke's write

    expect(received).toBe(expected) // Object.is equality

    Expected: false
    Received: true

      91 |     expect(result).toMatchObject({ ok: true });
      92 |     // The logout's effect survives the rebind's write.
    > 93 |     expect(await verifyRoomClaimToken(ctx.roomId, lateDevice)).toBe(false);
         |                                                                ^
      94 |     // The revoke's own effects hold too.
      95 |     expect(await getRoomSessionEpoch(ctx.roomId)).toBeGreaterThan(ctx.epochBefore);
      96 |     expect(await verifySessionValue(ctx.roomId, ctx.oldSession)).toBe(false);

      at Object.<anonymous> (__tests__/room-write-race.test.ts:93:64)

Test Suites: 1 failed, 1 total
Tests:       1 failed, 46 skipped, 47 total
Snapshots:   0 total
Time:        0.195 s, estimated 1 s
Ran all test suites matching /__tests__\/room-write-race.test.ts/i with tests matching "post-revoke".
```

## Against the PR lib/: PASSES

```

Test Suites: 1 passed, 1 total
Tests:       47 passed, 47 total
Snapshots:   0 total
Time:        0.227 s, estimated 1 s
Ran all test suites matching /__tests__\/room-write-race.test.ts/i.
```
