import { redirect } from "next/navigation";
import { isValidRoomId, DEFAULT_ROOM } from "@/lib/rooms";

/**
 * Legacy /tv → /[room]/tv (TICKET-9).
 *
 * The venue screen is now room-scoped. `/tv?room=<id>` redirects to that room's
 * screen; a bare `/tv` (or a malformed room param) falls back to the `default`
 * room so the pre-multi-room prototype screen keeps working. No dead links.
 */
export default async function LegacyTvRedirect({
  searchParams,
}: {
  searchParams: Promise<{ room?: string }>;
}) {
  const { room } = await searchParams;
  const target = room && isValidRoomId(room) ? room : DEFAULT_ROOM;
  redirect(`/${target}/tv`);
}
