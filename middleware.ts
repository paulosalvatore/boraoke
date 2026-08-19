import { NextResponse, type NextRequest } from "next/server";
import { PATHNAME_HEADER } from "@/i18n/route-locale";

/**
 * Pathname-forwarding middleware (TICKET-79).
 *
 * The ONLY thing this does is copy the request's pathname into a request header
 * (`x-boraoke-pathname`) so server components — specifically `i18n/request.ts`,
 * which feeds the `<html lang>` in the single root layout — can tell WHICH route
 * is being rendered. Next.js deliberately exposes no pathname to a layout, and
 * the root layout renders before its children, so this is the only way to serve
 * a route-correct `lang` in the HTML itself instead of patching it client-side.
 *
 * DELIBERATELY NOT an i18n routing middleware. `i18n/locales.ts` records the
 * standing decision that rooms stay `/<room>` with the locale in the
 * `NEXT_LOCALE` cookie — no `[locale]` segment, no locale rewrite, no redirect.
 * This middleware never rewrites, redirects, reads cookies or touches the
 * response body; it forwards the request unchanged plus one header.
 *
 * The header is steering metadata, never authorization: every value derived
 * from it is normalized against the fixed LOCALES enum before use, and an
 * absent or hostile value degrades to the pre-TICKET-79 app-wide locale.
 */
export function middleware(request: NextRequest) {
  const headers = new Headers(request.headers);
  headers.set(PATHNAME_HEADER, request.nextUrl.pathname);
  return NextResponse.next({ request: { headers } });
}

export const config = {
  /**
   * Document routes only. API routes, Next's build output, and static assets do
   * not render `<html>`, so they carry none of this cost.
   */
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|.*\\.[\\w]+$).*)"],
};
