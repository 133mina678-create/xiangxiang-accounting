import { describe, expect, it } from "vitest";
import type { Event } from "../src/lib/types";
import { eventsVisibleToMember } from "../src/lib/event-visibility";

function event(id: string, members: string[], status: Event["status"]): Event {
  return {
    id,
    name: id,
    start_date: "2026-11-01",
    end_date: null,
    note: "",
    archived: status === "closed",
    status,
    closed_at: status === "closed" ? "2026-11-01T00:00:00Z" : null,
    settlement_state: "draft",
    settlement_snapshot_id: null,
    settlement_started_at: null,
    remainder_rotation_index: 0,
    deleted_at: null,
    purge_after: null,
    members,
  };
}

describe("活動依參加成員顯示", () => {
  const events = [
    event("厚諾與星醬", ["厚諾", "星醬"], "active"),
    event("庫莫與兔子草", ["庫莫", "兔子草"], "active"),
    event("厚諾的舊活動", ["厚諾"], "closed"),
  ];

  it("只回傳目前成員參加的進行中與過去活動", () => {
    expect(eventsVisibleToMember(events, "厚諾").map((row) => row.id)).toEqual([
      "厚諾與星醬",
      "厚諾的舊活動",
    ]);
    expect(eventsVisibleToMember(events, "庫莫").map((row) => row.id)).toEqual([
      "庫莫與兔子草",
    ]);
  });

  it("尚未選擇身份時不顯示任何活動", () => {
    expect(eventsVisibleToMember(events, "")).toEqual([]);
  });
});

