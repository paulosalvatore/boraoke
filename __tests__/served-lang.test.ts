/**
 * TICKET-79 — the full per-route `<html lang>` resolution matrix.
 *
 * `resolveRequestLocale` is the single value the root layout renders as
 * `<html lang>`, so this file is the unit-level contract for "the served HTML
 * declares the language it is actually written in", per route. It pins the
 * THREE distinct precedence chains and, just as importantly, that they stay
 * distinct — flattening them is the failure mode this ticket exists to prevent.
 *
 * The end-to-end proof (raw HTTP, JS disabled) is `e2e/served-lang.spec.ts`.
 */
import { resolveRequestLocale } from "@/i18n/resolve-request-locale";
import { createRoom } from "@/lib/rooms";

async function roomWith(name: string, language?: "pt-BR" | "en" | "es") {
  const created = await createRoom(name, undefined, language);
  if (!created) throw new Error("room ceiling hit in test");
  return created.room.id;
}

function langFor(
  pathname: string | null,
  ctx: { cookie?: string | null; acceptLanguage?: string | null } = {},
) {
  return resolveRequestLocale({
    pathname,
    cookie: ctx.cookie ?? null,
    acceptLanguage: ctx.acceptLanguage ?? null,
  });
}

const APP_ROUTES = ["/", "/new", "/admin", "/admin/analytics"];

describe("app-wide routes: cookie → Accept-Language → pt-BR", () => {
  it.each(APP_ROUTES)("%s falls back to pt-BR with no signal", async (path) => {
    await expect(langFor(path)).resolves.toBe("pt-BR");
  });

  it.each(APP_ROUTES)("%s honors an explicit cookie", async (path) => {
    await expect(langFor(path, { cookie: "es" })).resolves.toBe("es");
  });

  it.each(APP_ROUTES)("%s honors Accept-Language when there is no cookie", async (path) => {
    await expect(
      langFor(path, { acceptLanguage: "en-GB,en;q=0.9" }),
    ).resolves.toBe("en");
  });

  it.each(APP_ROUTES)("%s: cookie outranks Accept-Language", async (path) => {
    await expect(
      langFor(path, { cookie: "es", acceptLanguage: "en-US,en;q=0.9" }),
    ).resolves.toBe("es");
  });

  it("ignores an unsupported cookie value rather than honoring it", async () => {
    await expect(
      langFor("/new", { cookie: "de", acceptLanguage: "en-US" }),
    ).resolves.toBe("en");
  });
});

describe("patron room: cookie → room default → Accept-Language → pt-BR", () => {
  it("uses the room default when the visitor has no cookie", async () => {
    const id = await roomWith("Bar Chain Sala", "en");
    await expect(langFor(`/${id}`)).resolves.toBe("en");
  });

  it("room default outranks Accept-Language", async () => {
    const id = await roomWith("Bar Chain Header", "en");
    await expect(
      langFor(`/${id}`, { acceptLanguage: "es-ES,es;q=0.9" }),
    ).resolves.toBe("en");
  });

  it("an explicit cookie outranks the room default", async () => {
    const id = await roomWith("Bar Chain Cookie", "en");
    await expect(langFor(`/${id}`, { cookie: "es" })).resolves.toBe("es");
  });

  it("a room that never set a language does NOT swallow the Accept-Language tier", async () => {
    // Regression guard: reading the room tier through `getRoomLanguage` (which
    // normalizes an absent field to pt-BR) would short-circuit here and hand a
    // Spanish-speaking first-time visitor pt-BR. The resolver must read the RAW
    // stored `settings.language`.
    const id = await roomWith("Bar Sem Idioma");
    await expect(
      langFor(`/${id}`, { acceptLanguage: "es-ES,es;q=0.9" }),
    ).resolves.toBe("es");
  });

  it("an unknown room falls through to the app-wide chain", async () => {
    await expect(
      langFor("/sala-que-nao-existe", { acceptLanguage: "en-US,en;q=0.9" }),
    ).resolves.toBe("en");
    await expect(langFor("/sala-que-nao-existe")).resolves.toBe("pt-BR");
  });
});

describe("the three chains stay distinct", () => {
  it("same room, same visitor, different route → different lang", async () => {
    const id = await roomWith("Bar Tres Cadeias", "en");
    const visitor = { cookie: "es", acceptLanguage: "pt-BR,pt;q=0.9" };
    // Patron page: the cookie wins.
    await expect(langFor(`/${id}`, visitor)).resolves.toBe("es");
    // Venue TV: the room wins, always.
    await expect(langFor(`/${id}/tv`, visitor)).resolves.toBe("en");
    // Host console + app-wide routes: the cookie wins (no room tier).
    await expect(langFor(`/${id}/admin`, visitor)).resolves.toBe("es");
    await expect(langFor("/new", visitor)).resolves.toBe("es");
  });

  it("degrades to the pre-TICKET-79 app-wide chain when no pathname arrives", async () => {
    // Middleware missing / header stripped by a proxy: the worst case is exactly
    // today's behavior, never a wrong room's language.
    await expect(langFor(null, { cookie: "es" })).resolves.toBe("es");
    await expect(langFor(null, { acceptLanguage: "en-US" })).resolves.toBe("en");
    await expect(langFor(null)).resolves.toBe("pt-BR");
  });

  it("cannot be steered to an unsupported language by a hostile pathname", async () => {
    for (const hostile of ["/../../etc/passwd/tv", "/<script>/tv", "/%2e%2e/tv"]) {
      await expect(langFor(hostile, { cookie: "es" })).resolves.toBe("es");
    }
  });
});
