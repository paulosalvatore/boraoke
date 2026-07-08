/**
 * Room model + persistence unit tests (TICKET-9).
 */
import {
  slugify,
  generateHostCode,
  hashHostCode,
  isValidRoomId,
  isReservedRoomId,
  deriveRoomName,
  createRoom,
  getRoom,
  getPublicRoom,
  roomMax,
} from "@/lib/rooms";

const ORIGINAL_ENV = { ...process.env };
afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

/** Create a room in tests, asserting the ROOM_MAX ceiling didn't reject it. */
async function mustCreateRoom(name: string) {
  const created = await createRoom(name);
  if (!created) throw new Error("room ceiling hit in test");
  return created;
}

describe("isValidRoomId", () => {
  it("accepts lowercase alnum + hyphen ids", () => {
    expect(isValidRoomId("bar-do-ze-k7q2")).toBe(true);
    expect(isValidRoomId("default")).toBe(true);
    expect(isValidRoomId("a")).toBe(true);
  });

  it("rejects malformed / injection-y ids", () => {
    expect(isValidRoomId("Bar Do Ze")).toBe(false); // spaces + caps
    expect(isValidRoomId("room:default:queue")).toBe(false); // colon (key injection)
    expect(isValidRoomId("../etc")).toBe(false);
    expect(isValidRoomId("")).toBe(false);
    expect(isValidRoomId("x".repeat(65))).toBe(false); // too long
    expect(isValidRoomId(123)).toBe(false);
    expect(isValidRoomId(null)).toBe(false);
  });
});

describe("slugify (TICKET-20 — clean, no random suffix)", () => {
  it("produces a clean, valid, hyphenated slug", () => {
    const slug = slugify("Bar do Zé");
    expect(slug).toBe("bar-do-ze");
    expect(isValidRoomId(slug)).toBe(true);
  });

  it("strips accents and collapses non-alnum runs", () => {
    expect(slugify("Açaí & Cia!!!")).toBe("acai-cia");
  });

  it("falls back to 'sala' for a degenerate name", () => {
    expect(slugify("!!! ###")).toBe("sala");
  });

  it("is deterministic — the same name yields the same clean slug", () => {
    expect(slugify("Bar do Zé")).toBe(slugify("Bar do Zé"));
  });
});

describe("isReservedRoomId (TICKET-20 — reserved-path safety)", () => {
  it("reserves the static routes and the legacy default room", () => {
    for (const id of ["new", "api", "tv", "admin", "default"]) {
      expect(isReservedRoomId(id)).toBe(true);
    }
  });
  it("does not reserve ordinary slugs", () => {
    expect(isReservedRoomId("bar-do-ze")).toBe(false);
    expect(isReservedRoomId("television")).toBe(false); // substring, not equal
  });
});

describe("deriveRoomName (TICKET-20 — recreate-path prefill)", () => {
  it("de-slugifies a clean id", () => {
    expect(deriveRoomName("bar-do-ze")).toBe("Bar Do Ze");
  });
  it("drops a trailing 4-char base32 collision/legacy suffix", () => {
    expect(deriveRoomName("bar-do-paulin-hjj2")).toBe("Bar Do Paulin");
  });
  it("keeps a non-suffix tail", () => {
    expect(deriveRoomName("bar")).toBe("Bar");
  });
});

describe("generateHostCode", () => {
  it("is an 8-char Crockford base32 code", () => {
    const code = generateHostCode();
    expect(code).toMatch(/^[0-9a-hjkmnp-tv-z]{8}$/);
  });

  it("is (practically) unique per call", () => {
    const codes = new Set(Array.from({ length: 100 }, generateHostCode));
    expect(codes.size).toBe(100);
  });
});

describe("createRoom / getRoom / getPublicRoom", () => {
  it("creates and reads back a room record (hash at rest, raw code returned once)", async () => {
    const { room, hostCode } = await mustCreateRoom("Bar do Zé");
    expect(isValidRoomId(room.id)).toBe(true);
    expect(room.name).toBe("Bar do Zé");
    expect(hostCode).toMatch(/^[0-9a-hjkmnp-tv-z]{8}$/);
    expect(room.settings.mode).toBe("full-karaoke"); // TICKET-10 default

    const fetched = await getRoom(room.id);
    expect(fetched?.id).toBe(room.id);
    // Security MEDIUM-2: only the HASH is persisted — the raw code appears
    // nowhere in the stored record.
    expect(fetched?.hostCodeHash).toBe(hashHostCode(hostCode));
    expect(JSON.stringify(fetched)).not.toContain(hostCode);
  });

  it("getPublicRoom never leaks host-code material", async () => {
    const { room, hostCode } = await mustCreateRoom("Bar Público");
    const pub = await getPublicRoom(room.id);
    expect(pub).toBeTruthy();
    expect(pub).not.toHaveProperty("hostCode");
    expect(pub).not.toHaveProperty("hostCodeHash");
    expect(JSON.stringify(pub)).not.toContain(hostCode);
    expect(JSON.stringify(pub)).not.toContain(room.hostCodeHash);
  });

  it("returns null for unknown / invalid ids", async () => {
    expect(await getRoom("no-such-room")).toBeNull();
    expect(await getRoom("bad id!")).toBeNull();
    expect(await getPublicRoom("no-such-room")).toBeNull();
  });

  it("mints a CLEAN slug (no suffix) for a fresh name (TICKET-20)", async () => {
    const { room } = await mustCreateRoom("Boteco Único da Sorte");
    expect(room.id).toBe("boteco-unico-da-sorte");
  });

  it("appends a suffix ONLY on collision with an existing room (TICKET-20)", async () => {
    const first = await mustCreateRoom("Bar Repetido");
    expect(first.room.id).toBe("bar-repetido");
    const second = await mustCreateRoom("Bar Repetido");
    expect(second.room.id).toMatch(/^bar-repetido-[0-9a-hjkmnp-tv-z]{4}$/);
    expect(second.room.id).not.toBe(first.room.id);
  });

  it("never mints a reserved static-route slug — forces a suffix (TICKET-20)", async () => {
    for (const reserved of ["TV", "Admin", "API", "New", "Default"]) {
      const { room } = await mustCreateRoom(reserved);
      expect(isReservedRoomId(room.id)).toBe(false);
      expect(room.id).toMatch(
        new RegExp(`^${reserved.toLowerCase()}-[0-9a-hjkmnp-tv-z]{4}$`),
      );
      expect(isValidRoomId(room.id)).toBe(true);
    }
  });
});

describe("global room ceiling (security HIGH-1)", () => {
  it("roomMax defaults to 500 and honors ROOM_MAX", () => {
    delete process.env.ROOM_MAX;
    expect(roomMax()).toBe(500);
    process.env.ROOM_MAX = "42";
    expect(roomMax()).toBe(42);
    process.env.ROOM_MAX = "not-a-number";
    expect(roomMax()).toBe(500);
  });

  it("createRoom returns null at the ceiling", async () => {
    process.env.ROOM_MAX = "0"; // ceiling already reached
    expect(await createRoom("Bar Lotado")).toBeNull();
  });
});

describe("hashHostCode", () => {
  it("is deterministic, hex, and never equals the raw code", () => {
    const h = hashHostCode("27pxsz4a");
    expect(h).toBe(hashHostCode("27pxsz4a"));
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).not.toBe("27pxsz4a");
    expect(hashHostCode("different")).not.toBe(h);
  });
});
