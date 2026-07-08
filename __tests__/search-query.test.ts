import { augmentQuery, containsKaraoke } from "@/lib/search-query";

/**
 * TICKET-40 §2 — mode-aware search-query augmentation.
 * Sing mode appends "karaoke"; listen/dance searches raw; never doubles an
 * existing "karaoke"; never augments an empty query.
 */
describe("augmentQuery (mode-aware karaoke keyword)", () => {
  describe("sing mode", () => {
    it("appends 'karaoke' to a plain query", () => {
      expect(augmentQuery("evidencias", "sing")).toBe("evidencias karaoke");
    });

    it("trims surrounding whitespace before appending", () => {
      expect(augmentQuery("  evidencias  ", "sing")).toBe("evidencias karaoke");
    });

    it("does NOT double 'karaoke' when already present (exact)", () => {
      expect(augmentQuery("evidencias karaoke", "sing")).toBe("evidencias karaoke");
    });

    it("does NOT double 'karaoke' — case-insensitive", () => {
      expect(augmentQuery("Evidencias KARAOKE", "sing")).toBe("Evidencias KARAOKE");
      expect(augmentQuery("Karaokê is different but Karaoke matches", "sing")).toBe(
        "Karaokê is different but Karaoke matches",
      );
    });

    it("does NOT double when 'karaoke' appears mid-query", () => {
      expect(augmentQuery("karaoke evidencias", "sing")).toBe("karaoke evidencias");
    });

    it("treats 'karaokes'/substrings as NOT already-karaoke (whole word only)", () => {
      // "karaokestar" is not the whole word "karaoke", so it still gets appended.
      expect(augmentQuery("karaokestar", "sing")).toBe("karaokestar karaoke");
    });
  });

  describe("listen/dance mode", () => {
    it("leaves the query unchanged", () => {
      expect(augmentQuery("evidencias", "listen-dance")).toBe("evidencias");
    });

    it("trims but never appends", () => {
      expect(augmentQuery("  evidencias  ", "listen-dance")).toBe("evidencias");
    });

    it("does not strip a user-typed 'karaoke' in listen mode", () => {
      expect(augmentQuery("evidencias karaoke", "listen-dance")).toBe("evidencias karaoke");
    });
  });

  describe("empty / whitespace query", () => {
    it("returns empty for an empty query in sing mode (no bare 'karaoke')", () => {
      expect(augmentQuery("", "sing")).toBe("");
    });

    it("returns empty for a whitespace-only query in sing mode", () => {
      expect(augmentQuery("   ", "sing")).toBe("");
    });

    it("returns empty for an empty query in listen mode", () => {
      expect(augmentQuery("", "listen-dance")).toBe("");
    });
  });

  describe("mode switch (same raw query, different mode)", () => {
    it("yields distinct augmented queries per mode", () => {
      const raw = "roberto carlos";
      expect(augmentQuery(raw, "sing")).toBe("roberto carlos karaoke");
      expect(augmentQuery(raw, "listen-dance")).toBe("roberto carlos");
    });
  });
});

describe("containsKaraoke", () => {
  it("matches the whole word case-insensitively", () => {
    expect(containsKaraoke("karaoke")).toBe(true);
    expect(containsKaraoke("KARAOKE night")).toBe(true);
    expect(containsKaraoke("best Karaoke tracks")).toBe(true);
  });

  it("does not match substrings or the accented Portuguese spelling", () => {
    expect(containsKaraoke("karaokestar")).toBe(false);
    expect(containsKaraoke("karaokê")).toBe(false);
    expect(containsKaraoke("evidencias")).toBe(false);
  });
});
