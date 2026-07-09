/**
 * next-intl request config (TICKET-30) — WITHOUT i18n routing.
 *
 * Resolves the active locale from the `NEXT_LOCALE` cookie, falling back to the
 * `Accept-Language` header on first visit, then pt-BR. No `[locale]` URL segment
 * exists (rooms stay `/<room>`), so the locale is never in the path.
 *
 * Room-default-language override: a room page that wants to honor its venue's
 * default language (when the visitor has NO explicit cookie) wraps its subtree
 * in its own `NextIntlClientProvider` with the room locale + messages. The TV
 * surface does exactly this (it always follows the room, never a user cookie).
 * This request config handles the app-wide default; the per-room override is a
 * deliberate, scoped layer on top.
 */

import { cookies, headers } from "next/headers";
import { getRequestConfig } from "next-intl/server";
import { LOCALE_COOKIE, resolveLocale, type Locale } from "./locales";

/** Load a locale's message catalog. Kept in one place for reuse by overrides. */
export async function loadMessages(locale: Locale) {
  return (await import(`../messages/${locale}.json`)).default;
}

export default getRequestConfig(async () => {
  const cookieStore = await cookies();
  const headerStore = await headers();

  const locale = resolveLocale({
    cookie: cookieStore.get(LOCALE_COOKIE)?.value,
    acceptLanguage: headerStore.get("accept-language"),
  });

  return {
    locale,
    messages: await loadMessages(locale),
  };
});
