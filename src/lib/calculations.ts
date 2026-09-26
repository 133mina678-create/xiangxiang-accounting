import type { Expense, Mode, Payment, Split, Transfer } from "./types";
export const MAX_AMOUNT = 100_000_000;
export function integer(value: unknown, min = 0, max = MAX_AMOUNT): number {
  if (typeof value === "string" && !/^\d+$/.test(value))
    throw new Error("請輸入整數金額");
  if (typeof value !== "number" && typeof value !== "string")
    throw new Error("請輸入整數");
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max)
    throw new Error(`請輸入 ${min}～${max.toLocaleString()} 的整數`);
  return n;
}
// BigInt is used for every multiplication/division in apportionment.
// Ties follow canonical member order, never checkbox click order.
export function splitEqualRotating(
  amount: number,
  ids: string[],
  rotationOrder: string[],
  rotationIndex = 0,
): { splits: Split[]; nextRotationIndex: number } {
  integer(amount, 1);
  if (
    !ids.length ||
    new Set(ids).size !== ids.length ||
    !rotationOrder.length ||
    new Set(rotationOrder).size !== rotationOrder.length ||
    ids.some((id) => !rotationOrder.includes(id))
  )
    throw new Error("請選擇不重複的分攤成員");
  let cursor =
    ((integer(rotationIndex, 0, Number.MAX_SAFE_INTEGER) % rotationOrder.length) +
      rotationOrder.length) %
    rotationOrder.length;
  const participants = new Set(ids);
  const base = Math.floor(amount / ids.length);
  const splits = ids.map((member_id) => ({
    member_id,
    weight: 1,
    share_amount: base,
  }));
  for (let extra = amount % ids.length; extra > 0; extra--) {
    while (!participants.has(rotationOrder[cursor]))
      cursor = (cursor + 1) % rotationOrder.length;
    splits.find((split) => split.member_id === rotationOrder[cursor])!
      .share_amount++;
    cursor = (cursor + 1) % rotationOrder.length;
  }
  return { splits, nextRotationIndex: cursor };
}

export function splitAmount(
  amount: number,
  ids: string[],
  mode: Mode,
  values: Record<string, number> = {},
  rotationOrder: string[] = ids,
  rotationIndex = 0,
): Split[] {
  integer(amount, 1);
  if (!ids.length || new Set(ids).size !== ids.length)
    throw new Error("請選擇不重複的分攤成員");
  if (mode === "custom") {
    const result = ids.map((member_id) => ({
      member_id,
      share_amount: integer(values[member_id]),
      weight: 1,
    }));
    if (
      result.reduce((s, x) => s + BigInt(x.share_amount), 0n) !== BigInt(amount)
    )
      throw new Error("自訂分攤合計必須等於消費金額");
    return result;
  }
  if (mode === "equal")
    return splitEqualRotating(amount, ids, rotationOrder, rotationIndex).splits;
  if (mode !== "weighted")
    throw new Error("不支援的分攤方式");
  const weights = ids.map((id) => integer(values[id], 1, 10000));
  const total = weights.reduce((s, n) => s + BigInt(n), 0n);
  const result = ids.map((member_id, i) => ({
    member_id,
    weight: weights[i],
    share_amount: Number((BigInt(amount) * BigInt(weights[i])) / total),
  }));
  const rank = weights
    .map((w, i) => ({ i, remainder: (BigInt(amount) * BigInt(w)) % total }))
    .sort((a, b) =>
      a.remainder === b.remainder
        ? a.i - b.i
        : a.remainder > b.remainder
          ? -1
          : 1,
    );
  const remainder = amount - result.reduce((s, x) => s + x.share_amount, 0);
  for (let i = 0; i < remainder; i++) result[rank[i].i].share_amount++;
  return result;
}
export function statistics(
  ids: string[],
  expenses: Expense[],
  payments: Payment[] = [],
) {
  const result = ids.map((id) => ({
    id,
    paid: 0,
    share: 0,
    net: 0,
    remaining: 0,
  }));
  const get = (id: string) => {
    const m = result.find((x) => x.id === id);
    if (!m) throw new Error("未知成員");
    return m;
  };
  for (const e of expenses.filter((x) => !x.deleted_at)) {
    if (e.splits.reduce((s, x) => s + x.share_amount, 0) !== e.amount)
      throw new Error("分攤金額不平衡");
    get(e.payer_id).paid += e.amount;
    for (const s of e.splits) get(s.member_id).share += s.share_amount;
  }
  for (const m of result) {
    m.net = m.paid - m.share;
    m.remaining = m.net;
  }
  for (const p of payments) {
    get(p.from_id).remaining += p.amount;
    get(p.to_id).remaining -= p.amount;
  }
  if (result.reduce((s, m) => s + m.remaining, 0) !== 0)
    throw new Error("結算金額不平衡");
  return result;
}
// At most six people: exhaustively explore debtor/creditor pairings.
// Each edge clears at least one balance; choose the minimum number of edges.
export function settle(
  balances: { id: string; remaining: number }[],
): Transfer[] {
  if (
    balances.some((x) => !Number.isSafeInteger(x.remaining)) ||
    balances.reduce((s, x) => s + x.remaining, 0) !== 0
  )
    throw new Error("結算金額不平衡");
  let best: Transfer[] | undefined;
  function visit(values: number[], path: Transfer[]) {
    if (best && path.length >= best.length) return;
    if (values.every((v) => v === 0)) {
      best = [...path];
      return;
    }
    for (let i = 0; i < values.length; i++)
      if (values[i] < 0) {
        for (let j = 0; j < values.length; j++)
          if (values[j] > 0) {
            const amount = Math.min(-values[i], values[j]);
            const next = [...values];
            next[i] += amount;
            next[j] -= amount;
            visit(next, [
              ...path,
              { from_id: balances[i].id, to_id: balances[j].id, amount },
            ]);
          }
      }
  }
  visit(
    balances.map((x) => x.remaining),
    [],
  );
  return best ?? [];
}
