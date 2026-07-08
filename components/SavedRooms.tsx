"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  loadRooms,
  forgetRoom,
  roomsToProbe,
  type RememberedRoom,
} from "@/lib/room-memory";

/**
 * "Suas salas" — the device-level room-recovery section on the landing page
 * (TICKET-43). Lists every room this browser CREATED or JOINED, most-recent
 * first, with role-appropriate quick links and a ✕ to forget one.
 *
 * Host-session recovery (created rooms): we probe `GET /api/host/session?room=`
 * for the top MAX_HOST_PROBES most-recent created rooms only (BLOCKING-1, PR #22
 * review — an unbounded loop could fan out up to 50 parallel fetches per landing
 * load). If the ~12h host cookie is still valid the admin link goes STRAIGHT
 * into the dashboard; if the probe said expired it routes to the admin login,
 * which shows the honest "sua sessão expirou — entre com o código da sala" copy.
 * Unprobed / in-flight rooms link to the plain admin page, whose own
 * checkSession() self-routes (NIT-1).
 * We NEVER store or auto-fill the host code — recovery still needs the code (or
 * a live cookie). See lib/room-memory.ts security invariant.
 *
 * Honest limits: this memory is per-browser/device and clearing site data loses
 * it (until accounts land — work/planning/accounts-and-identity.md). The
 * "salvas neste dispositivo" note says so plainly.
 */
export default function SavedRooms() {
  const [rooms, setRooms] = useState<RememberedRoom[] | null>(null);
  // roomId → whether the host cookie is currently valid (undefined = probing).
  const [hostValid, setHostValid] = useState<Record<string, boolean>>({});

  useEffect(() => {
    setRooms(loadRooms());
  }, []);

  // Probe the host session for the top-N most-recent created rooms only
  // (bounded fan-out — BLOCKING-1) to route their admin links.
  useEffect(() => {
    if (!rooms) return;
    let cancelled = false;
    for (const room of roomsToProbe(rooms)) {
      fetch(`/api/host/session?room=${encodeURIComponent(room.id)}`)
        .then((res) => res.ok)
        .catch(() => false)
        .then((ok) => {
          if (!cancelled) setHostValid((prev) => ({ ...prev, [room.id]: ok }));
        });
    }
    return () => {
      cancelled = true;
    };
  }, [rooms]);

  const forget = useCallback((id: string) => {
    setRooms(forgetRoom(id));
  }, []);

  // Render nothing until loaded, and nothing when there are no remembered rooms
  // (keeps the landing clean for first-time visitors).
  if (!rooms || rooms.length === 0) return null;

  return (
    <section
      data-testid="saved-rooms"
      style={{
        background: "var(--surface)",
        borderRadius: "var(--radius)",
        padding: "1.25rem",
        marginBottom: "1.5rem",
      }}
    >
      <h2 style={{ fontSize: "1.05rem", marginBottom: "0.25rem" }}>Suas salas</h2>
      <p
        style={{
          fontSize: "0.8rem",
          color: "var(--text-muted)",
          marginBottom: "0.9rem",
        }}
      >
        Salvas neste dispositivo — volte rápido pra uma sala que você criou ou entrou.
      </p>

      <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: "0.6rem" }}>
        {rooms.map((room) => {
          // Created rooms: only a probe that POSITIVELY said "expired" routes to
          // the gate with the expired copy; in-flight/unprobed rooms get the
          // plain admin link — AdminRoom's own checkSession() self-routes, so a
          // fast click never sees a misleading "expirou" (NIT-1).
          const adminHref =
            hostValid[room.id] === false
              ? `/${room.id}/admin?expired=1`
              : `/${room.id}/admin`;
          return (
            <li
              key={room.id}
              data-testid="saved-room"
              data-room-id={room.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "0.5rem",
                background: "var(--bg)",
                borderRadius: "var(--radius)",
                padding: "0.6rem 0.75rem",
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    fontWeight: 600,
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {room.name}
                </div>
                <div
                  style={{
                    display: "flex",
                    gap: "0.75rem",
                    marginTop: "0.35rem",
                    fontSize: "0.85rem",
                    flexWrap: "wrap",
                  }}
                >
                  <Link
                    href={`/${room.id}`}
                    style={{ color: "var(--accent)" }}
                    data-testid="saved-room-patron"
                  >
                    Entrar
                  </Link>
                  {room.role === "created" && (
                    <>
                      <Link
                        href={adminHref}
                        style={{ color: "var(--accent)" }}
                        data-testid="saved-room-admin"
                      >
                        Admin
                      </Link>
                      <Link
                        href={`/${room.id}/tv`}
                        style={{ color: "var(--accent)" }}
                        data-testid="saved-room-tv"
                      >
                        TV
                      </Link>
                    </>
                  )}
                </div>
              </div>
              <button
                type="button"
                onClick={() => forget(room.id)}
                aria-label={`Esquecer ${room.name}`}
                data-testid="saved-room-forget"
                style={{
                  background: "transparent",
                  border: "none",
                  color: "var(--text-muted)",
                  cursor: "pointer",
                  fontSize: "1.1rem",
                  lineHeight: 1,
                  padding: "0.25rem 0.4rem",
                  width: "auto",
                }}
              >
                ✕
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
