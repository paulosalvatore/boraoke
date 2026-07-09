/**
 * i18n locale core unit tests (TICKET-30) — locale resolution, Accept-Language
 * matching, type guards, and the native-name/short-label maps. These are the
 * "locale detection/persistence" unit tests; persistence itself (the cookie) is
 * exercised by the e2e switcher spec.
 */
import {
  LOCALES,
  DEFAULT_LOCALE,
  LOCALE_COOKIE,
  LOCALE_NATIVE_NAMES,
  LOCALE_SHORT_LABEL,
  OG_LOCALE,
  isLocale,
  normalizeLocale,
  matchAcceptLanguage,
  resolveLocale,
} from "@/i18n/locales";

describe("locale set + constants", () => {
  it("launches with pt-BR (source), en, es", () => {
    expect(LOCALES).toEqual(["pt-BR", "en", "es"]);
    expect(DEFAULT_LOCALE).toBe("pt-BR");
  });

  it("uses the NEXT_LOCALE cookie name", () => {
    expect(LOCALE_COOKIE).toBe("NEXT_LOCALE");
  });

  it("has a native name + short label + OG locale for every locale", () => {
    for (const l of LOCALES) {
      expect(LOCALE_NATIVE_NAMES[l]).toBeTruthy();
      expect(LOCALE_SHORT_LABEL[l]).toBeTruthy();
      expect(OG_LOCALE[l]).toMatch(/^[a-z]{2}_[A-Z]{2}$/);
    }
    // Native names, never flags / country codes.
    expect(LOCALE_NATIVE_NAMES["pt-BR"]).toBe("Português (Brasil)");
    expect(LOCALE_NATIVE_NAMES.en).toBe("English");
    expect(LOCALE_NATIVE_NAMES.es).toBe("Español");
  });
});

describe("isLocale / normalizeLocale", () => {
  it("accepts supported locales only", () => {
    expect(isLocale("pt-BR")).toBe(true);
    expect(isLocale("en")).toBe(true);
    expect(isLocale("es")).toBe(true);
    expect(isLocale("de")).toBe(false);
    expect(isLocale("")).toBe(false);
    expect(isLocale(undefined)).toBe(false);
    expect(isLocale(42)).toBe(false);
  });

  it("normalizes unknown/absent to the default (no migration)", () => {
    expect(normalizeLocale("en")).toBe("en");
    expect(normalizeLocale("full")).toBe("pt-BR");
    expect(normalizeLocale(undefined)).toBe("pt-BR");
    expect(normalizeLocale(null)).toBe("pt-BR");
  });
});

describe("matchAcceptLanguage", () => {
  it("matches an exact supported tag", () => {
    expect(matchAcceptLanguage("pt-BR")).toBe("pt-BR");
    expect(matchAcceptLanguage("en")).toBe("en");
  });

  it("falls back on the primary subtag", () => {
    expect(matchAcceptLanguage("pt")).toBe("pt-BR");
    expect(matchAcceptLanguage("pt-PT")).toBe("pt-BR");
    expect(matchAcceptLanguage("en-GB")).toBe("en");
    expect(matchAcceptLanguage("es-MX")).toBe("es");
  });

  it("honors q-value ordering", () => {
    expect(matchAcceptLanguage("de;q=0.9, es;q=0.8, en;q=1.0")).toBe("en");
    expect(matchAcceptLanguage("fr-FR,fr;q=0.9,es;q=0.5")).toBe("es");
  });

  it("returns null on no match / empty", () => {
    expect(matchAcceptLanguage("de-DE, ja")).toBeNull();
    expect(matchAcceptLanguage("")).toBeNull();
    expect(matchAcceptLanguage(null)).toBeNull();
    expect(matchAcceptLanguage(undefined)).toBeNull();
  });
});

describe("resolveLocale — precedence (design §3)", () => {
  it("prefers the user cookie above everything", () => {
    expect(
      resolveLocale({
        cookie: "en",
        roomLanguage: "es",
        acceptLanguage: "pt-BR",
      }),
    ).toBe("en");
  });

  it("uses the room language when no valid cookie", () => {
    expect(
      resolveLocale({ cookie: null, roomLanguage: "es", acceptLanguage: "en" }),
    ).toBe("es");
    // An unsupported cookie is ignored, not honored.
    expect(
      resolveLocale({ cookie: "de", roomLanguage: "es", acceptLanguage: "en" }),
    ).toBe("es");
  });

  it("uses Accept-Language when no cookie and no room language", () => {
    expect(
      resolveLocale({ acceptLanguage: "en-US,en;q=0.9" }),
    ).toBe("en");
  });

  it("falls back to pt-BR when nothing matches", () => {
    expect(resolveLocale({})).toBe("pt-BR");
    expect(
      resolveLocale({ cookie: "zz", roomLanguage: "yy", acceptLanguage: "ja" }),
    ).toBe("pt-BR");
  });
});
