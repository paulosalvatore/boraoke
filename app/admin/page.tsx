import { redirect } from "next/navigation";

/**
 * Legacy /admin → /default/admin (TICKET-9).
 *
 * The pre-multi-room prototype had a single global admin over the `default`
 * room (env `HOST_TOKEN`). Host controls now live at /[room]/admin, so this
 * path permanently redirects to the default room's admin — no dead links.
 */
export default function LegacyAdminRedirect() {
  redirect("/default/admin");
}
