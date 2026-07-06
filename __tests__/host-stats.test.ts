/** Host stat-counter unit tests (TICKET-7). */
import { computeStats } from "@/components/host/stats";
import type { QueueEntry } from "@/lib/store";

function entry(over: Partial<QueueEntry> = {}): QueueEntry {
  return {
    id: Math.random().toString(36).slice(2),
    videoId: "dQw4w9WgXcQ",
    nickname: "Ana",
    patronUuid: "uuid-1",
    mode: "sing",
    submittedAt: new Date().toISOString(),
    ...over,
  };
}

describe("computeStats", () => {
  it("is all-zero for an empty queue", () => {
    expect(computeStats([])).toEqual({ total: 0, singers: 0, tables: 0 });
  });

  it("counts entries, distinct singers, and distinct tables", () => {
    const items = [
      entry({ patronUuid: "u1", table: "3" }),
      entry({ patronUuid: "u1", table: "3" }), // same singer + table
      entry({ patronUuid: "u2", table: "5" }),
      entry({ patronUuid: "u3" }), // no table
    ];
    expect(computeStats(items)).toEqual({ total: 4, singers: 3, tables: 2 });
  });

  it("ignores blank/whitespace tables", () => {
    const items = [
      entry({ patronUuid: "u1", table: "  " }),
      entry({ patronUuid: "u2", table: "" }),
      entry({ patronUuid: "u3", table: "7" }),
    ];
    expect(computeStats(items)).toEqual({ total: 3, singers: 3, tables: 1 });
  });
});
