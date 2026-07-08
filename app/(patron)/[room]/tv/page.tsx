import TvScreen from "@/components/tv/TvScreen";
import { resolvePoweredByFooter } from "@/components/tv/config";
import { getPublicRoom } from "@/lib/rooms";

/**
 * /[room]/tv — venue screen for a specific room (TICKET-9, moved from /tv).
 *
 * Thin server component: resolves the POWERED_BY_FOOTER flag at REQUEST time
 * (force-dynamic) and the venue name, then hands off to the client TvScreen
 * which owns playback, polling, fullscreen, wake lock — now room-scoped, with a
 * real QR of this room's join URL.
 */
export const dynamic = "force-dynamic";

export const metadata = {
  title: "TV",
};

export default async function RoomTvPage({
  params,
}: {
  params: Promise<{ room: string }>;
}) {
  const { room } = await params;
  const record = await getPublicRoom(room);
  return (
    <TvScreen
      poweredByFooter={resolvePoweredByFooter(process.env.POWERED_BY_FOOTER)}
      roomId={room}
      venueName={record?.name}
    />
  );
}
