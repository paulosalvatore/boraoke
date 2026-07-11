import { NextIntlClientProvider } from "next-intl";
import TvScreen from "@/components/tv/TvScreen";
import { resolvePoweredByFooter } from "@/components/tv/config";
import { getPublicRoom, getRoomLanguage } from "@/lib/rooms";
import { mintScreenToken } from "@/lib/screen-token";
import { loadMessages } from "@/i18n/request";

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
  // i18n (TICKET-30): the TV is a VENUE device — it always follows the room's
  // default language (pt-BR when unset), NEVER a per-user cookie. Scoped
  // provider overrides the app-wide request-locale for this subtree.
  const locale = await getRoomLanguage(room);
  // Advance-auth (TICKET-45): mint the room's stateless screen token here, on
  // the server, from its server-only secret. TvScreen sends it as the
  // X-Boraoke-Screen header on advance so the route can authorize the skip.
  // `null` for a no-key room (enforcement off) — the TV then sends no header.
  //
  // TICKET-46: capture the mint time (ms epoch) right next to the mint call and
  // pass it to TvScreen so the client can compute token age and self-heal
  // (proactive idle reload) before the ≤48h token expires under enforce. This is
  // NOT secret/signing material — just a timestamp — so it is safe on the client.
  const screenTokenMintedAt = Date.now();
  const screenToken = await mintScreenToken(room, screenTokenMintedAt);
  return (
    <NextIntlClientProvider locale={locale} messages={await loadMessages(locale)}>
      <TvScreen
        poweredByFooter={resolvePoweredByFooter(process.env.POWERED_BY_FOOTER)}
        roomId={room}
        venueName={record?.name}
        screenToken={screenToken}
        screenTokenMintedAt={screenTokenMintedAt}
      />
    </NextIntlClientProvider>
  );
}
