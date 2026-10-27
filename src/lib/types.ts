export type Member = {
  id: string;
  name: string;
  icon: string;
  color: string;
  position: number;
  bank_code: string | null;
  bank_name: string | null;
  bank_account: string | null;
  member_type: "fixed" | "guest";
  guest_event_id: string | null;
  guest_note: string | null;
};
export type Event = {
  id: string;
  name: string;
  start_date: string;
  end_date: string | null;
  note: string;
  archived: boolean;
  status: "active" | "closed";
  closed_at: string | null;
  settlement_state: "draft" | "locked";
  settlement_snapshot_id: string | null;
  settlement_started_at: string | null;
  remainder_rotation_index: number;
  deleted_at: string | null;
  purge_after: string | null;
  members: string[];
};
export type Split = {
  member_id: string;
  share_amount: number;
  weight: number;
  gross_amount?: number | null;
  discount_amount?: number;
  discount_method?: "manual" | "shared";
};
export type Expense = {
  id: string;
  event_id: string;
  name: string;
  date: string;
  amount: number;
  payer_id: string;
  category: string;
  note: string;
  mode: Mode;
  splits: Split[];
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
};
export type Mode = "equal" | "custom" | "weighted";
export type Transfer = { from_id: string; to_id: string; amount: number };
export type SettlementStatus =
  | "record_only"
  | "pending_payment"
  | "paused"
  | "superseded"
  | "awaiting_confirmation"
  | "disputed"
  | "confirmed"
  | "auto_confirmed";
export type ConfirmationMethod = "manual" | "auto" | "legacy" | null;
export type Payment = Transfer & {
  id: string;
  event_id: string;
  snapshot_id?: string | null;
  source_kind?: "main" | "supplemental" | null;
  supplemental_bill_id?: string | null;
  status: SettlementStatus;
  paid_at: string | null;
  confirmed_at: string | null;
  disputed_at: string | null;
  confirmation_method: ConfirmationMethod;
  updated_at: string;
  created_at: string;
};
export type SupplementalDelta = {
  member_id: string;
  paid_delta: number;
  share_delta: number;
};
export type SupplementalParticipant = {
  member_id: string;
  status: "pending" | "confirmed" | "disputed" | "rejected";
  confirmed_at: string | null;
};
export type SupplementalDispute = {
  id: string;
  version_id: string;
  member_id: string;
  kind: "dispute" | "reject";
  reason: string;
  created_at: string;
  resolved_at: string | null;
  resolution: "withdrawn" | "accepted_revision" | null;
};
export type SupplementalVersion = {
  id: string;
  version: number;
  status: "draft" | "reviewing" | "approved" | "replaced" | "canceled";
  reason: string;
  base_snapshot: Omit<
    Expense,
    "id" | "event_id" | "deleted_at" | "created_at" | "updated_at"
  > | null;
  proposal: Omit<
    Expense,
    "id" | "event_id" | "deleted_at" | "created_at" | "updated_at"
  >;
  delta_snapshot: SupplementalDelta[];
  created_by: string;
  created_at: string;
  started_at: string | null;
  deadline_at: string | null;
  deadline_reached: boolean;
  can_settle: boolean;
  approved_at: string | null;
  participants: SupplementalParticipant[];
  disputes: SupplementalDispute[];
};
export type SupplementalBill = {
  id: string;
  event_id: string;
  bill_number: number;
  kind: "expense" | "correction";
  source_expense_id: string | null;
  status: "draft" | "reviewing" | "settled" | "canceled";
  current_version: number;
  created_by: string;
  created_at: string;
  updated_at: string;
  settled_at: string | null;
  canceled_at: string | null;
  settled_snapshot_id: string | null;
  reopened_closed_event: boolean;
  version: SupplementalVersion;
};
export type SettlementReviewParticipant = {
  member_id: string;
  confirmed_at: string | null;
};
export type SettlementReviewDispute = {
  id: string;
  member_id: string;
  expense_id: string | null;
  reason: string;
  created_at: string;
  withdrawn_at: string | null;
};
export type SettlementReview = {
  id: string;
  event_id: string;
  round_number: number;
  source_revision: number;
  started_by: string;
  started_at: string;
  deadline_at: string;
  deadline_reached: boolean;
  can_start: boolean;
  status: "open" | "settled" | "canceled";
  settled_at: string | null;
  canceled_at: string | null;
  participants: SettlementReviewParticipant[];
  disputes: SettlementReviewDispute[];
};
export type Log = {
  id: string;
  actor_id: string;
  event_id: string | null;
  action: string;
  detail: string;
  created_at: string;
};
export type Book = {
  revision: number;
  members: Member[];
  events: Event[];
  deleted_events?: (Event & { expense_count: number })[];
  expenses: Expense[];
  payments: Payment[];
  reviews: SettlementReview[];
  supplemental_bills: SupplementalBill[];
  logs: Log[];
};
export const categories = [
  ["food", "🍚", "餐飲"],
  ["drink", "🧋", "飲料"],
  ["transport", "🚕", "交通"],
  ["stay", "🏨", "住宿"],
  ["fun", "🎫", "門票／娛樂"],
  ["shopping", "🛍", "購物"],
  ["misc", "🏪", "雜支"],
  ["other", "📦", "其他"],
] as const;
export const money = (n: number) => `NT$ ${n.toLocaleString("zh-TW")}`;
export function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
