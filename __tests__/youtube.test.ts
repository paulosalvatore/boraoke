import { parseYouTubeVideoId } from "@/lib/youtube";

describe("parseYouTubeVideoId", () => {
  const VALID_ID = "dQw4w9WgXcQ";

  describe("raw video IDs", () => {
    it("accepts a valid 11-char raw video ID", () => {
      expect(parseYouTubeVideoId(VALID_ID)).toBe(VALID_ID);
    });

    it("rejects IDs shorter than 11 chars", () => {
      expect(parseYouTubeVideoId("short")).toBeNull();
    });

    it("rejects IDs longer than 11 chars", () => {
      expect(parseYouTubeVideoId("dQw4w9WgXcQQ")).toBeNull();
    });
  });

  describe("watch URLs", () => {
    it("parses standard watch URL", () => {
      expect(parseYouTubeVideoId(`https://www.youtube.com/watch?v=${VALID_ID}`)).toBe(VALID_ID);
    });

    it("parses watch URL without www", () => {
      expect(parseYouTubeVideoId(`https://youtube.com/watch?v=${VALID_ID}`)).toBe(VALID_ID);
    });

    it("parses watch URL with extra query params", () => {
      expect(parseYouTubeVideoId(`https://www.youtube.com/watch?v=${VALID_ID}&t=42s&list=PL123`)).toBe(VALID_ID);
    });
  });

  describe("youtu.be short URLs", () => {
    it("parses youtu.be short URL", () => {
      expect(parseYouTubeVideoId(`https://youtu.be/${VALID_ID}`)).toBe(VALID_ID);
    });

    it("parses youtu.be URL with query params", () => {
      expect(parseYouTubeVideoId(`https://youtu.be/${VALID_ID}?t=30`)).toBe(VALID_ID);
    });
  });

  describe("embed / shorts / live URLs", () => {
    it("parses embed URL", () => {
      expect(parseYouTubeVideoId(`https://www.youtube.com/embed/${VALID_ID}`)).toBe(VALID_ID);
    });

    it("parses shorts URL", () => {
      expect(parseYouTubeVideoId(`https://www.youtube.com/shorts/${VALID_ID}`)).toBe(VALID_ID);
    });

    it("parses live URL", () => {
      expect(parseYouTubeVideoId(`https://www.youtube.com/live/${VALID_ID}`)).toBe(VALID_ID);
    });
  });

  describe("mobile URLs", () => {
    it("parses m.youtube.com watch URL", () => {
      expect(parseYouTubeVideoId(`https://m.youtube.com/watch?v=${VALID_ID}`)).toBe(VALID_ID);
    });
  });

  describe("invalid inputs", () => {
    it("returns null for empty string", () => {
      expect(parseYouTubeVideoId("")).toBeNull();
    });

    it("returns null for a random string", () => {
      expect(parseYouTubeVideoId("not a url at all!!!")).toBeNull();
    });

    it("returns null for a non-YouTube URL", () => {
      expect(parseYouTubeVideoId("https://vimeo.com/123456789")).toBeNull();
    });

    it("returns null for a watch URL with missing v param", () => {
      expect(parseYouTubeVideoId("https://www.youtube.com/watch?list=PL123")).toBeNull();
    });
  });
});
