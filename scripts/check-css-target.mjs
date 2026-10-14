#!/usr/bin/env node
/**
 * CSS target gate (TICKET-101), sibling to check-bundle-es-target.mjs.
 *
 * WHY A SEPARATE GATE: the ES parse gate cannot see this class of defect. Invalid
 * or unsupported JS syntax throws and takes the whole app down — loud, and
 * catchable by parsing. Unsupported CSS is simply DROPPED by the engine: nothing
 * errors, nothing logs, and the page renders with its layout quietly wrong. On a
 * television that reads as a broken product rather than a broken browser.
 *
 * This was found when the ES fix (PR #76) declared `chrome >= 68` while the
 * stylesheets used `gap` inside flex containers (Chrome 84) and `aspect-ratio`
 * (Chrome 88) — a declared target the CSS did not actually meet.
 *
 * NOTE ON FLEX GAP, because the obvious fix is wrong: you cannot feature-query
 * it. `@supports (gap: 1px)` reports TRUE on old Chrome, because *grid* gap
 * shipped in 66 while *flex* gap did not arrive until 84. A `@supports` guard
 * therefore silently fails exactly where it is needed. The only reliable
 * approach for the low floor is to not depend on flex gap at all.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Oldest engine we intend to RENDER correctly on. Chrome 68 == LG webOS 4.5/5.0. */
const TARGET_CHROME = Number(process.env.CSS_TARGET_CHROME ?? 68);

/**
 * STRICT set — the surfaces actually rendered ON A TELEVISION. These must hold at
 * the low floor, because a venue's TV is the device we cannot choose. Everything
 * else (phone, desktop, host console) is reported as ADVISORY: those users are on
 * modern browsers, and holding the whole app to a 2019 TV floor would cost more
 * than it buys. Which TVs we support is a product decision (TICKET-101); this
 * split is what lets the TV be fixed without waiting for that decision.
 */
const STRICT = [
  "components/tv/tv.module.css",
  "app/globals.css",
  // Promoted 2026-09-01 (TICKET-101): a TV browser does not only render /tv. A
  // venue pointing its television at the landing page — the obvious thing to do
  // when setting a room up — hit the same silent spacing collapse. These three
  // are what a TV can actually reach.
  "app/page.module.css",
  "components/LanguageSwitcher.module.css",
  "components/feedback/FeedbackWidget.module.css",
];

const FEATURES = [
  { name: "aspect-ratio", chrome: 88, re: /(^|[;{\s])aspect-ratio\s*:/g },
  { name: "inset shorthand", chrome: 87, re: /(^|[;{\s])inset\s*:/g },
  { name: ":is()", chrome: 88, re: /:is\(/g },
  { name: ":where()", chrome: 88, re: /:where\(/g },
  { name: ":has()", chrome: 105, re: /:has\(/g },
  { name: "color-mix()", chrome: 111, re: /color-mix\(/g },
  { name: "clamp()", chrome: 79, re: /clamp\(/g },
  { name: "backdrop-filter", chrome: 76, re: /backdrop-filter\s*:/g },
  { name: "dvh/svh/lvh units", chrome: 108, re: /\b\d[\d.]*(dvh|svh|lvh|dvw|svw|lvw)\b/g },
  { name: "@container", chrome: 105, re: /@container\b/g },
  { name: "content-visibility", chrome: 85, re: /content-visibility\s*:/g },
  { name: "accent-color", chrome: 93, re: /(^|[;{\s])accent-color\s*:/g },
  { name: "text-wrap", chrome: 114, re: /text-wrap\s*:/g },
  { name: "scrollbar-gutter", chrome: 94, re: /scrollbar-gutter\s*:/g },
];

/** Flex gap needs its own detection: a rule that is BOTH display:flex and has gap. */
const FLEX_GAP_CHROME = 84;

function collectCss(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir); } catch { return out; }
  for (const e of entries) {
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) collectCss(p, out);
    else if (e.endsWith(".css")) out.push(p);
  }
  return out;
}

/** Split into top-level-ish rule blocks so flex+gap can be judged per rule. */
function ruleBlocks(css) {
  const blocks = [];
  let depth = 0, start = 0;
  for (let i = 0; i < css.length; i++) {
    if (css[i] === "{") { if (depth === 0) start = i; depth++; }
    else if (css[i] === "}") { depth--; if (depth === 0) blocks.push(css.slice(start, i + 1)); }
  }
  return blocks;
}

const dir = process.argv[2] ?? ".";
const files = collectCss(dir).filter((f) => !f.includes("node_modules") && !f.includes("/.next/") && !/(^|\/)work\//.test(f.replace(/^\.\//, "")));  // work/ holds design mockups, never shipped
if (files.length === 0) {
  console.error(`css-target: FAIL — no source .css files found under ${dir}.`);
  console.error("Refusing to report success on an empty scan — a zero result must mean zero findings, not zero files scanned.");
  process.exit(1);
}

const findings = [];
for (const f of files) {
  const raw = readFileSync(f, "utf8");
  // Strip block comments before matching. A comment is not shipped CSS, and
  // prose that merely NAMES a feature (this file's own explanations do) is not a
  // use of it — matching them produced a false positive that could only be
  // silenced by not writing the explanation, which is the wrong incentive.
  // Newlines are preserved so the per-line annotation check still lines up.
  const css = raw.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  for (const feat of FEATURES) {
    if (feat.chrome <= TARGET_CHROME) continue;
    // A newer feature is ALLOWED when the author has written a fallback and said
    // so on the same line with `css-target-allow: <why>`. Progressive enhancement
    // via the plain cascade (an old engine drops the declaration it cannot parse
    // and keeps the one before it) is the CORRECT way to use these — a gate that
    // banned it outright would push people toward worse CSS, not better. The
    // annotation is deliberate and reviewable: it cannot be applied by accident,
    // and it shows up in the diff for whoever reviews the PR.
    // Match against the comment-stripped text (so prose naming a feature is not a
    // use of it), but read the annotation from the RAW line — stripping blanks the
    // comment the annotation lives in.
    const strippedLines = css.split("\n");
    const rawLines = raw.split("\n");
    let n = 0;
    for (let i = 0; i < strippedLines.length; i++) {
      feat.re.lastIndex = 0;
      if (!feat.re.test(strippedLines[i])) continue;
      if (/css-target-allow/.test(rawLines[i] ?? "")) continue;
      n++;
    }
    feat.re.lastIndex = 0;
    if (n > 0) findings.push({ file: f, feature: feat.name, chrome: feat.chrome, count: n });
  }
  if (FLEX_GAP_CHROME > TARGET_CHROME) {
    let flexGap = 0;
    for (const b of ruleBlocks(css)) {
      if (/display\s*:\s*(inline-)?flex/.test(b) && /(^|[;{\s])(row-|column-)?gap\s*:/.test(b)) flexGap++;
    }
    if (flexGap > 0) findings.push({ file: f, feature: "gap inside display:flex", chrome: FLEX_GAP_CHROME, count: flexGap });
  }
}

const isStrict = (f) => STRICT.some((s) => f.replace(/^\.\//, "").endsWith(s));
const strictFindings = findings.filter((x) => isStrict(x.file));
const advisory = findings.filter((x) => !isStrict(x.file));

if (advisory.length > 0) {
  console.log(`css-target: advisory — ${advisory.length} finding(s) outside the TV surface (phone/desktop, not build-blocking):`);
  for (const { file, feature, chrome, count } of advisory) {
    console.log(`  ${feature} (Chrome ${chrome}) x${count} — ${file}`);
  }
  console.log("");
}

if (strictFindings.length > 0) {
  console.error(`\ncss-target: FAIL — the TV surface uses features newer than Chrome ${TARGET_CHROME}.\n`);
  for (const { file, feature, chrome, count } of strictFindings) {
    console.error(`  ${feature}  (needs Chrome ${chrome})  x${count}\n    ${file}`);
  }
  console.error(`
Unsupported CSS is DROPPED, not thrown: the TV will render with its layout
quietly wrong rather than failing loudly. Fix by removing the dependency on the
feature, NOT by wrapping it in @supports — for flex gap in particular,
@supports (gap: 1px) reports true on old Chrome because grid gap shipped in 66,
so the guard passes exactly where it is needed.
`);
  process.exit(1);
}

console.log(`css-target: OK — the TV surface uses nothing newer than Chrome ${TARGET_CHROME} (${files.length} stylesheet(s) scanned).`);
