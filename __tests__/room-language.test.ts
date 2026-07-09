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
