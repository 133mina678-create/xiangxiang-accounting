import type { Payment, SettlementStatus } from "./types";

export const AUTO_CONFIRM_HOURS = 72;
export const MAX_PROOF_SOURCE_BYTES = 10 * 1024 * 1024;
export const MAX_PROOF_UPLOAD_BYTES = 2 * 1024 * 1024;
export const PROOF_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;

export const settlementStatusLabel: Record<SettlementStatus, string> = {
  pending_payment: "待付款",
  awaiting_confirmation: "等待收款人確認",
  disputed: "尚未收到／有問題",
  confirmed: "已確認",
  auto_confirmed: "已自動確認",
};

export function autoConfirmDeadline(paidAt: string) {
  return new Date(new Date(paidAt).getTime() + AUTO_CONFIRM_HOURS * 60 * 60 * 1000);
}

export function isAutoConfirmDue(payment: Pick<Payment, "status" | "paid_at">, now = new Date()) {
  return Boolean(
    payment.status === "awaiting_confirmation" &&
      payment.paid_at &&
      autoConfirmDeadline(payment.paid_at).getTime() <= now.getTime(),
  );
}

export function remainingConfirmationTime(paidAt: string, now = new Date()) {
  const milliseconds = Math.max(0, autoConfirmDeadline(paidAt).getTime() - now.getTime());
  const totalHours = Math.ceil(milliseconds / 3_600_000);
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  if (!totalHours) return "即將自動確認";
  if (!days) return `${hours} 小時`;
  return `${days} 天 ${hours} 小時`;
}

export function formatTransferTime(value: string | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("zh-TW", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

export function validateTransferProofFile(file: Pick<File, "size" | "type">) {
  if (!(PROOF_TYPES as readonly string[]).includes(file.type))
    return "只接受 JPG、PNG 或 WebP 圖片。";
  if (file.size > MAX_PROOF_SOURCE_BYTES) return "原始圖片不可超過 10 MB。";
  if (file.size <= 0) return "圖片內容為空，請重新選擇。";
  return "";
}
