import { NextIntlClientProvider } from "next-intl";
import TvScreen from "@/components/tv/TvScreen";
import { resolvePoweredByFooter } from "@/components/tv/config";
import { getPublicRoom, getRoomLanguage } from "@/lib/rooms";
import { mintScreenToken } from "@/lib/screen-token";
import { loadMessages } from "@/i18n/request";
import { documentLangScript } from "@/i18n/locales";

/**
 * /[room]/tv — venue screen for a specific room (TICKET-9, moved from /tv).
 *
 * Thin server component: resolves the POWERED_BY_FOOTER flag at REQUEST time
 * (force-dynamic) and the venue name, then hands off to the client TvScreen
 * which owns playback, polling, fullscreen, wake lock — now room-scoped, with a
 * real QR of this room's join URL. Note: force-dynamic means no CODE deploy is
 * needed to pick up the flag, but on Vercel changing the env var's value still
 * requires a redeploy to take effect — it is not read live off Vercel's config.
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
      {/*
        TICKET-75 — `<html lang>` / content agreement.

        The root layout sets `<html lang>` from the REQUEST locale (the
        NEXT_LOCALE cookie / Accept-Language), but this subtree deliberately
        renders ROOM-locale messages. A visitor whose cookie is `es` opening a
        pt-BR room's TV therefore got `lang="es"` on 100% Portuguese content —
        wrong for screen readers, browser auto-translate and SEO.

        The root layout is a different, app-wide surface (and is owned elsewhere),
        so this route corrects the attribute for itself. The script is emitted
        inline in the SSR body and runs during HTML parse — before first paint
        and long before any assistive tech or auto-translate heuristic reads the
        document — so the live DOM the user actually gets always agrees with the
        rendered copy. `locale` is a value from the fixed LOCALES enum resolved
        server-side, never user input, and is JSON-encoded on the way out.
      */}
      <script dangerouslySetInnerHTML={{ __html: documentLangScript(locale) }} />
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
