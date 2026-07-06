"use client";

import { usePathname } from "next/navigation";
import type { FeedbackSubmission, Role } from "@/lib/feedback-types";

/**
 * Reads the zero-effort auto-context from the client (localStorage + route).
 * The server augments this with appVersion / userAgent / createdAt — it never
 * trusts the client for those.
 *
 * localStorage keys are the ones the patron page already writes (TICKET-1):
 *   cantai_patron_uuid, cantai_nickname.
 */

const LS_UUID = "cantai_patron_uuid";
const LS_NICK = "cantai_nickname";
const LS_MODE = "cantai_mode";
const LS_ROOM = "cantai_room";

function safeLocalStorage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

/** Ensure a device uuid exists (mirrors the patron page's boot logic). */
function readOrCreateUuid(ls: Storage | null): string | undefined {
  if (!ls) return undefined;
  let id = ls.getItem(LS_UUID) ?? undefined;
  if (!id) {
    // Only mint one in a secure context that offers randomUUID; otherwise leave
    // it undefined and let the patron page own creation on its next boot.
    if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
      id = crypto.randomUUID();
      ls.setItem(LS_UUID, id);
    }
  }
  return id;
}

export function roleForPath(pathname: string | null): Role {
  return pathname?.startsWith("/host") ? "host" : "patron";
}

export function useFeedbackContext(): {
  /** Build the submission context at send time (reads fresh localStorage). */
  buildContext: () => FeedbackSubmission["context"] | null;
} {
  const pathname = usePathname();

  const buildContext = (): FeedbackSubmission["context"] | null => {
    const ls = safeLocalStorage();
    const uuid = readOrCreateUuid(ls);
    if (!uuid) return null; // can't attribute or rate-limit without a uuid

    return {
      uuid,
      nickname: ls?.getItem(LS_NICK) ?? undefined,
      roomId: ls?.getItem(LS_ROOM) ?? undefined,
      route: pathname ?? "/",
      mode: ls?.getItem(LS_MODE) ?? undefined,
      role: roleForPath(pathname),
      locale:
        typeof navigator !== "undefined" ? navigator.language : undefined,
    };
  };

  return { buildContext };
}
