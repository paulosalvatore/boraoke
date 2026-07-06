import TvScreen from "@/components/tv/TvScreen";
import { resolvePoweredByFooter } from "@/components/tv/config";

/**
 * /tv — venue screen (TICKET-18).
 *
 * Thin server component: resolves the POWERED_BY_FOOTER flag from the
 * environment at REQUEST time (force-dynamic) so the footer can be disabled
 * without a rebuild (monetization spec AC4), then hands off to the client
 * TvScreen which owns playback, polling, fullscreen and wake lock.
 */
export const dynamic = "force-dynamic";

export const metadata = {
  title: "cantai — tv",
};

export default function TvPage() {
  return (
    <TvScreen
      poweredByFooter={resolvePoweredByFooter(process.env.POWERED_BY_FOOTER)}
    />
  );
}
