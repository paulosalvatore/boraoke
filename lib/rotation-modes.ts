/**
 * Venue rotation modes — the client-safe shared vocabulary (TICKET-10).
 *
 * This module carries NO server-only imports and NO engine import, so it is
 * safe to pull into client components (the admin ModeSwitcher, patron/TV hints)
 * AND server code (the rotation adapter, room persistence). It is the canonical
 * naming boundary (spec A6): `RoomMode` reuses the engine's `VenueMode` string
 * values verbatim, so the venue mode needs zero translation between the app,
 * the store, and `@boraoke/rotation-engine`.
 */

/**
 * The venue's rotation policy, persisted in the room record. Values are exactly
 * the engine's `VenueMode` union (A6: one canonical name, no cross-codebase
 * rename).
 */
export type RoomMode = "full-karaoke" | "per-table-2" | "per-person-1";

/** The default mode for a new room (spec: full karaoke). */
export const DEFAULT_ROOM_MODE: RoomMode = "full-karaoke";

/**
 * Normalize any stored/legacy settings value to a valid {@link RoomMode}.
 * Pre-TICKET-10 rooms persisted `mode: "full"` (and the placeholder entry-mode
 * values) — those, and anything unrecognized, map to `full-karaoke`. This is
 * how the ticket's "no room re-migration" guarantee is honored: old records read
 * back as the default without any write.
 */
export function normalizeRoomMode(value: unknown): RoomMode {
  return value === "per-table-2" || value === "per-person-1"
    ? value
    : "full-karaoke";
}

/** Submit-time caps per mode (spec: quota + one round of lookahead). */
export const PER_TABLE_CAP = 4;
export const PER_PERSON_CAP = 2;
/** Anti-spam cap on pending listen/dance entries per uuid (spec §sing vs listen). */
export const LISTEN_CAP_PER_UUID = 3;

/**
 * Mode-switcher card metadata. `name` + `rule` copy is VERBATIM from the design
 * mockup (`work/design/mockups/admin.html` / design-handoff §5) — it doubles as
 * the bar owner's rotation-rule documentation, so it must not be paraphrased.
 * Order matches the mockup (karaoke, table, person).
 */
export const MODE_META: readonly {
  mode: RoomMode;
  name: string;
  rule: string;
}[] = [
  {
    mode: "full-karaoke",
    name: "🎤 Karaokê completo",
    rule: "Todo mundo entra na fila, ordem de chegada.",
  },
  {
    mode: "per-table-2",
    name: "🍻 2 por mesa",
    rule: "No máximo 2 músicas na fila por mesa; a mesa volta quando tocar.",
  },
  {
    mode: "per-person-1",
    name: "🙋 1 por pessoa",
    rule: "Cada pessoa mantém 1 música na fila; rodízio justo por identidade.",
  },
];

/** Short pt-BR label for a mode (toasts / hints). */
export function modeLabel(mode: RoomMode): string {
  return MODE_META.find((m) => m.mode === mode)?.name ?? "🎤 Karaokê completo";
}
