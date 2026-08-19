import { test, expect, request as pwRequest } from "@playwright/test";

/**
 * E2E (TICKET-79) — `<html lang>` in the SERVED HTML, per route.
 *
 * This suite deliberately never opens a browser page. Every assertion is a raw
 * HTTP GET whose body is read as text, which is exactly the JS-disabled view a
 * screen reader, a browser's auto-translate heuristic and a non-executing
 * crawler get. TICKET-75's inline `document.documentElement.lang = …` script
 * would pass a `page.goto` check and fail every assertion here — that is the
 * whole point of the ticket, and the reason these tests have teeth.
 *
 * Each request gets its OWN isolated request context so cookies never leak
 * between cases: the cookie tier is the top of the patron chain and the tier the
 * TV route must ignore, so cross-contamination would silently hide the bug.
 */

const LANG_RE = /<html[^>]*\slang="([^"]*)"/i;

function baseURL(): string {
  const url = test.info().project.use.baseURL;
  if (!url) throw new Error("baseURL is not configured");
  return url;
}

/** A fresh, cookie-isolated HTTP client, optionally carrying a locale cookie. */
async function client(opts: { cookieLocale?: string; acceptLanguage?: string } = {}) {
  const host = new URL(baseURL()).hostname;
  return pwRequest.newContext({
    baseURL: baseURL(),
    extraHTTPHeaders: opts.acceptLanguage
      ? { "Accept-Language": opts.acceptLanguage }
      : {},
    storageState: {
      cookies: opts.cookieLocale
        ? [
            {
              name: "NEXT_LOCALE",
              value: opts.cookieLocale,
              domain: host,
              path: "/",
              expires: -1,
              httpOnly: false,
              secure: false,
              sameSite: "Lax" as const,
            },
          ]
        : [],
      origins: [],
    },
  });
}

/** Raw served HTML for `path` under the given visitor context. */
async function servedHtml(
  path: string,
  opts: { cookieLocale?: string; acceptLanguage?: string } = {},
): Promise<string> {
  const ctx = await client(opts);
  try {
    const res = await ctx.get(path);
    expect(res.ok(), `${path} should render`).toBeTruthy();
    return await res.text();
  } finally {
    await ctx.dispose();
  }
}

/** The `lang` attribute of the served `<html>` element. */
async function servedLang(
  path: string,
  opts: { cookieLocale?: string; acceptLanguage?: string } = {},
): Promise<string | null> {
  const html = await servedHtml(path, opts);
  return LANG_RE.exec(html)?.[1] ?? null;
}

/** Create a room seeded with `language` (seeded from the creator's cookie). */
async function createRoomWithLanguage(language: string): Promise<string> {
  const ctx = await client({ cookieLocale: language });
  try {
    const res = await ctx.post("/api/rooms", {
      data: { name: `Lang ${language} ${Date.now().toString(36)}` },
    });
    expect(res.ok(), "room creation should succeed").toBeTruthy();
    return (await res.json()).id as string;
  } finally {
    await ctx.dispose();
  }
}

test.describe("served <html lang> per route (TICKET-79)", () => {
  test("app-wide routes follow the visitor: cookie, then Accept-Language, then pt-BR", async () => {
    for (const path of ["/", "/new", "/admin", "/admin/analytics"]) {
      expect(await servedLang(path, { acceptLanguage: "pt-BR,pt;q=0.9" })).toBe("pt-BR");
      expect(await servedLang(path, { cookieLocale: "es" })).toBe("es");
      expect(await servedLang(path, { acceptLanguage: "en-US,en;q=0.9" })).toBe("en");
      // Cookie outranks the header.
      expect(
        await servedLang(path, { cookieLocale: "es", acceptLanguage: "en-US,en;q=0.9" }),
      ).toBe("es");
    }
  });

  test("the venue TV serves the ROOM's language, never the visitor's", async () => {
    const room = await createRoomWithLanguage("en");

    // The exact bug TICKET-75 was filed for: an `es` patron cookie on a room
    // whose screen renders English copy.
    expect(await servedLang(`/${room}/tv`, { cookieLocale: "es" })).toBe("en");
    expect(
      await servedLang(`/${room}/tv`, { acceptLanguage: "es-ES,es;q=0.9" }),
    ).toBe("en");
    expect(await servedLang(`/${room}/tv`)).toBe("en");

    // …and the copy in that same response really is English, so the declared
    // language and the content agree in ONE document.
    const html = await servedHtml(`/${room}/tv`, { cookieLocale: "es" });
    expect(html).toContain("Scan to join the queue");
    expect(html).not.toContain("Escaneia para entrar na fila");
  });

  test("the legacy /default screen stays pt-BR for any visitor", async () => {
    expect(
      await servedLang("/default/tv", { cookieLocale: "es", acceptLanguage: "en-US" }),
    ).toBe("pt-BR");
  });

  test("the TICKET-75 client-side lang patch is gone from the served HTML", async () => {
    const room = await createRoomWithLanguage("en");
    const html = await servedHtml(`/${room}/tv`, { cookieLocale: "es" });
    expect(html).not.toContain("document.documentElement.lang");
  });

  test("the patron room keeps its full chain: cookie → room → Accept-Language → pt-BR", async () => {
    const room = await createRoomWithLanguage("en");

    // No cookie → the venue's default wins over the browser's own preference.
    expect(await servedLang(`/${room}`, { acceptLanguage: "es-ES,es;q=0.9" })).toBe("en");
    // An explicit patron cookie still wins over the venue default.
    expect(await servedLang(`/${room}`, { cookieLocale: "es" })).toBe("es");
    // A room nobody ever created falls through to the visitor's own chain.
    expect(
      await servedLang("/sala-inexistente-79", { acceptLanguage: "en-US,en;q=0.9" }),
    ).toBe("en");
  });

  test("the host console follows the host's cookie, not the room", async () => {
    const room = await createRoomWithLanguage("en");
    expect(await servedLang(`/${room}/admin`, { cookieLocale: "es" })).toBe("es");
  });

  test("metadata still renders alongside the lang fix (TICKET-74 guard)", async () => {
    const html = await servedHtml("/", { acceptLanguage: "pt-BR,pt;q=0.9" });
    expect(html).toContain('property="og:locale" content="pt_BR"');
    // TICKET-74's negative assertion: the retired brand must not resurface.
    expect(html.toLowerCase()).not.toContain("cantai");
  });
});
