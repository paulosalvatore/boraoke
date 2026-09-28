#!/usr/bin/env python3
"""TICKET-116 — build the distribution tables straight from the evidence files,
so the report's numbers are extracted rather than transcribed by hand."""
import re, sys, glob, os

RUNS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "runs")

def parse(path):
    t = open(path).read()
    d = {"file": os.path.basename(path)}
    d["terminated"] = t.rstrip().endswith("--- END OF RUN ---")
    for key, pat in (
        ("wall", r"^wall-clock-seconds:\s*(\d+)"),
        ("exit", r"^exit-code:\s*(\d+)"),
        ("head", r"^head:\s*(\S+)"),
    ):
        m = re.search(pat, t, re.M)
        d[key] = m.group(1) if m else None
    la = re.findall(r"^loadavg(?:-start|-end|):\s*\{\s*([\d.]+)", t, re.M)
    d["load_start"], d["load_end"] = (la[0], la[-1]) if len(la) >= 2 else (None, None)
    d["passed"] = int(m.group(1)) if (m := re.search(r"^\s+(\d+) passed", t, re.M)) else 0
    d["failed"] = int(m.group(1)) if (m := re.search(r"^\s+(\d+) failed", t, re.M)) else 0
    d["flaky"]  = int(m.group(1)) if (m := re.search(r"^\s+(\d+) flaky",  t, re.M)) else 0
    d["fails"] = [l.strip() for l in re.findall(r"^\s+\[chromium\].*$", t, re.M)]
    # canary state decides VOID vs triage
    d["canary_failed"] = any("_canary" in f for f in d["fails"])
    return d

def table(label, pattern):
    rows = sorted(glob.glob(os.path.join(RUNS, pattern)))
    if not rows: return ""
    out = [f"\n**{label}**\n",
           "| run | result | wall clock | load avg (start → end) | evidence intact | condition |",
           "|---|---|---|---|---|---|"]
    for i, p in enumerate(rows, 1):
        d = parse(p)
        total = d["passed"] + d["failed"]
        res = f"**{d['passed']}/{total} passed**" if not d["failed"] else f"{d['failed']} failed, {d['passed']} passed"
        wall = f"{int(d['wall'])//60}m{int(d['wall'])%60:02d}s" if d["wall"] else "?"
        cond = "VOID (canary red)" if d["canary_failed"] else ("clean" if not d["failed"] else "counted — real failures")
        out.append(f"| {i} | {res} | {wall} ({d['wall']}s) | {d['load_start']} → {d['load_end']} | {'yes' if d['terminated'] else 'TRUNCATED'} | {cond} |")
    return "\n".join(out) + "\n"

if __name__ == "__main__":
    print(table("Old config — `npx next dev` (main 66e0cd4), full suite, cold", "oldconfig-nextdev-run*.txt"))
    print(table("New config — built server, `workers: 1`, full suite, cold", "newconfig-w1-run*.txt"))
    print(table("New config — built server, `workers: 2`, full suite, cold", "newconfig-w2-run*.txt"))
    print(table("New config — built server, `workers: 4`, full suite, cold", "newconfig-w4-run*.txt"))
    print(table("Targeted reverse check — `served-lang.spec.ts` alone, cold, OLD `next dev`", "servedlang-OLD-*.txt"))
    print(table("Targeted reverse check — `served-lang.spec.ts` alone, cold, NEW built server", "servedlang-NEW-*.txt"))
    print("\n### Failing tests, by run\n")
    for p in sorted(glob.glob(os.path.join(RUNS, "*.txt"))):
        d = parse(p)
        if d["fails"]:
            print(f"- `{d['file']}`:")
            for f in d["fails"]:
                print(f"  - {f}")
