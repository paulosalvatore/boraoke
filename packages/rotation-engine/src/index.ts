/**
 * cantai rotation / fairness queue engine — public entry point.
 *
 * A pure, immutable, dependency-free TypeScript library implementing cantai's
 * venue rotation modes. See README.md for the fairness rules in plain language.
 */

export {
  createQueue,
  addEntry,
  removeEntry,
  moveEntryToTable,
  setVenueMode,
  getEffectiveOrder,
  peekUpcoming,
  advance,
  skip,
} from "./engine.ts";

export type {
  EntryMode,
  VenueMode,
  EntryInput,
  Entry,
  HistoryOutcome,
  HistoryRecord,
  QueueOptions,
  QueueState,
  RejectReason,
  AddResult,
  AdvanceResult,
  SkipResult,
} from "./types.ts";
