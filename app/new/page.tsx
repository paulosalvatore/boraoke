"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import QrCode from "@/components/QrCode";
import { rememberCreatedRoom } from "@/lib/room-memory";

interface Created {
  id: string;
  name: string;
  hostCode: string;
  joinPath: string;
  /** TICKET-20: prod-on-memory-driver → rooms are ephemeral. */
  ephemeral?: boolean;
}

/**
 * /new — create a venue room (TICKET-9).
 *
 * Venue name in → POST /api/rooms → shows the join URL, a real QR of it, and
 * the host code EXACTLY ONCE (it is never retrievable again; possession = venue
 * identity until accounts arrive in #14). Links straight to the room's admin
 * and TV screens.
 *
 * TICKET-20: accepts `?name=<venue>` to prefill the create form — the room-404
 * page's "recriar sala com este nome" path lands here prefilled.
 */
export default function NewRoomPage() {
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const [room, setRoom] = useState<Created | null>(null);

  // Prefill from `?name=` (recreate path). Read from location to avoid the
  // useSearchParams Suspense-boundary requirement in a client page.
  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      const preset = params.get("name");
      if (preset) setName(preset.slice(0, 60));
    } catch { /* no-op */ }
  }, []);

  const joinUrl =
    room && typeof window !== "undefined"
      ? `${window.location.origin}${room.joinPath}`
      : "";

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (!name.trim()) return;
    setCreating(true);
    try {
      const res = await fetch("/api/rooms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? "Não deu para criar a sala. Tente de novo.");
        return;
      }
      const created = data as Created;
      setRoom(created);
      // TICKET-43: remember this device created the room (id + name only — NEVER
      // the host code, which stays shown-once). Powers the landing "Suas salas"
      // recovery section so a host who loses the tab can find their room again.
      rememberCreatedRoom({ id: created.id, name: created.name });
    } catch {
      setError("Erro de rede — tente de novo.");
    } finally {
      setCreating(false);
    }
  }

  if (room) {
    return (
      <main style={{ maxWidth: 480, margin: "0 auto", padding: "2.5rem 1rem" }}>
        <h1 style={{ fontSize: "1.75rem", marginBottom: "0.25rem" }}>🎤 Sala criada!</h1>
        <p style={{ color: "var(--text-muted)", marginBottom: "2rem" }}>
          <strong style={{ color: "var(--text)" }}>{room.name}</strong> está no ar.
        </p>

        {/* Join URL + QR */}
        <section style={{ background: "var(--surface)", borderRadius: "var(--radius)", padding: "1.25rem", marginBottom: "1.25rem", textAlign: "center" }}>
          <span style={{ fontSize: "0.75rem", textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--text-muted)" }}>
            Entrada do público
          </span>
          <div style={{ display: "flex", justifyContent: "center", margin: "1rem 0" }}>
            <QrCode value={joinUrl} size={220} title={`QR de ${room.name}`} />
          </div>
          <p data-testid="join-url" style={{ fontWeight: 700, color: "#fbbf24", wordBreak: "break-all" }}>
            {joinUrl || `…/${room.id}`}
          </p>
          <p style={{ fontSize: "0.8rem", color: "var(--text-muted)", marginTop: "0.5rem" }}>
            Mostre esse QR no bar ou deixe na tela /tv.
          </p>
        </section>

        {/* TICKET-20: honest temporary-room notice when prod is on the memory
            driver (Upstash unprovisioned). The real fix is Upstash; until then
            we tell the truth instead of letting the link 404 silently. */}
        {room.ephemeral && (
          <section
            data-testid="ephemeral-notice"
            style={{ background: "#f59e0b12", border: "1px solid #f59e0b55", borderRadius: "var(--radius)", padding: "1rem 1.25rem", marginBottom: "1.25rem" }}
          >
            <p style={{ fontSize: "0.85rem", lineHeight: 1.5, color: "#fbbf24" }}>
              ⚠️ As salas ainda são <strong>temporárias</strong> — elas podem
              expirar quando o servidor reinicia. Use a sala agora e recrie se o
              link parar de funcionar. Salas permanentes estão a caminho.
            </p>
          </section>
        )}

        {/* Host code — shown once */}
        <section style={{ background: "#f59e0b12", border: "1px solid #f59e0b55", borderRadius: "var(--radius)", padding: "1.25rem", marginBottom: "1.25rem" }}>
          <span style={{ fontSize: "0.75rem", textTransform: "uppercase", letterSpacing: "0.06em", color: "#fbbf24" }}>
            Código do host (anote agora!)
          </span>
          <p data-testid="host-code" style={{ fontSize: "1.6rem", fontWeight: 800, letterSpacing: "0.15em", margin: "0.5rem 0", fontFamily: "monospace" }}>
            {room.hostCode}
          </p>
          <p style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>
            É com ele que você controla a fila em /admin. Ele aparece{" "}
            <strong>uma única vez</strong> — guarde num lugar seguro.
          </p>
        </section>

        <div style={{ display: "flex", gap: "0.75rem" }}>
          <Link className="btn-primary" href={`/${room.id}/admin`} style={{ flex: 1, textAlign: "center" }}>
            Abrir admin
          </Link>
          <Link className="btn-primary" href={`/${room.id}/tv`} style={{ flex: 1, textAlign: "center" }}>
            Abrir /tv
          </Link>
        </div>
        <p style={{ textAlign: "center", marginTop: "1.25rem" }}>
          <Link href={`/${room.id}`} style={{ color: "var(--accent)", fontSize: "0.9rem" }}>
            Ver a sala do público →
          </Link>
        </p>
      </main>
    );
  }

  return (
    <main style={{ maxWidth: 480, margin: "0 auto", padding: "3rem 1rem" }}>
      <h1 style={{ fontSize: "2rem", marginBottom: "0.25rem" }}>🎤 Criar sala</h1>
      <p style={{ color: "var(--text-muted)", marginBottom: "2rem" }}>
        Dê o nome do seu bar. A gente gera o link, o QR e o código do host.
      </p>
      <form onSubmit={create} style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
        <div>
          <label htmlFor="venue-name" style={{ display: "block", marginBottom: "0.5rem", fontWeight: 600 }}>
            Nome do bar
          </label>
          <input
            id="venue-name"
            aria-label="Nome do bar"
            autoFocus
            placeholder="ex.: Bar do Zé"
            maxLength={60}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        {error && <p style={{ color: "var(--accent)", fontSize: "0.875rem" }}>{error}</p>}
        <button className="btn-primary" type="submit" disabled={creating || !name.trim()}>
          {creating ? "Criando…" : "Criar sala"}
        </button>
      </form>
      <p style={{ textAlign: "center", marginTop: "2rem" }}>
        <Link href="/" style={{ color: "var(--text-muted)", fontSize: "0.85rem" }}>
          ← Voltar
        </Link>
      </p>
    </main>
  );
}
