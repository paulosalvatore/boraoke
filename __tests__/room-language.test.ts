/**
 * Room default-language persistence (TICKET-30). The `language` field is ADDITIVE
 * and optional on RoomSettings: a fresh/legacy room reads back as pt-BR with no
 * migration and no write; the host mutator persists in place. Mirrors the
 * getRoomMode/setRoomMode contract tests.
 */
import {
  createRoom,
  getRoomLanguage,
  setRoomLanguage,
  getPublicRoom,
} from "@/lib/rooms";

async function mustCreateRoom(name: string) {
  const created = await createRoom(name);
  if (!created) throw new Error("room ceiling hit in test");
  return created;
}

describe("room default language", () => {
  it("defaults to pt-BR on a fresh room (no language field written)", async () => {
    const { room } = await mustCreateRoom("Bar Idioma A");
    expect(await getRoomLanguage(room.id)).toBe("pt-BR");
    // The additive field is NOT written on creation (no migration surface).
    const pub = await getPublicRoom(room.id);
    expect(pub?.settings.language).toBeUndefined();
  });

  it("defaults to pt-BR for an unknown room id (no record)", async () => {
    expect(await getRoomLanguage("does-not-exist")).toBe("pt-BR");
  });

  it("persists a host-set language in place", async () => {
    const { room } = await mustCreateRoom("Bar Idioma B");
    const applied = await setRoomLanguage(room.id, "en");
    expect(applied).toBe("en");
    expect(await getRoomLanguage(room.id)).toBe("en");
    // Mode is untouched — the update is additive.
    const pub = await getPublicRoom(room.id);
    expect(pub?.settings.mode).toBeDefined();
    expect(pub?.settings.language).toBe("en");
  });

  it("is idempotent and re-settable across supported locales", async () => {
    const { room } = await mustCreateRoom("Bar Idioma C");
    await setRoomLanguage(room.id, "es");
    await setRoomLanguage(room.id, "es");
    expect(await getRoomLanguage(room.id)).toBe("es");
    await setRoomLanguage(room.id, "pt-BR");
    expect(await getRoomLanguage(room.id)).toBe("pt-BR");
  });

  it("returns null when setting language on a missing room", async () => {
    expect(await setRoomLanguage("nope-not-here", "en")).toBeNull();
  });
});

/**
 * TICKET-75 — seeding `settings.language` at creation from the creator's locale.
 * The venue TV follows the ROOM's language by design, but nothing ever wrote the
 * field, so every room was born pt-BR. Seeding is ADDITIVE: omitting the arg
 * must reproduce the old record shape exactly (asserted above and again here).
 */
describe("createRoom language seeding (TICKET-75)", () => {
  it.each(["pt-BR", "en", "es"] as const)(
    "seeds settings.language = %s from the creator's locale",
    async (locale) => {
      const created = await createRoom(`Bar Seed ${locale}`, undefined, locale);
      if (!created) throw new Error("room ceiling hit in test");
      const pub = await getPublicRoom(created.room.id);
      expect(pub?.settings.language).toBe(locale);
      expect(await getRoomLanguage(created.room.id)).toBe(locale);
    },
  );

  it("writes NO language key when the arg is omitted (legacy shape preserved)", async () => {
    const { room } = await mustCreateRoom("Bar Seed Omitido");
    const pub = await getPublicRoom(room.id);
    expect(pub?.settings.language).toBeUndefined();
    expect("language" in (pub?.settings ?? {})).toBe(false);
    expect(await getRoomLanguage(room.id)).toBe("pt-BR");
  });

  it("rejects an unsupported value at the storage boundary (never trusts a raw cookie)", async () => {
    for (const bogus of ["de", "en-US", "", "  ", "pt", "../etc/passwd", 42, null]) {
      const created = await createRoom(
        `Bar Seed Ruim ${String(bogus)}`,
        undefined,
        // Deliberately untyped: simulates a spoofed NEXT_LOCALE cookie or an
        // untyped JS caller reaching the storage boundary.
        bogus as never,
      );
      if (!created) throw new Error("room ceiling hit in test");
      const pub = await getPublicRoom(created.room.id);
      expect(pub?.settings.language).toBeUndefined();
      expect(await getRoomLanguage(created.room.id)).toBe("pt-BR");
    }
  });

  it("leaves the mode default untouched while seeding", async () => {
    const created = await createRoom("Bar Seed Modo", undefined, "en");
    if (!created) throw new Error("room ceiling hit in test");
    const pub = await getPublicRoom(created.room.id);
    expect(pub?.settings.mode).toBeDefined();
    expect(pub?.settings.language).toBe("en");
  });

  it("lets the host's manual override WIN over the seeded language", async () => {
    const created = await createRoom("Bar Seed Override", undefined, "en");
    if (!created) throw new Error("room ceiling hit in test");
    expect(await getRoomLanguage(created.room.id)).toBe("en");
    // The admin dashboard mutator writes after creation — it must win.
    expect(await setRoomLanguage(created.room.id, "es")).toBe("es");
    expect(await getRoomLanguage(created.room.id)).toBe("es");
    // ...including overriding back to the default.
    await setRoomLanguage(created.room.id, "pt-BR");
    expect(await getRoomLanguage(created.room.id)).toBe("pt-BR");
  });
});
