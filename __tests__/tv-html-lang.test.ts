/**
 * TICKET-75 → TICKET-79 — `<html lang>` / content agreement, now SERVER-SIDE.
 *
 * The root layout sets `<html lang>` from the next-intl REQUEST locale, but
 * `/[room]/tv` deliberately renders ROOM-locale messages (a venue screen cannot
 * follow 40 patrons' phones). That served pages as e.g. `lang="es"` with 100%
 * pt-BR copy — broken for screen readers, browser auto-translate and SEO.
 *
 * TICKET-75 could not touch the root layout, so it patched the attribute from an
 * inline post-hydration script (`documentLangScript`). That left the SERVED HTML
 * wrong with JS disabled. TICKET-79 replaces it: `resolveRequestLocale` applies
 * the TV route's room chain inside the request config, upstream of the layout,
 * so the attribute is right in the response itself and the script is gone.
 *
 * These tests keep every TICKET-75 scenario — seeded language, legacy room, host
 * override, unknown room — and re-point them at the server-side resolver. The
 * end-to-end proof over raw HTTP lives in `e2e/served-lang.spec.ts`.
 */
import { resolveRequestLocale } from "@/i18n/resolve-request-locale";
import { LOCALES } from "@/i18n/locales";
import { createRoom, setRoomLanguage } from "@/lib/rooms";

async function roomWith(name: string, language?: "pt-BR" | "en" | "es") {
  const created = await createRoom(name, undefined, language);
  if (!created) throw new Error("room ceiling hit in test");
  return created.room.id;
}

/** The resolution a request for `/<room>/tv` gets, given a patron's context. */
function tvLocale(
  room: string,
  ctx: { cookie?: string; acceptLanguage?: string } = {},
) {
  return resolveRequestLocale({
    pathname: `/${room}/tv`,
    cookie: ctx.cookie ?? null,
    acceptLanguage: ctx.acceptLanguage ?? null,
  });
}

describe("the TV's served lang follows the ROOM locale (TICKET-75 / TICKET-79)", () => {
  it.each(LOCALES)("a room seeded with %s serves that lang", async (locale) => {
    const id = await roomWith(`Bar Lang ${locale}`, locale);
    await expect(tvLocale(id)).resolves.toBe(locale);
  });

  it("a legacy room with no stored language serves lang=pt-BR", async () => {
    const id = await roomWith("Bar Lang Legado");
    await expect(tvLocale(id)).resolves.toBe("pt-BR");
  });

  it("follows the host's manual override, not the seeded value", async () => {
    const id = await roomWith("Bar Lang Override", "en");
    await setRoomLanguage(id, "es");
    await expect(tvLocale(id)).resolves.toBe("es");
  });

  it("an unknown room id resolves to pt-BR without throwing", async () => {
    await expect(tvLocale("no-such-room-at-all")).resolves.toBe("pt-BR");
  });

  it("NEVER follows a patron cookie — the whole point of the route", async () => {
    const id = await roomWith("Bar Lang Cookie", "pt-BR");
    for (const cookie of LOCALES) {
      await expect(tvLocale(id, { cookie })).resolves.toBe("pt-BR");
    }
  });

  it("NEVER follows Accept-Language either", async () => {
    const id = await roomWith("Bar Lang Header", "en");
    await expect(
      tvLocale(id, { acceptLanguage: "es-ES,es;q=0.9,pt-BR;q=0.8" }),
    ).resolves.toBe("en");
  });

  it("the legacy /default room's screen stays pt-BR under any patron context", async () => {
    await expect(
      tvLocale("default", { cookie: "es", acceptLanguage: "en-US,en;q=0.9" }),
    ).resolves.toBe("pt-BR");
  });
});
