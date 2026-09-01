# TICKET-99 — stand up TV-browser test machinery

**Filed:** 2026-09-01, from the Tech Lead's real test of 2026-08-27 (`work/status/TL-REAL-TEST-2026-08-27.md`)
**Priority:** HIGH — the machinery half of TICKET-98; can proceed in parallel
**Type:** Test infrastructure
**TL directive:** "go for it" — figure out the setup.

## Why

The e2e suite is **106/106 green** and stayed green through five merges on 2026-09-01. It runs
**desktop Chromium** under Playwright. The product's actual target is an **LG webOS TV browser**:
older WebKit, constrained JS, remote-control input.

So every test we own proves the product works on a browser nobody watches karaoke on, and the suite
reported perfect health while the product was **completely broken on its target device**. That is
worse than having no tests for the TV, because it produced false confidence — five PRs were merged
on the strength of a green suite during the same week the product did not run on a television.

This is a gap in test **environment**, not test **coverage**. More Chromium specs cannot close it.

## Options to evaluate (pick after a spike, do not assume)

1. **Real webOS browser** — LG's webOS TV SDK ships an emulator, and real devices can be
   developer-enabled. Highest fidelity; heaviest setup; unclear how automatable from CI.
2. **Playwright WebKit at a pinned older engine** — cheapest to wire in since Playwright is already
   here, but "old WebKit" is an approximation of webOS, not the thing itself. Risk: it passes while
   the real TV still fails, which is the exact failure mode we are trying to end.
3. **A constrained-engine profile** — deliberately restrict JS features/APIs to the target baseline
   and run the existing suite against it, catching "we shipped syntax the TV cannot parse" without
   emulating the whole device.
4. **A manual verification checklist against a real TV**, as a floor, if automation proves
   disproportionate — with the honest trade written down rather than implied.

The right answer may be a layered combination: (3) cheaply in CI to catch engine-level regressions,
plus (1) or (4) as the periodic real-device check.

## Acceptance criteria

- A documented, repeatable way to exercise boraoke against the TV target.
- It **demonstrably reproduces TICKET-98's failure** — machinery that shows green on a known-broken
  build is worthless, and this is the acceptance bar that matters most.
- The setup is written down well enough that another agent can run it without rediscovering it.
- If a real device is required for part of it, that is stated plainly rather than papered over with
  an emulator that "should be equivalent".

## Note for whoever picks this up

Report honestly on fidelity. An emulation that diverges from a real webOS browser in ways we have
not measured should be labelled as such. The whole point of this ticket is that we previously
trusted a green result from the wrong environment.
