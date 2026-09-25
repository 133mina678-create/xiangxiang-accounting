export type Member = {
  id: string;
  name: string;
  icon: string;
  color: string;
  position: number;
};
export type Event = {
  id: string;
  name: string;
  start_date: string;
  end_date: string | null;
  note: string;
  archived: boolean;
  members: string[];
};
export type Split = { member_id: string; share_amount: number; weight: number };
export type Expense = {
  id: string;
  event_id: string;
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
export type Payment = Transfer & {
  id: string;
  event_id: string;
  created_at: string;
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
  expenses: Expense[];
  payments: Payment[];
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
