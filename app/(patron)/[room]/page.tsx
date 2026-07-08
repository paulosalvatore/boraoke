import Link from "next/link";
import {
  getPublicRoom,
  DEFAULT_ROOM,
  isValidRoomId,
  isEphemeralRoomStore,
  deriveRoomName,
} from "@/lib/rooms";
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
    // Malformed URL — no valid slug to recreate from.
    return <RoomNotFound ephemeral={isEphemeralRoomStore()} />;
  }

  const record = await getPublicRoom(room);
  if (!record && room !== DEFAULT_ROOM) {
    // Valid URL shape but no room record. On the memory driver in prod this is
    // very likely the "created on another lambda" case (TICKET-20 root cause) —
    // so we surface the honest notice AND a one-click recreate path.
    return <RoomNotFound roomId={room} ephemeral={isEphemeralRoomStore()} />;
  }

  const venueName = record?.name ?? "cantai";
  return <PatronRoom roomId={room} venueName={venueName} />;
}

/**
 * Not-found / gone screen (TICKET-20). When `roomId` is a valid slug it offers a
 * "recriar sala com este nome" path (prefills /new with the de-slugified name);
 * when `ephemeral` it also states the honest reason (prod on the memory driver,
 * rooms are temporary until Upstash lands).
 */
function RoomNotFound({
  roomId,
  ephemeral,
}: {
  roomId?: string;
  ephemeral: boolean;
}) {
  const suggestedName = roomId ? deriveRoomName(roomId) : "";
  return (
    <main style={{ maxWidth: 480, margin: "0 auto", padding: "3rem 1rem", textAlign: "center" }}>
      <h1 style={{ fontSize: "2rem", marginBottom: "0.5rem" }}>🎤 cantai</h1>
      <p style={{ color: "var(--text-muted)", marginBottom: "1.25rem" }}>
        Essa sala não existe (ou o link está errado).
      </p>

      {ephemeral && (
        <p
          data-testid="ephemeral-notice"
          style={{
            background: "#f59e0b12",
            border: "1px solid #f59e0b55",
            borderRadius: "var(--radius)",
            padding: "0.85rem 1rem",
            fontSize: "0.85rem",
            lineHeight: 1.5,
            color: "#fbbf24",
            marginBottom: "1.25rem",
            textAlign: "left",
          }}
        >
          ⚠️ As salas ainda são <strong>temporárias</strong> e podem expirar
          quando o servidor reinicia. Recurso de salas permanentes está a
          caminho.
        </p>
      )}

      {roomId && suggestedName && (
        <Link
          className="btn-primary"
          data-testid="recreate-room"
          href={`/new?name=${encodeURIComponent(suggestedName)}`}
          style={{ display: "inline-block", marginBottom: "0.85rem" }}
        >
          Recriar sala “{suggestedName}”
        </Link>
      )}

      <p>
        <Link href="/" style={{ color: "var(--accent)", fontSize: "0.9rem" }}>
          Voltar ao início
        </Link>
      </p>
    </main>
  );
}
