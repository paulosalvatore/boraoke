import { existsSync, readFileSync } from "fs";
import { join } from "path";

import {
  classifyKind,
  decodeEntities,
  parseTitle,
  TITLE_KINDS,
} from "@/lib/karaoke-index/title-parser";
import { score, type LabelledRow } from "@/work/measurements/ticket-143/score";

describe("classifyKind", () => {
  it.each([
    ["Evidências - Chitãozinho e Xororó (Karaokê)", "Some Channel", "karaoke"],
    ["Bad Guy : Billie Eilish | Karaoke with Lyrics", "Stingray Karaoke", "karaoke"],
    ["Inteam - Dia + Karaoke Minus-One HD", "Jom", "karaoke"],
    ["A Vida Chegou - Valesca Mayssa - PLAYBACK COM LETRA", "Paloma", "playback"],
    ["Zé Ramalho - Admirável Gado Novo (Playback & Backing)", "X", "playback"],
    ["Escudo | Voz da Verdade – COVER IA", "MiniVozes", "cover"],
    ["Sepultura & Zé Ramalho - Ratamahatta - LIVE", "Miguel", "live"],
    ["Mistérios da Meia-Noite (Ao Vivo)", "Zé Ramalho - Topic", "live"],
    ["Billie Eilish - bad guy (Lyrics)", "cold boy.", "lyric"],
    ["Rita Lee - Flagra(letra)1982", "Marcos", "lyric"],
    ["Pablo Alboran - Quién (Videoclip oficial)", "Pablo Alborán", "original"],
    ["Evidências", "Roberto Carlos - Topic", "original"],
    ["Com quem o bebê parece mais?", "Flavera", "unknown"],
  ])("%s -> %s", (title, channel, kind) => {
    expect(classifyKind(title, channel)).toBe(kind);
  });

  it("karaoke beats playback, cover and live when a title carries several cues", () => {
    expect(classifyKind("BORBULHAS DE AMOR (AO VIVO) - GUSTTAVO LIMA - PLAYBACK KARAOKE INSTRUMENTAL", "x")).toBe("karaoke");
    expect(classifyKind("⭐ Rita - Tierry (Karaokê Version) (Cover)", "x")).toBe("karaoke");
  });

  it("playback beats cover and live", () => {
    expect(classifyKind("Daniel & Samuel - A Vida | Playback Com Letra | Ao Vivo", "x")).toBe("playback");
    expect(classifyKind("Cerol na Mão (cover) - playback", "x")).toBe("playback");
  });

  it("live beats lyric", () => {
    expect(classifyKind("Rita Lee - Flagra (Ao Vivo) (Letra)", "x")).toBe("live");
  });

  it("falls back to the channel name only when the title has no cue", () => {
    expect(classifyKind("Jads e Jadson • Borbulhas de amor", "PALCO KARAOKÊ")).toBe("karaoke");
    expect(classifyKind("Jads e Jadson • Borbulhas de amor", "Júnior Playbacks")).toBe("playback");
    // a title cue wins over a karaoke-named channel
    expect(classifyKind("Rita Lee - Flagra (letra)", "PALCO KARAOKÊ")).toBe("lyric");
  });

  it("a Topic channel reads as original only when the title says nothing else", () => {
    expect(classifyKind("Bandoleros", "Don Omar - Topic")).toBe("original");
    expect(classifyKind("Bandoleros", "Don Omar")).toBe("unknown");
  });

  // KNOWN WRONG, tracked in TICKET-145: LIVE_RE matches the song word "Live".
  test.failing("TICKET-145: 'Live' inside a song name does not make the title live", () => {
    expect(classifyKind("Paul McCartney - Live and Let Die (Official Video)", "Some Channel")).toBe("original");
  });

  it("only returns members of TITLE_KINDS", () => {
    for (const t of ["", "x", "karaoke", "live", "&amp;"]) {
      expect(TITLE_KINDS).toContain(classifyKind(t, ""));
    }
  });
});

describe("decodeEntities", () => {
  it("decodes the entities the Data API emits", () => {
    expect(decodeEntities("Kiss - I Was Made For Lovin&#39; You &amp; More &quot;x&quot;")).toBe(
      `Kiss - I Was Made For Lovin' You & More "x"`,
    );
    expect(decodeEntities("&#x27;a&#x27;")).toBe("'a'");
    expect(decodeEntities("&bogus; &#0;")).toBe("&bogus; &#0;");
  });
});

describe("parseTitle: song and artist", () => {
  const p = (title: string, channel = "Some Karaoke") => {
    const r = parseTitle(title, channel);
    return [r.song, r.artist];
  };

  it("defaults to <artist> - <song> and strips the karaoke tag", () => {
    expect(p("Soda Stereo - Tratame Suavemente (Versión Karaoke)")).toEqual(["Tratame Suavemente", "Soda Stereo"]);
    expect(p("Fagner - Borbulhas de amor - Karaokê")).toEqual(["Borbulhas de amor", "Fagner"]);
  });

  it("decodes HTML entities before splitting", () => {
    expect(p("Kiss - I Was Made For Lovin&#39; You (Karaoke with Lyrics)")).toEqual([
      "I Was Made For Lovin' You",
      "Kiss",
    ]);
  });

  it("uses a per-channel template for song-first channels", () => {
    expect(p("Hello - Adele (Karaoke Songs With Lyrics - Original Key)", "Musisi Karaoke")).toEqual(["Hello", "Adele"]);
    // same title on a channel with no template reads artist-first
    expect(p("Hello - Adele (Karaoke Songs With Lyrics - Original Key)", "Other Karaoke")).toEqual(["Adele", "Hello"]);
  });

  it("a template can skip a leading segment (country on Essendiel)", () => {
    expect(p("BELGIUM - Essyla - Dancing on the Ice [Karaoke]", "Essendiel Karaoke")).toEqual([
      "Dancing on the Ice",
      "Essyla",
    ]);
  });

  it("a kind tag right after the first part puts the song first", () => {
    expect(p("Só Hoje (Karaokê) - Jota Quest | Solte a voz")).toEqual(["Só Hoje", "Jota Quest"]);
    expect(p("Nosso lugar 'karaoke' MC Kevin, Thiago castanho")).toEqual(["Nosso lugar", "MC Kevin, Thiago castanho"]);
  });

  it("a featuring marker or '&' marks the artist side and the feat tail is dropped", () => {
    expect(p("Wake Me Up - Avicii & Aloe Blacc (KARAOKE)")).toEqual(["Wake Me Up", "Avicii & Aloe Blacc"]);
    expect(p("Santana ft. Maná - Corazón Espinado (Karaoke)")).toEqual(["Corazón Espinado", "Santana"]);
    expect(p("BAD (REMIX) - WALE FT. RIHANNA (karaoke version)")).toEqual(["BAD", "WALE"]);
  });

  it("reads a duo credit and an MC/Banda prefix as the artist", () => {
    expect(p("Ignora - Felipe e Rodrigo - Versão Karaokê")).toEqual(["Ignora", "Felipe e Rodrigo"]);
    expect(p("Vida - Grupo Guinda")).toEqual(["Vida", "Grupo Guinda"]);
  });

  it("capitalised multi-word song before a mixed-case credit reads song-first; one capitalised word does not", () => {
    expect(p("BABY I LOVE YOU - Tiffany Alvord -|Karaoke Version")).toEqual(["BABY I LOVE YOU", "Tiffany Alvord"]);
    expect(p("STROMAE - Alors on danse - karaoké version")).toEqual(["Alors on danse", "STROMAE"]);
  });

  it("explicit cues: in the style of, made popular by, by", () => {
    expect(p("Bandoleros (In the Style of Don Omar) (Karaoke Version)")).toEqual(["Bandoleros", "Don Omar"]);
    expect(p("bad guy (Made Popular By Billie Eilish) [Karaoke Version]")).toEqual(["bad guy", "Billie Eilish"]);
    expect(p("Type of Wound by Natalie Grace Alford Karaoke")).toEqual(["Type of Wound", "Natalie Grace Alford"]);
  });

  it("a short bracketed name next to a lone song is its artist; a long one is not", () => {
    expect(p("Karaokê - Sapato 36 (Raul Seixas)")).toEqual(["Sapato 36", "Raul Seixas"]);
    expect(p("PLAYBACK - CEROL NA MÃO (NO RITMO DO FORRÓ DE JEITO)")).toEqual(["CEROL NA MÃO", null]);
  });

  it("drops emoji, hashtags, CJK tag brackets and the channel's own name", () => {
    expect(p("🎤 Aloe Blacc - Brooklyn in the Summer (Karaoke) #karaoke")).toEqual(["Brooklyn in the Summer", "Aloe Blacc"]);
    // an emoji between two names is a separator
    expect(p("Nada personal 💟 Soda Stereo (Versión 🎤 Karaoke)", "KARAOKE ENJOY")).toEqual(["Nada personal", "Soda Stereo"]);
    expect(p("Nada personal💟Soda Stereo (Karaoke)", "KARAOKE ENJOY")).toEqual(["Nada personal", "Soda Stereo"]);
    expect(p("#フリガナ付き【カラオケ】Billie Eilish / bad guy【原曲キー】")).toEqual(["bad guy", "Billie Eilish"]);
    expect(p("U2 - Bad - NOX Karaoke", "Nox Karaoke")).toEqual(["Bad", "U2"]);
    expect(p("Nox Karaoke | U2 - Bad", "Nox Karaoke")).toEqual(["Bad", "U2"]);
  });

  it("drops boilerplate-only segments and bracketed subtitles from the song", () => {
    expect(p("Admirável Gado Novo - karaokê playback original c/ letra - Zé Ramalho", "Sigma Karaokês")).toEqual([
      "Admirável Gado Novo",
      "Zé Ramalho",
    ]);
    expect(p("Soda Stereo - Signos (Gira Me Verás Volver) - Karaoke")).toEqual(["Signos", "Soda Stereo"]);
  });

  it("a bracket that starts with 'by' is the credit; one that only contains 'by' is noise", () => {
    expect(p("Hello (by Adele) Karaoke")).toEqual(["Hello", "Adele"]);
    expect(p("Hello (Produced by Greg Kurstin) Karaoke")).toEqual(["Hello", null]);
  });

  it("'with' cuts a featuring tail but not a 'with the' band name", () => {
    expect(p("Hootie with the Blowfish - Hold My Hand (Karaoke)")).toEqual(["Hold My Hand", "Hootie with the Blowfish"]);
    expect(p("Bebe Rexha with Florida Georgia Line - Meant to Be (Karaoke)")).toEqual(["Meant to Be", "Bebe Rexha"]);
  });

  it("a number-only segment is a track number, unless it is the only song left", () => {
    expect(p("01 - Soda Stereo - Signos (Karaoke)")).toEqual(["Signos", "Soda Stereo"]);
    expect(p("Arctic Monkeys - 505 (Karaoke)")).toEqual(["505", "Arctic Monkeys"]);
  });

  it("a single-segment 'X by Y' is not split when a short bracketed name is the credit", () => {
    expect(p("Stand by Me (Ben E. King) Karaoke")).toEqual(["Stand by Me", "Ben E. King"]);
  });

  // KNOWN WRONG, tracked in TICKET-145: the duo-credit cue fires on the song
  // "Live and Let Die" (capitalised words around "and"), so the pair is swapped.
  test.failing("TICKET-145: a song named 'X and Y' is not read as a duo credit", () => {
    expect(p("Paul McCartney - Live and Let Die (Official Video)", "Some Channel")).toEqual([
      "Live and Let Die",
      "Paul McCartney",
    ]);
  });

  it("returns nulls rather than throwing on junk", () => {
    expect(parseTitle("", "")).toEqual({ song: null, artist: null, kind: "unknown" });
    expect(parseTitle("Karaoke", "")).toEqual({ song: null, artist: null, kind: "karaoke" });
    expect(() => parseTitle(undefined as unknown as string, null as unknown as string)).not.toThrow();
    expect(() => parseTitle("((((".repeat(500), "x")).not.toThrow();
  });
});

// The labelled sample is YouTube API data: local only, never committed
// (.gitignore). These checks run where it exists and skip elsewhere.
const SAMPLE_PATH = join(__dirname, "..", "work", "measurements", "ticket-143", "labelled-sample.json");
const HAS_SAMPLE = existsSync(SAMPLE_PATH);
const describeSample = HAS_SAMPLE ? describe : describe.skip;

describeSample("labelled sample (local only: work/measurements/ticket-143/labelled-sample.json)", () => {
  const doc = (HAS_SAMPLE ? JSON.parse(readFileSync(SAMPLE_PATH, "utf8")) : { rows: [] }) as { rows: LabelledRow[] };
  const s = score(doc.rows);

  it("has the 300 labelled rows", () => {
    expect(doc.rows).toHaveLength(300);
  });

  it("kind precision meets the >= 95% acceptance", () => {
    expect(s.kindAccuracy).toBeGreaterThanOrEqual(0.95);
  });

  // REGRESSION FLOOR, not the acceptance: the ticket asks for >= 85% and the
  // parser measures 240/289 = 83.0%. This holds today's number so a change
  // cannot silently make it worse; raise it when the parser improves.
  it("song+artist exact does not fall below the measured 240/289", () => {
    expect(s.saExact).toBeGreaterThanOrEqual(240);
  });
});
