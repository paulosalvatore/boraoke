/**
 * TICKET-79 — pathname → locale-chain classification.
 *
 * `i18n/route-locale.ts` is the pure half of the served-`<html lang>` fix: it
 * decides WHICH of the three precedence chains a request gets, from nothing but
 * the pathname the middleware forwards. It must stay edge/client-safe, so it
 * mirrors `lib/rooms`'s room-id vocabulary instead of importing it — the last
 * describe block is the drift guard on that mirror.
 */
import { classifyLocaleRoute, PATHNAME_HEADER } from "@/i18n/route-locale";
import { isValidRoomId, RESERVED_ROOM_IDS } from "@/lib/rooms";

describe("classifyLocaleRoute (TICKET-79)", () => {
  it("classifies the venue TV as room-locale", () => {
    expect(classifyLocaleRoute("/bar-do-ze/tv")).toEqual({
      kind: "tv",
      room: "bar-do-ze",
    });
  });

  it("keeps the legacy default room's TV on the room chain", () => {
    // `/default` has no record, so `getRoomLanguage` reads pt-BR — which is
    // exactly what TICKET-75's script put there. Classifying it as `app` would
    // hand the shared screen a patron's cookie locale instead.
    expect(classifyLocaleRoute("/default/tv")).toEqual({
      kind: "tv",
      room: "default",
    });
  });

  it("classifies the patron room page as the full room chain", () => {
    expect(classifyLocaleRoute("/bar-do-ze")).toEqual({
      kind: "room",
      room: "bar-do-ze",
    });
  });

  it.each([
    ["/", "landing"],
    ["/new", "create-room"],
    ["/admin", "global admin"],
    ["/admin/analytics", "admin analytics"],
    ["/tv", "legacy TV redirect"],
    ["/default", "legacy global room (no record)"],
    ["/api/queue", "API route"],
  ])("classifies %s as app-wide (%s)", (path) => {
    expect(classifyLocaleRoute(path)).toEqual({ kind: "app" });
  });

  it("leaves the host console on the app-wide chain, unlike the TV", () => {
    // The admin console is a personal device: it keeps following the host's own
    // cookie. Only the SHARED screen is pinned to the room.
    expect(classifyLocaleRoute("/bar-do-ze/admin")).toEqual({ kind: "app" });
  });

  it("is total — a missing or malformed path degrades to app-wide", () => {
    for (const input of [null, undefined, "", "///", "/a/b/c", "/BAR/tv", "/b@d/tv"]) {
      expect(classifyLocaleRoute(input)).toEqual({ kind: "app" });
    }
  });

  it("ignores a query string or hash on the forwarded value", () => {
    expect(classifyLocaleRoute("/bar-do-ze/tv?debug=1")).toEqual({
      kind: "tv",
      room: "bar-do-ze",
    });
    expect(classifyLocaleRoute("/bar-do-ze#top")).toEqual({
      kind: "room",
      room: "bar-do-ze",
    });
  });

  it("uses an app-specific header name", () => {
    expect(PATHNAME_HEADER).toBe("x-boraoke-pathname");
  });
});

describe("the mirrored room vocabulary does not drift from lib/rooms", () => {
  it("accepts exactly the ids lib/rooms considers valid", () => {
    const valid = ["a", "bar-do-ze", "sala1", "x".repeat(64)];
    const invalid = ["", "BAR", "bar_do_ze", "bar do ze", "x".repeat(65), "acentuação"];
    for (const id of valid) {
      expect(isValidRoomId(id)).toBe(true);
      expect(classifyLocaleRoute(`/${id}/tv`)).toEqual({ kind: "tv", room: id });
    }
    for (const id of invalid) {
      expect(isValidRoomId(id)).toBe(false);
      expect(classifyLocaleRoute(`/${id}/tv`)).toEqual({ kind: "app" });
    }
  });

  it("treats every RESERVED_ROOM_ID as a static route, not a venue", () => {
    for (const id of RESERVED_ROOM_IDS) {
      expect(classifyLocaleRoute(`/${id}`)).toEqual({ kind: "app" });
    }
  });
});
