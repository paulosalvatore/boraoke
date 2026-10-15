/**
 * A shared, in-memory stand-in for the Upstash REST client, for TICKET-126's
 * cross-instance single-flight probe.
 *
 * It models what the probe depends on:
 *   - ONE keyspace shared by every simulated instance (Upstash is one server);
 *   - every command is asynchronous with a random (seeded) delay, so concurrent
 *     callers genuinely interleave between commands;
 *   - each script runs to completion without interleaving (Redis executes one
 *     script at a time), modelled as a serialized promise chain;
 *   - `SET NX PX`, `GET`, `MGET`, `EVAL` of the three scripts the search path
 *     uses, with PX expiry.
 * The scripts are re-implemented in JS here; the SHIPPED Lua text is executed
 * against a real Redis by search-principal-lua.integration.test.ts.
 */

type Val = unknown;

export interface FakeUpstash {
  store: Map<string, { v: Val; exp: number | null }>;
  ops: string[];
  get(key: string): Promise<Val | null>;
  mget<T extends unknown[]>(...keys: string[]): Promise<T>;
  set(key: string, v: Val, opts?: { nx?: boolean; px?: number }): Promise<"OK" | null>;
  eval(script: string, keys: string[], args: (string | number)[]): Promise<unknown>;
  del(...keys: string[]): Promise<number>;
}

/** Small deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function makeFakeUpstash(seed = 126, maxJitterMs = 4): FakeUpstash {
  const store = new Map<string, { v: Val; exp: number | null }>();
  const ops: string[] = [];
  const rand = rng(seed);
  const jitter = () => new Promise<void>((r) => setTimeout(r, Math.floor(rand() * maxJitterMs)));
  let scriptTail: Promise<unknown> = Promise.resolve();

  const live = (k: string) => {
    const e = store.get(k);
    if (!e) return undefined;
    if (e.exp !== null && e.exp <= Date.now()) {
      store.delete(k);
      return undefined;
    }
    return e;
  };
  const num = (k: string) => Number(live(k)?.v ?? 0);
  const incr = (k: string, ttl: number) => {
    const n = num(k) + 1;
    const e = live(k);
    store.set(k, { v: n, exp: e ? e.exp : Date.now() + ttl });
    return n;
  };

  function runScript(script: string, keys: string[], args: (string | number)[]): unknown {
    if (script.includes("devCap")) {
      const [budget, ipCap, devCap, ttl] = args.map(Number);
      if (num(keys[0]) >= budget) return -1;
      if (num(keys[1]) >= ipCap) return -2;
      if (num(keys[2]) >= devCap) return -3;
      const c = incr(keys[0], ttl);
      incr(keys[1], ttl);
      incr(keys[2], ttl);
      return budget - c;
    }
    if (script.includes("redis.call('DEL'")) {
      if (live(keys[0])?.v === args[0]) {
        store.delete(keys[0]);
        return 1;
      }
      return 0;
    }
    // RESERVE_SEARCH_SCRIPT (platform only)
    const [budget, ttl] = args.map(Number);
    if (num(keys[0]) >= budget) return -1;
    return budget - incr(keys[0], ttl);
  }

  return {
    store,
    ops,
    async get(key) {
      await jitter();
      ops.push(`GET ${key}`);
      return live(key)?.v ?? null;
    },
    async mget<T extends unknown[]>(...keys: string[]) {
      await jitter();
      ops.push(`MGET ${keys.join(" ")}`);
      return keys.map((k) => live(k)?.v ?? null) as T;
    },
    async set(key, v, opts = {}) {
      await jitter();
      ops.push(`SET ${key}${opts.nx ? " NX" : ""}`);
      if (opts.nx && live(key)) return null;
      store.set(key, { v, exp: opts.px ? Date.now() + opts.px : null });
      return "OK";
    },
    async eval(script, keys, args) {
      await jitter();
      ops.push(`EVAL ${keys.join(" ")}`);
      const next = scriptTail.then(() => runScript(script, keys, args));
      scriptTail = next.catch(() => undefined);
      return next;
    },
    async del(...keys) {
      await jitter();
      let n = 0;
      for (const k of keys) if (store.delete(k)) n++;
      return n;
    },
  };
}
