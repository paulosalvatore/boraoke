/**
 * Telemetry emit helper (TICKET-12).
 *
 * `track(...)` is the ONE line other routes add (shared-file protocol,
 * TICKET-19): fire-and-forget, FAIL-OPEN by contract — a telemetry outage must
 * never block or slow a queue/playback action. The returned promise always
 * resolves; storage errors are swallowed and counted, never thrown. Callers
 * should not even await it (`void track(...)` / bare `track(...)`).
 *
 * The server fills `ts` and `appVersion` itself — call sites and beacon
 * clients are never trusted for either. Props go through `sanitizeProps`
 * (small scalar bag; free text impossible).
 *
 * Kill switch: set TELEMETRY_DISABLED=1 to no-op every emit (read at call
 * time — no rebuild needed).
 */

import "server-only";

import { telemetryStore, type TelemetryStore } from "./telemetry-store";
import {
  MAX_ROOM_ID,
  MAX_SESSION_KEY,
  sanitizeProps,
  type TelemetryEvent,
  type TelemetryEventName,
} from "./telemetry-types";

export { TELEMETRY_EVENTS } from "./telemetry-types";

/** Same resolution chain as `/api/feedback` — Vercel injects the commit SHA. */
export function appVersion(): string {
  return (
    process.env.GIT_SHA ||
    process.env.VERCEL_GIT_COMMIT_SHA ||
    process.env.NEXT_PUBLIC_GIT_SHA ||
    "dev"
  );
}

export interface TrackInput {
  roomId: string;
  sessionKey?: string;
  uuid?: string;
  props?: Record<string, unknown>;
  /** Test/override hook — production call sites never pass this. */
  now?: Date;
}

export interface Tracker {
  /** Fire-and-forget emit. NEVER rejects. Resolves true when stored. */
  track(event: TelemetryEventName, input: TrackInput): Promise<boolean>;
  /** Events swallowed by the fail-open path since process start. */
  droppedCount(): number;
}

function telemetryDisabled(): boolean {
  const v = process.env.TELEMETRY_DISABLED;
  return v === "1" || v?.toLowerCase() === "true";
}

/**
 * Build a tracker over an explicit store (tests inject a failing/fake store
 * to prove fail-open). Production uses the `track` singleton below.
 */
export function createTracker(store: TelemetryStore): Tracker {
  let dropped = 0;

  async function track(
    event: TelemetryEventName,
    input: TrackInput,
  ): Promise<boolean> {
    try {
      if (telemetryDisabled()) return false;
      const record: TelemetryEvent = {
        event,
        roomId: String(input.roomId ?? "").slice(0, MAX_ROOM_ID) || "unknown",
        ...(input.sessionKey
          ? { sessionKey: String(input.sessionKey).slice(0, MAX_SESSION_KEY) }
          : {}),
        ...(input.uuid ? { uuid: String(input.uuid).slice(0, 36) } : {}),
        ts: (input.now ?? new Date()).toISOString(),
        appVersion: appVersion(),
      };
      const props = sanitizeProps(input.props);
      if (props) record.props = props;
      await store.append(record);
      return true;
    } catch {
      // FAIL-OPEN: swallow everything (sync or async) — count and move on.
      dropped += 1;
      return false;
    }
  }

  return { track, droppedCount: () => dropped };
}

const defaultTracker = createTracker(telemetryStore);

/** The process-wide emit function — the one-liner other routes call. */
export const track = defaultTracker.track;

/** Fail-open drop counter (observability/tests). */
export const trackDroppedCount = defaultTracker.droppedCount;
