/**
 * REAL-REDIS execution of `RESERVE_SEARCH_SCRIPT` (TICKET-87, review finding F-3).
 *
 * WHY THIS FILE EXISTS: every other test in this ticket drives a FAKE whose
 * `eval` is a JavaScript reimplementation of the script. That harness faithfully
 * models Redis's *scheduling* (one script at a time, to completion), which is
 * what makes the concurrency and negative-control tests meaningful — but it
 * never interprets the Lua, so a syntax error, an inverted comparison, a dropped
 * PEXPIRE or an off-by-one in the SHIPPED script would leave the whole suite
 * green. The review measured exactly that gap.
 *
 * This suite closes it by running the real script against a real Redis. It is
 * OPT-IN because CI has no Redis: set `REDIS_TEST_URL` to a `redis://` server
 * (e.g. `docker run --rm -p 6399:6379 redis:7-alpine`, then
 * `REDIS_TEST_URL=redis://127.0.0.1:6399 npx jest search-budget-lua`) and it
 * runs; leave it unset and it skips with a single explanatory test.
 *
 * `ioredis` is not a dependency of this project, so the client is the RESP
 * protocol spoken directly over a TCP socket — a few dozen lines, no new
 * dependency, and enough to issue EVAL/GET/PTTL/DEL.
 */
import net from "node:net";
import { RESERVE_SEARCH_SCRIPT, SEARCH_DAILY_BUDGET } from "@/lib/search-budget";

const REDIS_URL = process.env.REDIS_TEST_URL;

/** Minimal RESP client: send a command, resolve its single reply. */
class Resp {
  private socket!: net.Socket;
  private buf = "";
  private queue: Array<(v: unknown) => void> = [];
  private errs: Array<(e: Error) => void> = [];

  connect(url: string): Promise<void> {
    const u = new URL(url);
    return new Promise((resolve, reject) => {
      this.socket = net.createConnection(
        { host: u.hostname, port: Number(u.port || 6379) },
        () => resolve(),
      );
      this.socket.on("error", reject);
      this.socket.setEncoding("utf8");
      this.socket.on("data", (chunk: string) => {
        this.buf += chunk;
        this.drain();
      });
    });
  }

  private drain(): void {
    // Only the reply shapes this test needs: +simple, -error, :integer, $bulk.
    for (;;) {
      const nl = this.buf.indexOf("\r\n");
      if (nl < 0) return;
      const line = this.buf.slice(0, nl);
      const kind = line[0];
      const rest = line.slice(1);

      if (kind === "$") {
        const len = Number(rest);
        if (len === -1) {
          this.buf = this.buf.slice(nl + 2);
          this.queue.shift()?.(null);
          this.errs.shift();
          continue;
        }
        const start = nl + 2;
        if (this.buf.length < start + len + 2) return; // body incomplete
        const body = this.buf.slice(start, start + len);
        this.buf = this.buf.slice(start + len + 2);
        this.queue.shift()?.(body);
        this.errs.shift();
        continue;
      }

      this.buf = this.buf.slice(nl + 2);
      if (kind === "-") {
        this.queue.shift();
        this.errs.shift()?.(new Error(rest));
      } else if (kind === ":") {
        this.queue.shift()?.(Number(rest));
        this.errs.shift();
      } else {
        this.queue.shift()?.(rest);
        this.errs.shift();
      }
    }
  }

  cmd(...args: (string | number)[]): Promise<unknown> {
    const payload =
      `*${args.length}\r\n` +
      args
        .map((a) => {
          const s = String(a);
          return `$${Buffer.byteLength(s)}\r\n${s}\r\n`;
        })
        .join("");
    return new Promise((resolve, reject) => {
      this.queue.push(resolve);
      this.errs.push(reject);
      this.socket.write(payload);
    });
  }

  end(): void {
    this.socket?.destroy();
  }
}

const maybe = REDIS_URL ? describe : describe.skip;

if (!REDIS_URL) {
  it("SKIPPED: set REDIS_TEST_URL to execute the real Lua against a real Redis", () => {
    // Deliberately a passing, self-documenting placeholder rather than a silent
    // absence — the point of F-3 is that a missing proof should be VISIBLE.
    expect(RESERVE_SEARCH_SCRIPT).toContain("INCR");
  });
}

maybe("RESERVE_SEARCH_SCRIPT executed by a real Redis", () => {
  let r: Resp;
  const KEY = "sb:test:integration";

  beforeAll(async () => {
    r = new Resp();
    await r.connect(REDIS_URL!);
  });
  afterAll(() => r?.end());
  beforeEach(async () => {
    await r.cmd("DEL", KEY);
  });

  const reserve = (budget: number, ttl = 1000) =>
    r.cmd("EVAL", RESERVE_SEARCH_SCRIPT, 1, KEY, budget, ttl);

  it("counts down to 0 then returns the -1 sentinel, which never collides", async () => {
    expect(await reserve(3)).toBe(2);
    expect(await reserve(3)).toBe(1);
    expect(await reserve(3)).toBe(0); // last legitimate grant: remaining 0
    expect(await reserve(3)).toBe(-1); // denied
    expect(await reserve(3)).toBe(-1);
    expect(Number(await r.cmd("GET", KEY))).toBe(3); // never over-incremented
  });

  it("sets the TTL on CREATE only (the day key must not have its life extended)", async () => {
    await reserve(5, 120_000);
    const first = Number(await r.cmd("PTTL", KEY));
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThanOrEqual(120_000);
    // A second reservation must not re-arm the TTL.
    await reserve(5, 999_000);
    const second = Number(await r.cmd("PTTL", KEY));
    expect(second).toBeLessThanOrEqual(first);
  });

  it("treats a missing key as zero used", async () => {
    expect(await r.cmd("GET", KEY)).toBeNull();
    expect(await reserve(SEARCH_DAILY_BUDGET)).toBe(SEARCH_DAILY_BUDGET - 1);
  });

  it("FAILS CLOSED (errors) rather than granting when the key holds garbage", async () => {
    await r.cmd("SET", KEY, "notanumber");
    // Redis's INCR refuses; the EVAL errors, and the module's catch denies.
    await expect(reserve(5)).rejects.toThrow(/not an integer|ERR/i);
  });

  it("grants exactly `budget` times under 300 pipelined concurrent evals", async () => {
    const replies = await Promise.all(
      Array.from({ length: SEARCH_DAILY_BUDGET * 3 }, () =>
        reserve(SEARCH_DAILY_BUDGET),
      ),
    );
    const granted = replies.filter((v) => Number(v) >= 0);
    expect(granted).toHaveLength(SEARCH_DAILY_BUDGET);
    // Every grant got a DISTINCT slot — impossible under read-modify-write.
    expect(new Set(granted.map(Number)).size).toBe(SEARCH_DAILY_BUDGET);
    expect(Number(await r.cmd("GET", KEY))).toBe(SEARCH_DAILY_BUDGET);
  });
});
