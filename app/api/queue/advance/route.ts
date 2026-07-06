import { NextResponse } from "next/server";
import { store, DEFAULT_ROOM } from "@/lib/store";

export async function POST() {
  const next = await store.advance(DEFAULT_ROOM);
  return NextResponse.json({
    nowPlaying: next,
    message: next ? "Advanced to next entry" : "Queue is now empty",
  });
}
