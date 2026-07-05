import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createQueue,
  addEntry,
  removeEntry,
  moveEntryToTable,
  setVenueMode,
  getEffectiveOrder,
  peekUpcoming,
  advance,
  skip,
} from "../src/index.ts";
import type {
  EntryInput,
  QueueState,
  VenueMode,
} from "../src/types.ts";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let idCounter = 0;
function input(partial: Partial<EntryInput> = {}): EntryInput {
  idCounter += 1;
  return {
    id: partial.id ?? `e${idCounter}`,
    videoId: partial.videoId ?? `vid${idCounter}`,
    uuid: partial.uuid ?? `u${idCounter}`,
    nickname: partial.nickname ?? `nick${idCounter}`,
    mode: partial.mode ?? "sing",
    ...partial,
  };
}

/** Add an entry, asserting acceptance, and return the new state. */
function add(state: QueueState, partial: Partial<EntryInput> = {}): QueueState {
  const r = addEntry(state, input(partial));
  assert.equal(r.accepted, true, `expected accept for ${JSON.stringify(partial)}`);
  return r.state;
}

function orderIds(state: QueueState): string[] {
  return getEffectiveOrder(state).map((e) => e.id);
}

function fresh(mode: VenueMode, opts = {}): QueueState {
  idCounter = 0;
  return createQueue(mode, opts);
}

// ---------------------------------------------------------------------------
// createQueue
// ---------------------------------------------------------------------------

test("createQueue: sane defaults", () => {
  const s = createQueue("full-karaoke");
  assert.equal(s.venueMode, "full-karaoke");
  assert.deepEqual(s.entries, []);
  assert.deepEqual(s.history, []);
  assert.equal(s.nextSeq, 0);
  assert.equal(s.options.maxConsecutiveListen, 1);
});

test("createQueue: options override", () => {
  const s = createQueue("full-karaoke", { maxConsecutiveListen: 3 });
  assert.equal(s.options.maxConsecutiveListen, 3);
});

// ---------------------------------------------------------------------------
// addEntry basics + immutability
// ---------------------------------------------------------------------------

test("addEntry: assigns monotonic submittedAt and does not mutate input state", () => {
  const s0 = fresh("full-karaoke");
  const r1 = addEntry(s0, input({ id: "a" }));
  assert.equal(r1.accepted, true);
  assert.equal(r1.accepted && r1.entry.submittedAt, 0);
  // original untouched
  assert.equal(s0.entries.length, 0);
  assert.equal(s0.nextSeq, 0);

  const r2 = addEntry(r1.state, input({ id: "b" }));
  assert.equal(r2.accepted && r2.entry.submittedAt, 1);
  assert.equal(r2.accepted && r2.state.nextSeq, 2);
});

test("addEntry: duplicate (same uuid+videoId queued) is rejected", () => {
  let s = fresh("full-karaoke");
  s = add(s, { id: "a", uuid: "u1", videoId: "song1" });
  const r = addEntry(s, input({ id: "b", uuid: "u1", videoId: "song1" }));
  assert.equal(r.accepted, false);
  assert.equal(!r.accepted && r.reason, "duplicate");
  // same video, different user is fine
  const r2 = addEntry(s, input({ id: "c", uuid: "u2", videoId: "song1" }));
  assert.equal(r2.accepted, true);
  // same user, different video is fine
  const r3 = addEntry(s, input({ id: "d", uuid: "u1", videoId: "song2" }));
  assert.equal(r3.accepted, true);
});

test("addEntry: a duplicate video may be re-added after the first was played", () => {
  let s = fresh("full-karaoke");
  s = add(s, { id: "a", uuid: "u1", videoId: "song1" });
  s = advance(s).state; // song1 played, no longer queued
  const r = addEntry(s, input({ id: "b", uuid: "u1", videoId: "song1" }));
  assert.equal(r.accepted, true);
});

// ---------------------------------------------------------------------------
// full-karaoke: FIFO
// ---------------------------------------------------------------------------

test("full-karaoke: plays strict FIFO regardless of user/table", () => {
  let s = fresh("full-karaoke");
  s = add(s, { id: "a", uuid: "u1" });
  s = add(s, { id: "b", uuid: "u1" }); // same user twice — allowed in full mode
  s = add(s, { id: "c", uuid: "u2" });
  assert.deepEqual(orderIds(s), ["a", "b", "c"]);
});

// ---------------------------------------------------------------------------
// per-table-2
// ---------------------------------------------------------------------------

test("per-table-2: rejects a 3rd queued sing entry for the same table", () => {
  let s = fresh("per-table-2");
  s = add(s, { id: "a", table: "5", uuid: "u1" });
  s = add(s, { id: "b", table: "5", uuid: "u2" });
  const r = addEntry(s, input({ id: "c", table: "5", uuid: "u3" }));
  assert.equal(r.accepted, false);
  assert.equal(!r.accepted && r.reason, "table-cap");
});

test("per-table-2: cap frees up after one plays", () => {
  let s = fresh("per-table-2");
  s = add(s, { id: "a", table: "5", uuid: "u1" });
  s = add(s, { id: "b", table: "5", uuid: "u2" });
  s = advance(s).state; // a played
  const r = addEntry(s, input({ id: "c", table: "5", uuid: "u3" }));
  assert.equal(r.accepted, true);
});

test("per-table-2: fair round-robin between tables", () => {
  let s = fresh("per-table-2");
  // Table 1 loads two first, then table 2 loads two.
  s = add(s, { id: "a1", table: "1", uuid: "u1" });
  s = add(s, { id: "a2", table: "1", uuid: "u2" });
  s = add(s, { id: "b1", table: "2", uuid: "u3" });
  s = add(s, { id: "b2", table: "2", uuid: "u4" });
  // Fair interleave: t1, t2, t1, t2 — not FIFO (which would be a1,a2,b1,b2).
  assert.deepEqual(orderIds(s), ["a1", "b1", "a2", "b2"]);
});

test("per-table-2: tableless entries bucket per-uuid and rotate fairly", () => {
  let s = fresh("per-table-2");
  s = add(s, { id: "x1", uuid: "ux" }); // no table
  s = add(s, { id: "x2", uuid: "ux" }); // same tableless user — own bucket, 2 allowed
  s = add(s, { id: "y1", uuid: "uy" }); // different tableless user
  // ux bucket has 2, uy bucket has 1; round-robin: x1, y1, x2
  assert.deepEqual(orderIds(s), ["x1", "y1", "x2"]);
  // third for ux is capped
  const r = addEntry(s, input({ id: "x3", uuid: "ux" }));
  assert.equal(!r.accepted && r.reason, "table-cap");
});

test("per-table-2: recency from history carries into ordering", () => {
  let s = fresh("per-table-2");
  s = add(s, { id: "a1", table: "1", uuid: "u1" });
  s = advance(s).state; // table 1 just sang
  s = add(s, { id: "a2", table: "1", uuid: "u2" });
  s = add(s, { id: "b1", table: "2", uuid: "u3" });
  // table 2 never sang -> higher priority than the recently-sang table 1
  assert.deepEqual(orderIds(s), ["b1", "a2"]);
});

// ---------------------------------------------------------------------------
// per-person-1
// ---------------------------------------------------------------------------

test("per-person-1: rejects a 2nd queued sing entry for the same uuid", () => {
  let s = fresh("per-person-1");
  s = add(s, { id: "a", uuid: "u1" });
  const r = addEntry(s, input({ id: "b", uuid: "u1" }));
  assert.equal(r.accepted, false);
  assert.equal(!r.accepted && r.reason, "person-cap");
});

test("per-person-1: cap frees after the person's entry plays", () => {
  let s = fresh("per-person-1");
  s = add(s, { id: "a", uuid: "u1" });
  s = advance(s).state;
  const r = addEntry(s, input({ id: "b", uuid: "u1" }));
  assert.equal(r.accepted, true);
});

test("per-person-1: round-robin by least-recently-sang", () => {
  let s = fresh("per-person-1");
  s = add(s, { id: "a", uuid: "u1" });
  s = add(s, { id: "b", uuid: "u2" });
  s = add(s, { id: "c", uuid: "u3" });
  // none have sung -> submission order
  assert.deepEqual(orderIds(s), ["a", "b", "c"]);
  // u1 sings
  s = advance(s).state; // plays a (u1)
  // u1 re-submits immediately
  s = add(s, { id: "a2", uuid: "u1" });
  // Now queue: b(u2, never), c(u3, never), a2(u1, just sang)
  // least-recently-sang first: u2, u3, then u1
  assert.deepEqual(orderIds(s), ["b", "c", "a2"]);
});

test("per-person-1: a user who never sang outranks one who sang long ago", () => {
  let s = fresh("per-person-1");
  s = add(s, { id: "a", uuid: "u1" });
  s = advance(s).state; // u1 sang (clock 1)
  s = add(s, { id: "b", uuid: "u1" });
  s = advance(s).state; // u1 sang again (clock 2)
  s = add(s, { id: "c", uuid: "u1" });
  s = add(s, { id: "d", uuid: "u2" }); // u2 never sang
  assert.deepEqual(orderIds(s), ["d", "c"]);
});

// ---------------------------------------------------------------------------
// listen / dance interleave
// ---------------------------------------------------------------------------

test("listen: never rejected by fairness caps", () => {
  let s = fresh("per-person-1");
  s = add(s, { id: "a", uuid: "u1", mode: "sing" });
  const r = addEntry(s, input({ id: "l", uuid: "u1", mode: "listen" }));
  assert.equal(r.accepted, true); // listen allowed even though u1 has a queued sing
});

test("listen: default cap = 1 keeps singers from being starved", () => {
  let s = fresh("full-karaoke");
  // three listens submitted first, then a singer
  s = add(s, { id: "l1", mode: "listen" });
  s = add(s, { id: "l2", mode: "listen" });
  s = add(s, { id: "l3", mode: "listen" });
  s = add(s, { id: "s1", mode: "sing" });
  // cap 1: at most one listen before the waiting singer
  // l1 (before s1) -> cap hit -> s1 -> then remaining listens flush
  assert.deepEqual(orderIds(s), ["l1", "s1", "l2", "l3"]);
});

test("listen: with no singers queued, all listens flush FIFO", () => {
  let s = fresh("full-karaoke");
  s = add(s, { id: "l1", mode: "listen" });
  s = add(s, { id: "l2", mode: "listen" });
  s = add(s, { id: "l3", mode: "listen" });
  assert.deepEqual(orderIds(s), ["l1", "l2", "l3"]);
});

test("listen: a listen submitted after the next singer waits its turn", () => {
  let s = fresh("full-karaoke");
  s = add(s, { id: "s1", mode: "sing" });
  s = add(s, { id: "l1", mode: "listen" });
  // s1 submitted first -> plays first; l1 after
  assert.deepEqual(orderIds(s), ["s1", "l1"]);
});

// F1 (opus review): the reviewer's failing case — the cap must hold across
// successive advance() calls, not just within one getEffectiveOrder snapshot.
test("listen: starvation cap holds ACROSS advances, not just in one snapshot", () => {
  let s = fresh("full-karaoke"); // default maxConsecutiveListen = 1
  s = add(s, { id: "l1", mode: "listen" });
  s = add(s, { id: "l2", mode: "listen" });
  s = add(s, { id: "l3", mode: "listen" });
  s = add(s, { id: "s1", mode: "sing" });
  const played: string[] = [];
  for (let i = 0; i < 4; i += 1) {
    const r = advance(s);
    s = r.state;
    played.push(r.played!.id);
  }
  // cap=1 => the singer must not sit behind more than one listen.
  assert.ok(played.indexOf("s1") <= 1, `singer starved: ${played.join(",")}`);
  // and the whole iterative playback matches the batch promise exactly
  assert.deepEqual(played, ["l1", "s1", "l2", "l3"]);
});

test("listen: peekUpcoming(1) always equals what advance() plays (peek == play)", () => {
  let s = fresh("full-karaoke");
  s = add(s, { id: "l1", mode: "listen" });
  s = add(s, { id: "s1", mode: "sing" });
  s = add(s, { id: "l2", mode: "listen" });
  s = add(s, { id: "l3", mode: "listen" });
  s = add(s, { id: "s2", mode: "sing" });
  while (s.entries.length > 0) {
    const promised = peekUpcoming(s, 1)[0];
    const r = advance(s);
    assert.equal(r.played?.id, promised.id);
    s = r.state;
  }
});

test("listen: persisted consecutiveListen counter updates on advance, resets on sing", () => {
  let s = fresh("full-karaoke");
  s = add(s, { id: "l1", mode: "listen" });
  s = add(s, { id: "s1", mode: "sing" });
  assert.equal(s.consecutiveListen, 0);
  let r = advance(s); // plays l1
  assert.equal(r.played?.id, "l1");
  assert.equal(r.state.consecutiveListen, 1);
  r = advance(r.state); // plays s1 -> run broken
  assert.equal(r.played?.id, "s1");
  assert.equal(r.state.consecutiveListen, 0);
});

test("listen: higher cap allows more consecutive listens", () => {
  let s = fresh("full-karaoke", { maxConsecutiveListen: 2 });
  s = add(s, { id: "l1", mode: "listen" });
  s = add(s, { id: "l2", mode: "listen" });
  s = add(s, { id: "l3", mode: "listen" });
  s = add(s, { id: "s1", mode: "sing" });
  // cap 2: l1, l2, then singer, then l3
  assert.deepEqual(orderIds(s), ["l1", "l2", "s1", "l3"]);
});

// F2 (opus review): no-cap must survive a JSON round-trip of QueueState.
test("options: Infinity normalizes to null (no cap) and survives JSON round-trip", () => {
  let s = fresh("full-karaoke", { maxConsecutiveListen: Infinity });
  assert.equal(s.options.maxConsecutiveListen, null); // normalized at creation
  s = add(s, { id: "l1", mode: "listen" });
  s = add(s, { id: "l2", mode: "listen" });
  s = add(s, { id: "l3", mode: "listen" });
  s = add(s, { id: "s1", mode: "sing" });
  // no cap: pure submission-order interleave
  assert.deepEqual(orderIds(s), ["l1", "l2", "l3", "s1"]);
  // round-trip the whole state and verify identical behavior
  const revived = JSON.parse(JSON.stringify(s)) as typeof s;
  assert.deepEqual(revived, s);
  assert.deepEqual(orderIds(revived), ["l1", "l2", "l3", "s1"]);
  // iterative playback agrees too
  const played: string[] = [];
  let cur = revived;
  while (cur.entries.length > 0) {
    const r = advance(cur);
    played.push(r.played!.id);
    cur = r.state;
  }
  assert.deepEqual(played, ["l1", "l2", "l3", "s1"]);
});

test("options: null accepted directly as no-cap", () => {
  const s = fresh("full-karaoke", { maxConsecutiveListen: null });
  assert.equal(s.options.maxConsecutiveListen, null);
});

test("options: default (cap 1) state survives JSON round-trip identically", () => {
  let s = fresh("full-karaoke");
  s = add(s, { id: "l1", mode: "listen" });
  s = add(s, { id: "s1", mode: "sing" });
  s = advance(s).state; // plays l1 -> consecutiveListen persisted as 1
  const revived = JSON.parse(JSON.stringify(s)) as typeof s;
  assert.deepEqual(revived, s);
  assert.deepEqual(orderIds(revived), orderIds(s));
});

// F3 (opus review): duplicates are scoped per mode.
test("duplicate: a listen for video X does not block a sing for X (and vice-versa)", () => {
  let s = fresh("full-karaoke");
  s = add(s, { id: "l", uuid: "u1", videoId: "song1", mode: "listen" });
  const r = addEntry(
    s,
    input({ id: "sg", uuid: "u1", videoId: "song1", mode: "sing" }),
  );
  assert.equal(r.accepted, true);
  // but a second listen for the same video by the same user IS a duplicate
  const r2 = addEntry(
    s,
    input({ id: "l2", uuid: "u1", videoId: "song1", mode: "listen" }),
  );
  assert.equal(!r2.accepted && r2.reason, "duplicate");
});

test("listen: playing a listen does not affect sing recency", () => {
  let s = fresh("per-person-1");
  s = add(s, { id: "l1", uuid: "u1", mode: "listen" });
  s = add(s, { id: "a", uuid: "u1", mode: "sing" });
  s = add(s, { id: "b", uuid: "u2", mode: "sing" });
  // order: l1 (listen, submitted first, cap1 -> one listen then sing), a, b
  assert.deepEqual(orderIds(s), ["l1", "a", "b"]);
  const r = advance(s); // plays l1 (listen)
  assert.equal(r.played?.id, "l1");
  // recency trackers untouched by the listen
  assert.deepEqual(r.state.lastSangByUuid, {});
  assert.equal(r.state.singClock, 0);
});

// ---------------------------------------------------------------------------
// advance
// ---------------------------------------------------------------------------

test("advance: empty queue returns undefined and unchanged state", () => {
  const s = fresh("full-karaoke");
  const r = advance(s);
  assert.equal(r.played, undefined);
  assert.equal(r.state, s);
});

test("advance: plays head, records history, updates recency, is immutable", () => {
  let s = fresh("per-person-1");
  s = add(s, { id: "a", uuid: "u1", table: "7" });
  const before = s;
  const r = advance(s);
  assert.equal(r.played?.id, "a");
  assert.equal(r.state.entries.length, 0);
  assert.equal(r.state.history.length, 1);
  assert.equal(r.state.history[0].outcome, "played");
  assert.equal(r.state.singClock, 1);
  assert.equal(r.state.lastSangByUuid["u1"], 1);
  // input state not mutated
  assert.equal(before.entries.length, 1);
  assert.equal(before.singClock, 0);
});

// ---------------------------------------------------------------------------
// skip / no-show
// ---------------------------------------------------------------------------

test("skip: default skips head, records history, does NOT bump recency", () => {
  let s = fresh("per-person-1");
  s = add(s, { id: "a", uuid: "u1" });
  s = add(s, { id: "b", uuid: "u2" });
  const r = skip(s);
  assert.equal(r.skipped?.id, "a");
  assert.equal(r.state.entries.length, 1);
  assert.equal(r.state.history[0].outcome, "skipped");
  // recency untouched -> u1 keeps priority
  assert.deepEqual(r.state.lastSangByUuid, {});
});

test("skip: a skipped singer who re-submits keeps their standing", () => {
  let s = fresh("per-person-1");
  s = add(s, { id: "a", uuid: "u1" });
  s = add(s, { id: "b", uuid: "u2" });
  s = skip(s).state; // u1 no-show, removed, no recency change
  s = advance(s).state; // u2 sings (clock 1)
  s = add(s, { id: "a2", uuid: "u1" });
  s = add(s, { id: "b2", uuid: "u2" });
  // u1 never actually sang -> outranks u2 who just sang
  assert.deepEqual(orderIds(s), ["a2", "b2"]);
});

test("skip: specific entry id", () => {
  let s = fresh("full-karaoke");
  s = add(s, { id: "a" });
  s = add(s, { id: "b" });
  const r = skip(s, "b");
  assert.equal(r.skipped?.id, "b");
  assert.deepEqual(orderIds(r.state), ["a"]);
});

test("skip: nothing to skip returns undefined", () => {
  const s = fresh("full-karaoke");
  const r = skip(s);
  assert.equal(r.skipped, undefined);
  const r2 = skip(s, "nope");
  assert.equal(r2.skipped, undefined);
});

// ---------------------------------------------------------------------------
// removeEntry (user leaves)
// ---------------------------------------------------------------------------

test("removeEntry: removes a queued entry", () => {
  let s = fresh("full-karaoke");
  s = add(s, { id: "a" });
  s = add(s, { id: "b" });
  s = removeEntry(s, "a");
  assert.deepEqual(orderIds(s), ["b"]);
});

test("removeEntry: idempotent no-op when absent (returns same ref)", () => {
  let s = fresh("full-karaoke");
  s = add(s, { id: "a" });
  const same = removeEntry(s, "ghost");
  assert.equal(same, s);
});

test("removeEntry: user leaving frees their per-person cap", () => {
  let s = fresh("per-person-1");
  s = add(s, { id: "a", uuid: "u1" });
  s = removeEntry(s, "a");
  const r = addEntry(s, input({ id: "b", uuid: "u1" }));
  assert.equal(r.accepted, true);
});

// ---------------------------------------------------------------------------
// moveEntryToTable (table changes)
// ---------------------------------------------------------------------------

test("moveEntryToTable: changes table and re-buckets", () => {
  let s = fresh("per-table-2");
  s = add(s, { id: "a", table: "1", uuid: "u1" });
  s = add(s, { id: "b", table: "1", uuid: "u2" });
  s = add(s, { id: "c", table: "2", uuid: "u3" });
  // move b to table 2
  s = moveEntryToTable(s, "b", "2");
  // now table1: a ; table2: b(seq1), c(seq2) [FIFO within bucket]
  // round-robin one per table: a (t1), then t2 drains b, c -> a, b, c
  assert.deepEqual(orderIds(s), ["a", "b", "c"]);
});

test("moveEntryToTable: over-cap move is grandfathered (honored), drains naturally", () => {
  let s = fresh("per-table-2");
  s = add(s, { id: "a", table: "2", uuid: "u1" });
  s = add(s, { id: "b", table: "2", uuid: "u2" });
  s = add(s, { id: "c", table: "1", uuid: "u3" });
  // moving c into table 2 makes it 3 there — allowed (correction, not new submit)
  s = moveEntryToTable(s, "c", "2");
  assert.equal(s.entries.filter((e) => e.table === "2").length, 3);
  // no entries lost
  assert.equal(getEffectiveOrder(s).length, 3);
});

test("moveEntryToTable: absent id is a no-op (same ref)", () => {
  let s = fresh("per-table-2");
  s = add(s, { id: "a", table: "1" });
  assert.equal(moveEntryToTable(s, "ghost", "9"), s);
});

// ---------------------------------------------------------------------------
// setVenueMode (mode switch mid-session)
// ---------------------------------------------------------------------------

test("setVenueMode: switching modes loses no entries", () => {
  let s = fresh("full-karaoke");
  s = add(s, { id: "a", uuid: "u1" });
  s = add(s, { id: "b", uuid: "u1" }); // 2 from same user — legal in full mode
  s = add(s, { id: "c", uuid: "u2" });
  const switched = setVenueMode(s, "per-person-1");
  // all three still present
  assert.equal(switched.entries.length, 3);
  assert.equal(getEffectiveOrder(switched).length, 3);
});

test("setVenueMode: over-cap in-flight entries are grandfathered; new ones are capped", () => {
  let s = fresh("full-karaoke");
  s = add(s, { id: "a", uuid: "u1" });
  s = add(s, { id: "b", uuid: "u1" }); // over the per-person-1 cap once switched
  s = setVenueMode(s, "per-person-1");
  // existing two honored
  assert.equal(s.entries.length, 2);
  // but a NEW third from u1 is rejected
  const r = addEntry(s, input({ id: "c", uuid: "u1" }));
  assert.equal(!r.accepted && r.reason, "person-cap");
});

test("setVenueMode: re-orders under the new policy", () => {
  let s = fresh("full-karaoke");
  s = add(s, { id: "a1", table: "1", uuid: "u1" });
  s = add(s, { id: "a2", table: "1", uuid: "u2" });
  s = add(s, { id: "b1", table: "2", uuid: "u3" });
  // full-karaoke FIFO
  assert.deepEqual(orderIds(s), ["a1", "a2", "b1"]);
  // switch to per-table-2 -> round robin
  s = setVenueMode(s, "per-table-2");
  assert.deepEqual(orderIds(s), ["a1", "b1", "a2"]);
});

// ---------------------------------------------------------------------------
// peekUpcoming
// ---------------------------------------------------------------------------

test("peekUpcoming: returns first n of effective order", () => {
  let s = fresh("full-karaoke");
  s = add(s, { id: "a" });
  s = add(s, { id: "b" });
  s = add(s, { id: "c" });
  assert.deepEqual(peekUpcoming(s, 2).map((e) => e.id), ["a", "b"]);
});

test("peekUpcoming: n <= 0 returns empty; n > length returns all", () => {
  let s = fresh("full-karaoke");
  s = add(s, { id: "a" });
  assert.deepEqual(peekUpcoming(s, 0), []);
  assert.deepEqual(peekUpcoming(s, -3), []);
  assert.deepEqual(peekUpcoming(s, 99).map((e) => e.id), ["a"]);
});

// ---------------------------------------------------------------------------
// Integration-ish: a full fair session
// ---------------------------------------------------------------------------

test("integration: per-person-1 stays fair across many rounds", () => {
  let s = fresh("per-person-1");
  // Three regulars keep resubmitting; verify nobody sings twice before all sing once.
  const users = ["u1", "u2", "u3"];
  for (const u of users) s = add(s, { id: `${u}-1`, uuid: u });
  const sungOrder: string[] = [];
  for (let i = 0; i < 3; i += 1) {
    const r = advance(s);
    s = r.state;
    sungOrder.push(r.played!.uuid);
    // resubmit immediately
    s = add(s, { id: `${r.played!.uuid}-r${i}`, uuid: r.played!.uuid });
  }
  // First full round must include all three distinct users
  assert.deepEqual([...sungOrder].sort(), ["u1", "u2", "u3"]);
});

test("integration: mode switch mid-session with in-flight entries never drops anyone", () => {
  let s = fresh("full-karaoke");
  s = add(s, { id: "a", uuid: "u1", table: "1", mode: "sing" });
  s = add(s, { id: "l", uuid: "u9", mode: "listen" });
  s = add(s, { id: "b", uuid: "u2", table: "1", mode: "sing" });
  s = add(s, { id: "c", uuid: "u3", table: "2", mode: "sing" });
  const totalBefore = s.entries.length;
  s = setVenueMode(s, "per-table-2");
  assert.equal(s.entries.length, totalBefore);
  s = setVenueMode(s, "per-person-1");
  assert.equal(s.entries.length, totalBefore);
  // effective order still contains every entry id
  assert.deepEqual(orderIds(s).sort(), ["a", "b", "c", "l"]);
});
