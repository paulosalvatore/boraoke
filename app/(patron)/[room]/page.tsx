import Link from "next/link";
import { getPublicRoom, DEFAULT_ROOM, isValidRoomId } from "@/lib/rooms";
import PatronRoom from "./PatronRoom";

export const dynamic = "force-dynamic";

/**
 * /[room] — patron join → pick → queue for a specific venue (TICKET-9).
 *
 * Server component: validates the room id, resolves the venue display name
 * (for the top-bar chip), then hands off to the client PatronRoom. The legacy
 * `default` room has no record — it renders with a generic name so the
 * pre-multi-room prototype queue keeps working under `/default`.
 */
export default async function RoomPage({
  params,
}: {
  params: Promise<{ room: string }>;
}) {
  const { room } = await params;

  if (!isValidRoomId(room)) {
    return <RoomNotFound />;
  }

  const record = await getPublicRoom(room);
  if (!record && room !== DEFAULT_ROOM) {
    return <RoomNotFound />;
  }

  const venueName = record?.name ?? "cantai";
  return <PatronRoom roomId={room} venueName={venueName} />;
}

function RoomNotFound() {
  return (
    <main style={{ maxWidth: 480, margin: "0 auto", padding: "3rem 1rem", textAlign: "center" }}>
      <h1 style={{ fontSize: "2rem", marginBottom: "0.5rem" }}>🎤 cantai</h1>
      <p style={{ color: "var(--text-muted)", marginBottom: "1.5rem" }}>
        Essa sala não existe (ou o link está errado).
      </p>
      <Link className="btn-primary" href="/" style={{ display: "inline-block" }}>
        Voltar ao início
      </Link>
    </main>
  );
}
