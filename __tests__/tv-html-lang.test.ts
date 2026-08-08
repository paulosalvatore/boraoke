/**
 * TICKET-75 — `<html lang>` / content agreement on the venue TV route.
 *
 * The root layout sets `<html lang>` from the REQUEST locale (NEXT_LOCALE cookie
 * / Accept-Language), but `/[room]/tv` deliberately renders ROOM-locale messages
 * (a venue screen cannot follow 40 patrons' phones). That served pages as e.g.
 * `lang="es"` with 100% pt-BR copy — broken for screen readers, browser
 * auto-translate and SEO.
 *
 * The route now emits `documentLangScript(locale)` from the SAME resolved room
 * locale it hands to the message provider, so the two cannot disagree. These
 * tests pin the helper's contract and the room-locale resolution that feeds it;
 * the App Tester gate confirms the attribute end-to-end in a real browser (the
 * page component itself is JSX, which this ts-jest/node project does not
 * transform).
 */
import { documentLangScript, LOCALES } from "@/i18n/locales";
import { createRoom, getRoomLanguage, setRoomLanguage } from "@/lib/rooms";

async function roomWith(name: string, language?: "pt-BR" | "en" | "es") {
  const created = await createRoom(name, undefined, language);
  if (!created) throw new Error("room ceiling hit in test");
  return created.room.id;
}

describe("documentLangScript (TICKET-75)", () => {
  it.each(LOCALES)("emits the assignment for %s", (locale) => {
    expect(documentLangScript(locale)).toBe(
      `document.documentElement.lang="${locale}";`,
    );
  });

  it("falls back to pt-BR for an absent/unsupported value", () => {
    for (const bogus of [undefined, null, "", "de", "en-US", "pt", 42]) {
      expect(documentLangScript(bogus)).toBe(
        'document.documentElement.lang="pt-BR";',
      );
    }
  });

  it("cannot inject script from a hostile value (fixed enum + JSON encoding)", () => {
    const hostile = '";</script><script>alert(1)//';
    const out = documentLangScript(hostile);
    expect(out).toBe('document.documentElement.lang="pt-BR";');
    expect(out).not.toContain("</script>");
    expect(out).not.toContain("alert");
  });
});

describe("the TV's lang follows the ROOM locale (TICKET-75)", () => {
  it.each(["pt-BR", "en", "es"] as const)(
    "a room seeded with %s renders that lang",
    async (locale) => {
      const id = await roomWith(`Bar Lang ${locale}`, locale);
      // Exactly what the page does: one resolved locale feeds BOTH the message
      // provider and the document language.
      const resolved = await getRoomLanguage(id);
      expect(resolved).toBe(locale);
      expect(documentLangScript(resolved)).toBe(
        `document.documentElement.lang="${locale}";`,
      );
    },
  );

  it("a legacy room with no stored language renders lang=pt-BR", async () => {
    const id = await roomWith("Bar Lang Legado");
    const resolved = await getRoomLanguage(id);
    expect(resolved).toBe("pt-BR");
    expect(documentLangScript(resolved)).toBe(
      'document.documentElement.lang="pt-BR";',
    );
  });

  it("follows the host's manual override, not the seeded value", async () => {
    const id = await roomWith("Bar Lang Override", "en");
    await setRoomLanguage(id, "es");
    const resolved = await getRoomLanguage(id);
    expect(resolved).toBe("es");
    expect(documentLangScript(resolved)).toBe(
      'document.documentElement.lang="es";',
    );
  });

  it("an unknown room id resolves to pt-BR without throwing", async () => {
    const resolved = await getRoomLanguage("no-such-room-at-all");
    expect(resolved).toBe("pt-BR");
    expect(documentLangScript(resolved)).toBe(
      'document.documentElement.lang="pt-BR";',
    );
  });
});
