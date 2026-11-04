/**
 * Two implementations of the `Kv` interface the room-delete engine uses: an
 * in-memory fake (always on, so CI exercises the engine) and a real-Redis adapter
 * over a raw RESP socket (opt-in via REDIS_TEST_URL, like the other
 * *.integration tests).
 */
import net from "node:net";
import type { Kv, KvType } from "@/lib/room-delete";

type Entry = { type: KvType; value: unknown; expiresAt: number | null };

const globToRe = (g: string) =>
  new RegExp("^" + g.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");

export class MemoryKv implements Kv {
  data = new Map<string, Entry>();
  private live(k: string): Entry | undefined {
    const e = this.data.get(k);
    if (e && e.expiresAt !== null && e.expiresAt <= Date.now()) {
      this.data.delete(k);
      return undefined;
    }
    return e;
  }
  private put(k: string, type: KvType, value: unknown) {
    this.data.set(k, { type, value, expiresAt: this.data.get(k)?.expiresAt ?? null });
  }
  async scan(match: string) {
    const re = globToRe(match);
    return [...this.data.keys()].filter((k) => this.live(k) && re.test(k));
  }
  async type(k: string) {
    return this.live(k)?.type ?? "none";
  }
  async pttl(k: string) {
    const e = this.live(k);
    if (!e) return -2;
    return e.expiresAt === null ? -1 : e.expiresAt - Date.now();
  }
  async get(k: string) {
    const e = this.live(k);
    return e?.type === "string" ? (e.value as string) : null;
  }
  async lrange(k: string) {
    return [...((this.live(k)?.value as string[]) ?? [])];
  }
  async smembers(k: string) {
    return [...((this.live(k)?.value as Set<string>) ?? [])];
  }
  async zrange(k: string) {
    return [...((this.live(k)?.value as Map<string, number>) ?? new Map()).entries()].sort((a, b) => a[1] - b[1]);
  }
  async hgetall(k: string) {
    return { ...((this.live(k)?.value as Record<string, string>) ?? {}) };
  }
  async del(...ks: string[]) {
    ks.forEach((k) => this.data.delete(k));
  }
  async srem(k: string, m: string) {
    const s = this.live(k)?.value as Set<string> | undefined;
    s?.delete(m);
    if (s && s.size === 0) this.data.delete(k);
  }
  async set(k: string, v: string) {
    this.put(k, "string", v);
  }
  async rpush(k: string, ...vs: string[]) {
    this.put(k, "list", [...((this.live(k)?.value as string[]) ?? []), ...vs]);
  }
  async sadd(k: string, ...ms: string[]) {
    this.put(k, "set", new Set([...((this.live(k)?.value as Set<string>) ?? []), ...ms]));
  }
  async zadd(k: string, es: Array<[string, number]>) {
    this.put(k, "zset", new Map([...((this.live(k)?.value as Map<string, number>) ?? new Map()), ...es]));
  }
  async hset(k: string, rec: Record<string, string>) {
    this.put(k, "hash", { ...((this.live(k)?.value as object) ?? {}), ...rec });
  }
  async pexpire(k: string, ms: number) {
    const e = this.live(k);
    if (e) e.expiresAt = Date.now() + ms;
  }
}

/** Minimal RESP2 client with array support. */
export class RespClient {
  private socket!: net.Socket;
  private buf = Buffer.alloc(0);
  private waiting: Array<{ resolve: (v: unknown) => void; reject: (e: Error) => void }> = [];

  connect(url: string): Promise<void> {
    const u = new URL(url);
    return new Promise((resolve, reject) => {
      this.socket = net.createConnection({ host: u.hostname, port: Number(u.port || 6379) }, () => resolve());
      this.socket.on("error", reject);
      this.socket.on("data", (chunk: Buffer) => {
        this.buf = Buffer.concat([this.buf, chunk]);
        for (;;) {
          const parsed = this.parse(0);
          if (!parsed) return;
          this.buf = this.buf.subarray(parsed.next);
          const w = this.waiting.shift();
          if (parsed.value instanceof Error) w?.reject(parsed.value);
          else w?.resolve(parsed.value);
        }
      });
    });
  }

  private parse(at: number): { value: unknown; next: number } | null {
    const nl = this.buf.indexOf("\r\n", at);
    if (nl < 0) return null;
    const kind = String.fromCharCode(this.buf[at]);
    const rest = this.buf.toString("utf8", at + 1, nl);
    const after = nl + 2;
    if (kind === "+") return { value: rest, next: after };
    if (kind === "-") return { value: new Error(rest), next: after };
    if (kind === ":") return { value: Number(rest), next: after };
    if (kind === "$") {
      const len = Number(rest);
      if (len === -1) return { value: null, next: after };
      if (this.buf.length < after + len + 2) return null;
      return { value: this.buf.toString("utf8", after, after + len), next: after + len + 2 };
    }
    if (kind === "*") {
      const n = Number(rest);
      const items: unknown[] = [];
      let pos = after;
      for (let i = 0; i < n; i++) {
        const item = this.parse(pos);
        if (!item) return null;
        items.push(item.value);
        pos = item.next;
      }
      return { value: items, next: pos };
    }
    throw new Error(`unexpected RESP type ${kind}`);
  }

  cmd(...args: (string | number)[]): Promise<unknown> {
    const payload = `*${args.length}\r\n` + args.map((a) => `$${Buffer.byteLength(String(a))}\r\n${a}\r\n`).join("");
    return new Promise((resolve, reject) => {
      this.waiting.push({ resolve, reject });
      this.socket.write(payload);
    });
  }

  end() {
    this.socket?.destroy();
  }
}

export class RedisKv implements Kv {
  constructor(readonly r: RespClient) {}
  async scan(match: string) {
    const out: string[] = [];
    let cursor = "0";
    do {
      const [next, batch] = (await this.r.cmd("SCAN", cursor, "MATCH", match, "COUNT", 500)) as [string, string[]];
      out.push(...batch);
      cursor = next;
    } while (cursor !== "0");
    return [...new Set(out)];
  }
  async type(k: string) {
    return (await this.r.cmd("TYPE", k)) as KvType | "none";
  }
  async pttl(k: string) {
    return (await this.r.cmd("PTTL", k)) as number;
  }
  async get(k: string) {
    return (await this.r.cmd("GET", k)) as string | null;
  }
  async lrange(k: string) {
    return (await this.r.cmd("LRANGE", k, 0, -1)) as string[];
  }
  async smembers(k: string) {
    return (await this.r.cmd("SMEMBERS", k)) as string[];
  }
  async zrange(k: string) {
    const flat = (await this.r.cmd("ZRANGE", k, 0, -1, "WITHSCORES")) as string[];
    const out: Array<[string, number]> = [];
    for (let i = 0; i < flat.length; i += 2) out.push([flat[i], Number(flat[i + 1])]);
    return out;
  }
  async hgetall(k: string) {
    const flat = (await this.r.cmd("HGETALL", k)) as string[];
    const out: Record<string, string> = {};
    for (let i = 0; i < flat.length; i += 2) out[flat[i]] = flat[i + 1];
    return out;
  }
  async del(...ks: string[]) {
    await this.r.cmd("DEL", ...ks);
  }
  async srem(k: string, m: string) {
    await this.r.cmd("SREM", k, m);
  }
  async set(k: string, v: string) {
    await this.r.cmd("SET", k, v);
  }
  async rpush(k: string, ...vs: string[]) {
    await this.r.cmd("RPUSH", k, ...vs);
  }
  async sadd(k: string, ...ms: string[]) {
    await this.r.cmd("SADD", k, ...ms);
  }
  async zadd(k: string, es: Array<[string, number]>) {
    await this.r.cmd("ZADD", k, ...es.flatMap(([m, s]) => [s, m]));
  }
  async hset(k: string, rec: Record<string, string>) {
    await this.r.cmd("HSET", k, ...Object.entries(rec).flat());
  }
  async pexpire(k: string, ms: number) {
    await this.r.cmd("PEXPIRE", k, ms);
  }
}
