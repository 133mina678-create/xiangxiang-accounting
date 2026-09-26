import { describe, expect, it } from "vitest";
import {
  AUTO_CONFIRM_HOURS,
  autoConfirmDeadline,
  isAutoConfirmDue,
  remainingConfirmationTime,
  validateTransferProofFile,
} from "../src/lib/transfer-state";

describe("transfer confirmation helpers", () => {
  it("uses a complete 72-hour deadline", () => {
    const paidAt = "2026-09-26T05:40:00.000Z";
    expect(AUTO_CONFIRM_HOURS).toBe(72);
    expect(autoConfirmDeadline(paidAt).toISOString()).toBe(
      "2026-09-29T05:40:00.000Z",
    );
    expect(
      isAutoConfirmDue(
        { status: "awaiting_confirmation", paid_at: paidAt },
        new Date("2026-09-29T05:40:00.000Z"),
      ),
    ).toBe(true);
    expect(remainingConfirmationTime(paidAt, new Date("2026-09-26T11:40:00.000Z"))).toBe(
      "2 天 18 小時",
    );
  });

  it("never auto-confirms a disputed transfer", () => {
    expect(
      isAutoConfirmDue(
        { status: "disputed", paid_at: "2026-09-20T00:00:00.000Z" },
        new Date("2026-09-30T00:00:00.000Z"),
      ),
    ).toBe(false);
  });

  it("accepts one supported image and rejects PDFs, empty, and oversized files", () => {
    expect(validateTransferProofFile({ type: "image/jpeg", size: 1000 })).toBe("");
    expect(validateTransferProofFile({ type: "image/png", size: 1000 })).toBe("");
    expect(validateTransferProofFile({ type: "image/webp", size: 1000 })).toBe("");
    expect(validateTransferProofFile({ type: "application/pdf", size: 1000 })).toContain(
      "JPG",
    );
    expect(validateTransferProofFile({ type: "image/jpeg", size: 0 })).toContain("空");
    expect(
      validateTransferProofFile({ type: "image/jpeg", size: 10 * 1024 * 1024 + 1 }),
    ).toContain("10 MB");
  });
});
