#!/usr/bin/env node
/**
 * Bundle ES-target gate (TICKET-98 / TICKET-99).
 *
 * WHY THIS EXISTS: on 2026-08-27 the product failed completely on the Tech
 * Lead's LG TV — the page never loaded, no QR, every song errored. The cause was
 * not a bug in our code and not a missing test: a DEPENDENCY (`next-intl`)
 * shipped `static {}` class initialization blocks, which are ES2022 and need
 * Chrome 94+. Next.js does not downlevel `node_modules` by default, so it went
 * straight into the client bundle. A parse failure is total — the chunk never
 * executes, so the app never boots.
 *
 * The e2e suite was 106/106 green throughout, because it runs desktop Chromium.
 * No amount of extra specs on a modern engine can catch a syntax floor. This
 * gate can, it needs no browser at all, and it would have caught this defect the
 * day the dependency landed.
 *
 * SCOPE, stated honestly: this checks PARSE-level compatibility only. A chunk
 * that parses can still call an API the target engine lacks (a newer `Intl`
 * option, `structuredClone`, an unsupported CSS feature). Those need a real or
 * emulated device — see TICKET-99. This gate closes the failure mode that
 * actually bit us, not the whole class.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import * as acorn from "acorn";

/**
 * The oldest engine we intend to boot on, expressed as an ECMAScript version.
 * ES2019 == Chrome 68 == LG webOS 4.5/5.0 (2019-2020 TVs), which is the baseline
 * the browserslist in package.json also names. Raising this is a PRODUCT
 * decision about which televisions stop working, not a build tweak — if you
 * change it, change the browserslist with it and say so in the PR.
 */
const TARGET_ECMA = 2019;

const BUILD_DIR = process.argv[2] ?? ".next/static";

function collectJs(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir); } catch { return out; }
  for (const e of entries) {
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) collectJs(p, out);
    else if (e.endsWith(".js")) out.push(p);
  }
  return out;
}

const files = collectJs(BUILD_DIR);
if (files.length === 0) {
  console.error(`bundle-es-target: FAIL — no .js files found under ${BUILD_DIR}.`);
  console.error("Refusing to report success on an empty scan: run `npm run build` first.");
  process.exit(1);
}

const failures = [];
for (const f of files) {
  const src = readFileSync(f, "utf8");
  try {
    acorn.parse(src, { ecmaVersion: TARGET_ECMA, sourceType: "script" });
  } catch (err) {
    // Re-parse permissively to name the construct that is too new, so the error
    // tells you WHAT to fix rather than only where.
    let detail = "";
    try {
      acorn.parse(src, { ecmaVersion: "latest", sourceType: "script" });
      const line = src.split("\n")[(err.loc?.line ?? 1) - 1] ?? "";
      const col = err.loc?.column ?? 0;
      detail = line.slice(Math.max(0, col - 70), col + 70);
    } catch {
      detail = "(also fails to parse at latest — likely not plain script syntax)";
    }
    failures.push({ file: f, message: err.message, detail });
  }
}

if (failures.length > 0) {
  console.error(`\nbundle-es-target: FAIL — ${failures.length} of ${files.length} chunk(s) cannot be parsed at ES${TARGET_ECMA}.\n`);
  for (const { file, message, detail } of failures) {
    console.error(`  ${file}`);
    console.error(`    ${message}`);
    console.error(`    near: ...${detail}...\n`);
  }
  console.error("A chunk that cannot be PARSED never executes, so the whole app fails to boot on");
  console.error(`any engine older than the one this syntax requires — not just the affected feature.`);
  console.error("Usual cause: a dependency shipping modern syntax. Next.js does not downlevel");
  console.error("node_modules by default — add the package to `transpilePackages` in next.config.ts.\n");
  process.exit(1);
}

console.log(`bundle-es-target: OK — all ${files.length} chunk(s) parse at ES${TARGET_ECMA}.`);
