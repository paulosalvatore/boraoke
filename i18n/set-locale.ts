"use server";

/**
 * Server action to set the UI locale (TICKET-30). Called by the language
 * switcher. Writes the `NEXT_LOCALE` cookie (validated against the supported
 * set — an out-of-range value is ignored, never persisted). No redirect / no
 * URL change: the cookie drives `i18n/request.ts` on the next render, so the
 * client just refreshes the current route.
 */

import { cookies } from "next/headers";
import {
  isLocale,
  LOCALE_COOKIE,
  LOCALE_COOKIE_MAX_AGE,
  type Locale,
} from "./locales";

export async function setLocale(locale: Locale): Promise<void> {
  if (!isLocale(locale)) return;
  const cookieStore = await cookies();
  cookieStore.set(LOCALE_COOKIE, locale, {
    path: "/",
    maxAge: LOCALE_COOKIE_MAX_AGE,
    sameSite: "lax",
  });
}
