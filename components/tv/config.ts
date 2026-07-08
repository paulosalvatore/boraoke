/**
 * TV-surface config resolution (TICKET-18).
 *
 * POWERED_BY_FOOTER — monetization spec AC4: the free tier shows a
 * "powered by Boraoke" + join/QR footer on /tv. Default ON; only an explicit
 * opt-out value disables it. Read server-side at request time (app/tv/page.tsx
 * is force-dynamic) so the future pro plan can flip it WITHOUT a rebuild.
 */

const OFF_VALUES = new Set(["0", "false", "off", "no"]);

/** Resolve the powered-by-Boraoke footer flag from a raw env value. Default: on. */
export function resolvePoweredByFooter(raw: string | undefined | null): boolean {
  if (raw == null) return true;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "") return true;
  return !OFF_VALUES.has(normalized);
}
