import { NextResponse } from "next/server";
import { advanceQueue } from "@/lib/store";

export function POST() {
  const next = advanceQueue();
  return NextResponse.json({
    nowPlaying: next,
    message: next ? "Advanced to next entry" : "Queue is now empty",
  });
}
