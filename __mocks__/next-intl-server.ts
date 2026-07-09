/**
 * Jest stub for `next-intl/server` (TICKET-30).
 *
 * The real module ships ESM that ts-jest (CJS) can't parse, and it needs a live
 * Next request context anyway. Under jest we resolve to the pt-BR source catalog
 * (the default locale in tests) and return real translated strings — so API-route
 * tests that assert on user-facing pt-BR error copy keep passing, while the route
 * code exercises the same `getTranslations(namespace)(key, values)` shape it uses
 * in production. Mapped in jest.config.ts.
 */
import ptBR from "@/messages/pt-BR.json";

type Json = Record<string, unknown>;

function interpolate(template: string, values?: Record<string, unknown>): string {
  if (!values) return template;
  // Minimal `{name}` substitution — enough for the simple args used in the
  // strings the routes localize (no ICU plural/select in Errors).
  return template.replace(/\{\s*([a-zA-Z0-9_]+)\s*\}/g, (_, k) =>
    k in values ? String(values[k]) : `{${k}}`,
  );
}

export async function getTranslations(namespace: string) {
  const ns = (ptBR as Json)[namespace] as Json | undefined;
  return (key: string, values?: Record<string, unknown>) => {
    const raw = ns?.[key];
    return typeof raw === "string" ? interpolate(raw, values) : `${namespace}.${key}`;
  };
}

export async function getLocale(): Promise<string> {
  return "pt-BR";
}
