/**
 * Translation-completeness gate (TICKET-30) — CI-ENFORCED so a missing
 * translation can NEVER ship silently (the TL's "make sure I have all main
 * languages" made durable). Every non-source catalog must carry EXACTLY the same
 * set of leaf keys as the pt-BR source of truth: no missing keys, no extra keys,
 * and matching ICU placeholder sets per key.
 */
import ptBR from "@/messages/pt-BR.json";
import en from "@/messages/en.json";
import es from "@/messages/es.json";
import { LOCALES } from "@/i18n/locales";

type Json = Record<string, unknown>;

/** Flatten a nested message object into dot-path leaf keys. */
function leafKeys(obj: Json, prefix = ""): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      out.push(...leafKeys(v as Json, path));
    } else {
      out.push(path);
    }
  }
  return out.sort();
}

/** Read a leaf value by dot path. */
function at(obj: Json, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, seg) => {
    if (acc && typeof acc === "object") return (acc as Json)[seg];
    return undefined;
  }, obj);
}

/**
 * ICU ARGUMENT names used in a message — the interpolated values (`count`,
 * `position`, `name`, …), NOT plural/select branch bodies (`=0 {vazia}`,
 * `one {# música}`). We walk brace depth: an argument is the identifier that
 * opens a `{...}` group. Branch bodies (`{vazia}`) sit at a DEEPER depth INSIDE
 * a plural/select group, so we skip any `{` that is directly inside a group
 * whose argument used a `plural`/`selectordinal`/`select` sub-token — those
 * inner literals differ per locale and must not count.
 */
function placeholders(value: unknown): Set<string> {
  if (typeof value !== "string") return new Set();
  const names = new Set<string>();
  const idAfterBrace = /^\s*([a-zA-Z0-9_]+)\s*(,|\})/;
  // Stack tracks, per open brace, whether it introduces a format arg (identifier)
  // vs a branch body (literal). A branch-body brace pushes `null`.
  const stack: (string | null)[] = [];
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === "{") {
      const rest = value.slice(i + 1);
      const m = idAfterBrace.exec(rest);
      // A brace opens an argument only when its parent is NOT a branch-body
      // context (i.e. we're at top level or directly inside another arg group's
      // formatted region). Branch bodies live inside a group we marked as a
      // format-with-branches; those inner braces are literals → push null.
      const parentIsBranchHost =
        stack.length > 0 && stack[stack.length - 1] === "__branches__";
      if (m && !parentIsBranchHost) {
        const name = m[1];
        names.add(name);
        // Does this arg use a branch-based format (plural/select/selectordinal)?
        const usesBranches = /^\s*[a-zA-Z0-9_]+\s*,\s*(plural|selectordinal|select)\b/.test(
          rest,
        );
        stack.push(usesBranches ? "__branches__" : name);
      } else {
        stack.push(null);
      }
    } else if (ch === "}") {
      stack.pop();
    }
  }
  return names;
}

const SOURCE_KEYS = leafKeys(ptBR as Json);
const CATALOGS: Record<string, Json> = { en: en as Json, es: es as Json };

describe("translation completeness (CI gate)", () => {
  it("registers pt-BR/en/es as the launch locales", () => {
    expect(LOCALES).toEqual(["pt-BR", "en", "es"]);
  });

  it("pt-BR source has a non-trivial number of keys", () => {
    expect(SOURCE_KEYS.length).toBeGreaterThan(80);
  });

  for (const [name, catalog] of Object.entries(CATALOGS)) {
    describe(`${name}.json`, () => {
      const keys = leafKeys(catalog);

      it("has no MISSING keys vs pt-BR", () => {
        const missing = SOURCE_KEYS.filter((k) => !keys.includes(k));
        expect(missing).toEqual([]);
      });

      it("has no EXTRA keys vs pt-BR", () => {
        const extra = keys.filter((k) => !SOURCE_KEYS.includes(k));
        expect(extra).toEqual([]);
      });

      it("matches ICU placeholder sets per key", () => {
        const mismatches: string[] = [];
        for (const key of SOURCE_KEYS) {
          const src = placeholders(at(ptBR as Json, key));
          const tgt = placeholders(at(catalog, key));
          if (src.size !== tgt.size || [...src].some((p) => !tgt.has(p))) {
            mismatches.push(
              `${key}: pt-BR{${[...src].sort()}} vs ${name}{${[...tgt].sort()}}`,
            );
          }
        }
        expect(mismatches).toEqual([]);
      });
    });
  }
});
