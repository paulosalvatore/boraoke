/**
 * lib/client-ip.ts — which header is trusted for the client IP (TICKET-119).
 *
 * The property under test is NOT "a header is read"; it is "a client cannot
 * choose its own bucket". The off-Vercel rotation test is the regression test:
 * under the previous derivation (x-real-ip, then XFF, trusted everywhere) a
 * rotating forged header produced one bucket per request, which is how the
 * host-code throttle was reset in the TICKET-104 re-gate.
 */
import { clientIpFrom, normaliseIpBucket, UNKNOWN_CLIENT_IP } from "@/lib/client-ip";

function req(headers: Record<string, string>): { headers: Headers } {
  return { headers: new Headers(headers) };
}

const ENV = { ...process.env };
afterEach(() => {
  process.env = { ...ENV };
});

describe("off Vercel, with no declared trusted header", () => {
  beforeEach(() => {
    delete process.env.VERCEL;
    delete process.env.TRUSTED_CLIENT_IP_HEADER;
  });

  it("puts every rotating forged header into ONE bucket", () => {
    const keys = new Set<string>();
    for (let i = 1; i <= 50; i++) {
      keys.add(
        clientIpFrom(
          req({
            "x-forwarded-for": `198.51.100.${i}`,
            "x-real-ip": `203.0.113.${i}`,
            "x-vercel-forwarded-for": `192.0.2.${i}`,
          }),
        ),
      );
    }
    expect([...keys]).toEqual([UNKNOWN_CLIENT_IP]);
  });

  it("ignores x-real-ip and x-forwarded-for individually too", () => {
    expect(clientIpFrom(req({ "x-real-ip": "203.0.113.9" }))).toBe(UNKNOWN_CLIENT_IP);
    expect(clientIpFrom(req({ "x-forwarded-for": "203.0.113.9" }))).toBe(UNKNOWN_CLIENT_IP);
  });
});

describe("off Vercel, behind a declared trusted proxy", () => {
  beforeEach(() => {
    delete process.env.VERCEL;
  });

  it("trusts ONLY the declared header", () => {
    process.env.TRUSTED_CLIENT_IP_HEADER = "cf-connecting-ip";
    expect(
      clientIpFrom(req({ "cf-connecting-ip": "203.0.113.30", "x-real-ip": "1.1.1.1", "x-forwarded-for": "2.2.2.2" })),
    ).toBe("203.0.113.30");
    // Declared header absent → shared bucket, never a fallback to an untrusted one.
    expect(clientIpFrom(req({ "x-real-ip": "1.1.1.1", "x-forwarded-for": "2.2.2.2" }))).toBe(UNKNOWN_CLIENT_IP);
  });

  it("a declared header wins even ON Vercel: absent means shared, never the Vercel chain", () => {
    process.env.VERCEL = "1";
    process.env.TRUSTED_CLIENT_IP_HEADER = "cf-connecting-ip";
    expect(clientIpFrom(req({ "x-vercel-forwarded-for": "192.0.2.1", "x-real-ip": "192.0.2.2" }))).toBe(UNKNOWN_CLIENT_IP);
  });

  it("takes the first hop of a list-valued declared header", () => {
    process.env.TRUSTED_CLIENT_IP_HEADER = "X-Forwarded-For";
    expect(clientIpFrom(req({ "x-forwarded-for": "198.51.100.9, 10.0.0.1" }))).toBe("198.51.100.9");
  });
});

describe("on Vercel (edge-written headers)", () => {
  beforeEach(() => {
    process.env.VERCEL = "1";
    delete process.env.TRUSTED_CLIENT_IP_HEADER;
  });

  it("prefers x-real-ip (the production-verified header), then x-vercel-forwarded-for, then x-forwarded-for", () => {
    expect(
      clientIpFrom(req({ "x-vercel-forwarded-for": "192.0.2.1", "x-real-ip": "192.0.2.2", "x-forwarded-for": "192.0.2.3" })),
    ).toBe("192.0.2.2");
    expect(clientIpFrom(req({ "x-vercel-forwarded-for": "192.0.2.1", "x-forwarded-for": "192.0.2.3" }))).toBe("192.0.2.1");
    expect(clientIpFrom(req({ "x-forwarded-for": "192.0.2.3, 10.0.0.1" }))).toBe("192.0.2.3");
  });

  it("a forged x-vercel-forwarded-for cannot move the bucket while x-real-ip is present", () => {
    const keys = new Set<string>();
    for (let i = 1; i <= 20; i++) {
      keys.add(clientIpFrom(req({ "x-real-ip": "198.51.100.7", "x-vercel-forwarded-for": `203.0.113.${i}` })));
    }
    expect([...keys]).toEqual(["198.51.100.7"]);
  });

  it("returns the shared bucket when no header is present", () => {
    expect(clientIpFrom(req({}))).toBe(UNKNOWN_CLIENT_IP);
  });

  it("keys one IPv6 subscriber's /64 as one bucket however it rotates", () => {
    const a = clientIpFrom(req({ "x-vercel-forwarded-for": "2001:db8:abcd:12::1" }));
    const b = clientIpFrom(req({ "x-vercel-forwarded-for": "2001:db8:abcd:12:ffff:ffff:ffff:fffe" }));
    expect(a).toBe("2001:db8:abcd:12::/64");
    expect(b).toBe(a);
  });
});

describe("normaliseIpBucket", () => {
  it.each([
    ["203.0.113.7", "203.0.113.7"],
    [" 203.0.113.7 ", "203.0.113.7"],
    ["2001:db8::1", "2001:db8:0:0::/64"],
    ["2001:DB8:0:0:1:2:3:4", "2001:db8:0:0::/64"],
    ["2001:db8:1:2:3:4:5:6", "2001:db8:1:2::/64"],
    ["fe80::1", "fe80:0:0:0::/64"],
    ["::1", "0:0:0:0::/64"],
    ["::ffff:198.51.100.4", "198.51.100.4"],
    ["::ffff:c633:6404", "198.51.100.4"],
    ["64:ff9b::198.51.100.4", "64:ff9b:0:0::/64"],
    ["", UNKNOWN_CLIENT_IP],
    ["   ", UNKNOWN_CLIENT_IP],
  ])("%j -> %j", (raw, want) => {
    expect(normaliseIpBucket(raw)).toBe(want);
  });

  it("keeps a non-address as one capped bucket, never an error", () => {
    expect(normaliseIpBucket("not-an-ip")).toBe("not-an-ip");
    expect(normaliseIpBucket("256.1.1.1")).toBe("256.1.1.1");
    expect(normaliseIpBucket("1:2:3")).toBe("1:2:3");
    expect(normaliseIpBucket("1::2::3")).toBe("1::2::3");
    expect(normaliseIpBucket("1:2:3:4:5:6:7:8:9")).toBe("1:2:3:4:5:6:7:8:9");
    // "::" must stand for at least one zero group; eight explicit groups plus "::" is malformed.
    expect(normaliseIpBucket("1:2:3:4::5:6:7:8")).toBe("1:2:3:4::5:6:7:8");
    // An embedded IPv4 with an out-of-range octet is not an address.
    expect(normaliseIpBucket("::ffff:300.1.1.1")).toBe("::ffff:300.1.1.1");
    expect(normaliseIpBucket("x".repeat(500))).toHaveLength(64);
  });

  it("does not fold distinct /64s together", () => {
    expect(normaliseIpBucket("2001:db8:0:1::1")).not.toBe(normaliseIpBucket("2001:db8:0:2::1"));
  });

  it("does not fold an IPv4-mapped address onto a non-mapped one", () => {
    // ::fffe:... is NOT the mapped prefix and must stay a /64 key.
    expect(normaliseIpBucket("::fffe:c633:6404")).toBe("0:0:0:0::/64");
  });
});
