import { describe, expect, it, vi } from "vitest";
import type { SettlementReview } from "../src/lib/types";
import { reviewEligibility } from "../src/lib/settlement-review";

function review(overrides: Partial<SettlementReview> = {}): SettlementReview {
  return {
    id: "round",
    event_id: "event",
    round_number: 1,
    source_revision: 1,
    started_by: "a",
    started_at: "2026-10-27T00:00:00Z",
    deadline_at: "2026-10-29T00:00:00Z",
    deadline_reached: false,
    can_start: false,
    status: "open",
    settled_at: null,
    canceled_at: null,
    participants: [
      { member_id: "a", confirmed_at: null },
      { member_id: "b", confirmed_at: null },
    ],
    disputes: [],
    ...overrides,
  };
}

describe("結算核對資格顯示", () => {
  it("修改裝置時間不能把後端尚未到期的輪次解鎖", () => {
    vi.spyOn(Date, "now").mockReturnValue(
      new Date("2099-01-01T00:00:00Z").getTime(),
    );
    expect(reviewEligibility(review()).eligible).toBe(false);
    vi.restoreAllMocks();
  });

  it("以後端計算的到期與異議結果為準", () => {
    expect(
      reviewEligibility(review({ deadline_reached: true, can_start: true }))
        .eligible,
    ).toBe(true);
    expect(
      reviewEligibility(
        review({
          deadline_reached: true,
          can_start: false,
          disputes: [
            {
              id: "d",
              member_id: "a",
              expense_id: null,
              reason: "有問題",
              created_at: "2026-10-27T01:00:00Z",
              withdrawn_at: null,
            },
          ],
        }),
      ).eligible,
    ).toBe(false);
  });
});
