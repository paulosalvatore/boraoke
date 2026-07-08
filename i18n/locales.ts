/**
 * i18n core vocabulary (TICKET-30) — client-safe, zero server imports.
 *
 * Single source of truth for the supported locale set, the source-of-truth
 * locale, native display names (design §3: native names, never flags), the
 * locale cookie name, and the pure locale-resolution function. Imported by both
 * server code (`i18n/request.ts`, API routes) and client code (the language
 * switcher), so it must stay dependency-free.
 *
 * URL DECISION (documented, TICKET-30): rooms are addressed as `/<room>` and
 * that MUST NOT change. We therefore run next-intl WITHOUT i18n routing — locale
 * lives in the `NEXT_LOCALE` cookie, never in the path. No `[locale]` segment,
 * no middleware rewrite of room URLs. Resolution order (design §3):
 *   explicit user cookie → room default language → Accept-Language → pt-BR.
 */

/** Launch locale set (design §3). Order is the switcher display order. */
export const LOCALES = ["pt-BR", "en", "es"] as const;

export type Locale = (typeof LOCALES)[number];

/** Source-of-truth locale (all keys authored here first) + ultimate fallback. */
export const DEFAULT_LOCALE: Locale = "pt-BR";

/**
 * Locale cookie name. `NEXT_LOCALE` is next-intl's conventional name and is
 * also what Next.js itself reads for locale hints — one name, both worlds.
 */
export const LOCALE_COOKIE = "NEXT_LOCALE";

/** 1 year, in seconds — the switcher choice should stick. */
export const LOCALE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

/**
 * Native display names — ALWAYS native, NEVER flags (design §3: a flag is a
 * country, not a language). Rendered in the switcher sheet/popover.
 */
export const LOCALE_NATIVE_NAMES: Record<Locale, string> = {
  "pt-BR": "Português (Brasil)",
  en: "English",
  es: "Español",
};

/**
 * Short label for the globe pill trigger (design mockup: `🌐 PT`). Uppercased
 * two/three-letter tag, distinct per locale.
 */
export const LOCALE_SHORT_LABEL: Record<Locale, string> = {
  "pt-BR": "PT",
  en: "EN",
  es: "ES",
};

/**
 * OpenGraph `locale` value (underscore form) per app locale. Used by the
 * per-locale OG metadata lookup.
 */
export const OG_LOCALE: Record<Locale, string> = {
  "pt-BR": "pt_BR",
  en: "en_US",
  es: "es_ES",
};

/** Type guard: is `value` one of the supported locales? */
export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

/**
 * Coerce any stored/legacy settings value to a valid {@link Locale}. Absent or
 * unrecognized → {@link DEFAULT_LOCALE} (pt-BR). Mirrors `normalizeRoomMode`'s
 * "no re-migration" contract for the room-language field.
 */
export function normalizeLocale(value: unknown): Locale {
  return isLocale(value) ? value : DEFAULT_LOCALE;
}

/**
 * Best-effort match of an `Accept-Language` header to a supported locale.
 * Handles quality values (`q=`), exact tags (`pt-BR`), and primary-subtag
 * fallback (`pt` → `pt-BR`, `en-GB` → `en`). Returns null when nothing matches
 * so the caller can fall through to the next resolution step.
 */
export function matchAcceptLanguage(header: string | null | undefined): Locale | null {
  if (!header) return null;
  const ranges = header
    .split(",")
    .map((part) => {
      const [tag, ...params] = part.trim().split(";");
      const qParam = params.find((p) => p.trim().startsWith("q="));
      const q = qParam ? Number(qParam.split("=")[1]) : 1;
      return { tag: tag.trim().toLowerCase(), q: Number.isFinite(q) ? q : 1 };
    })
    .filter((r) => r.tag && r.q > 0)
    .sort((a, b) => b.q - a.q);

  for (const { tag } of ranges) {
    // Exact match (case-insensitive) against a supported locale.
    const exact = LOCALES.find((l) => l.toLowerCase() === tag);
    if (exact) return exact;
    // Primary-subtag match: `pt-*` → pt-BR, `en-*` → en, `es-*` → es.
    const primary = tag.split("-")[0];
    const byPrimary = LOCALES.find((l) => l.toLowerCase().split("-")[0] === primary);
    if (byPrimary) return byPrimary;
  }
  return null;
}

/**
 * The full locale-resolution decision (design §3), as a pure function so it is
 * unit-testable in isolation. Precedence, highest first:
 *   1. explicit user cookie (a supported locale)
 *   2. room default language (venue-set — a German wedding sets `de` one day)
 *   3. Accept-Language (first-visit browser hint)
 *   4. DEFAULT_LOCALE (pt-BR)
 * Any unsupported value at a given tier is skipped, not honored.
 */
export function resolveLocale(input: {
  cookie?: string | null;
  roomLanguage?: string | null;
  acceptLanguage?: string | null;
}): Locale {
  if (isLocale(input.cookie)) return input.cookie;
  if (isLocale(input.roomLanguage)) return input.roomLanguage;
  const fromHeader = matchAcceptLanguage(input.acceptLanguage);
  if (fromHeader) return fromHeader;
  return DEFAULT_LOCALE;
}
