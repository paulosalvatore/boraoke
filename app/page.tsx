"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import SavedRooms from "@/components/SavedRooms";

/**
 * Landing (TICKET-9) — replaces the old global patron flow (which moved to
 * /[room]). Explains Boraoke, offers "create your room" (→ /new), and a
 * join-by-code input that sends a patron to /<code>. Prefills the last room
 * joined from localStorage for quick re-entry.
 */
export default function Landing() {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [lastRoom, setLastRoom] = useState("");

  useEffect(() => {
    try {
      // NOTE: storage key intentionally kept as `cantai_last_room` — it is live
      // state on users' devices (see TICKET-33 storage-key decision). Renaming
      // it would drop every returning patron's last-room quick-entry.
      const last = window.localStorage.getItem("cantai_last_room");
      if (last) setLastRoom(last);
    } catch { /* sandboxed */ }
  }, []);

  function normalize(v: string): string {
    // Accept a raw code, or a pasted join URL — take the last path segment.
    const trimmed = v.trim();
    const fromUrl = trimmed.replace(/^https?:\/\/[^/]+\//i, "").split(/[/?#]/)[0];
    return (fromUrl || trimmed).toLowerCase();
  }

  function join(e: React.FormEvent) {
    e.preventDefault();
    const room = normalize(code);
    if (!room) return;
    router.push(`/${encodeURIComponent(room)}`);
  }

  return (
    <main style={{ maxWidth: 480, margin: "0 auto", padding: "3rem 1rem", display: "flex", flexDirection: "column", minHeight: "80vh" }}>
      <h1 style={{ fontSize: "2.5rem", marginBottom: "0.5rem" }}>🎤 Boraoke</h1>
      <p style={{ color: "var(--text-muted)", fontSize: "1.05rem", lineHeight: 1.5, marginBottom: "2rem" }}>
        A fila de karaokê do seu bar, no celular de cada cliente. Crie a sala,
        mostre o QR, e todo mundo entra na fila com a mesa marcada.
      </p>

      <Link
        className="btn-primary"
        href="/new"
        style={{ display: "block", textAlign: "center", marginBottom: "2.5rem" }}
      >
        Criar a sala do seu bar
      </Link>

      {/* TICKET-43: device-level remembered rooms (renders nothing when empty). */}
      <SavedRooms />

      <section style={{ background: "var(--surface)", borderRadius: "var(--radius)", padding: "1.25rem" }}>
        <h2 style={{ fontSize: "1.05rem", marginBottom: "0.25rem" }}>Já tem um código?</h2>
        <p style={{ fontSize: "0.85rem", color: "var(--text-muted)", marginBottom: "0.75rem" }}>
          Digite o código da sala (ou cole o link que você recebeu).
        </p>
        <form onSubmit={join} style={{ display: "flex", gap: "0.5rem" }}>
          <input
            aria-label="Código da sala"
            placeholder="ex.: bar-do-ze"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            // TICKET-20: the input's default fill is var(--surface) — the SAME
            // as this card — so it was camouflaged (looked like there was no
            // field until you clicked it). Force a darker fill + clearer border
            // so it visibly reads as an input.
            style={{ flex: 1, background: "var(--bg)", borderColor: "var(--text-muted)" }}
          />
          <button className="btn-primary" type="submit" disabled={!code.trim()} style={{ minWidth: 90, width: "auto" }}>
            Entrar
          </button>
        </form>
        {lastRoom && (
          <p style={{ marginTop: "0.75rem", fontSize: "0.85rem", color: "var(--text-muted)" }}>
            Última sala:{" "}
            <Link href={`/${lastRoom}`} style={{ color: "var(--accent)" }} data-testid="last-room-link">
              {lastRoom}
            </Link>
          </p>
        )}
      </section>

      <footer style={{ marginTop: "auto", paddingTop: "2rem", color: "var(--text-muted)", fontSize: "0.75rem", textAlign: "center" }}>
        <span>Boraoke — early access · uma sala por bar, filas isoladas</span>
      </footer>
    </main>
  );
}
