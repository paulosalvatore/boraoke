import { getPublicRoom, getRoomLanguage } from "@/lib/rooms";
import AdminRoom from "./AdminRoom";

/**
 * /[room]/admin — host controls for a specific room (TICKET-9, moved from
 * /admin). Server component resolves the venue name; the client AdminRoom owns
 * the login gate + dashboard, room-scoped (`?room=<id>` on every host call).
 */
export const dynamic = "force-dynamic";

export default async function RoomAdminPage({
  params,
}: {
  params: Promise<{ room: string }>;
}) {
  const { room } = await params;
  const record = await getPublicRoom(room);
  // TICKET-30: seed the room-language selector with the persisted value.
  const initialLanguage = await getRoomLanguage(room);
  return (
    <AdminRoom
      roomId={room}
      venueName={record?.name}
      initialLanguage={initialLanguage}
    />
  );
}
