/**
 * Minimal RESP client for the opt-in real-Redis Lua suites (see
 * search-budget-lua.integration.test.ts for why it exists). Lifted verbatim
 * from that file so TICKET-126's suites can share it.
 */
import net from "node:net";

/** Minimal RESP client: send a command, resolve its single reply. */
export class Resp {
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
