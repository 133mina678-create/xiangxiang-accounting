import { describe, it, expect } from "vitest";
import {
  integer,
  splitAmount,
  statistics,
  settle,
} from "../src/lib/calculations";
import type { Expense, Payment } from "../src/lib/types";
const ids = ["a", "b", "c", "d", "e", "f"];
function expense(
  amount: number,
  payer_id: string,
  participants = ids,
  date = "2026-09-25",
): Expense {
  return {
    id: Math.random().toString(),
    event_id: "event",
    date,
    amount,
    payer_id,
    category: "food",
    note: "",
    mode: "equal",
    splits: splitAmount(amount, participants, "equal"),
    deleted_at: null,
    created_at: "",
    updated_at: "",
  };
}
describe("整數分攤", () => {
  it("1800 / 6", () =>
    expect(splitAmount(1800, ids, "equal").map((s) => s.share_amount)).toEqual([
      300, 300, 300, 300, 300, 300,
    ]));
  it("100 / 3 尾差", () =>
    expect(
      splitAmount(100, ids.slice(0, 3), "equal").map((s) => s.share_amount),
    ).toEqual([34, 33, 33]));
  it("自訂金額及驗證", () => {
    expect(
      splitAmount(100, ["a", "b"], "custom", { a: 0, b: 100 }).map(
        (s) => s.share_amount,
      ),
    ).toEqual([0, 100]);
    expect(() =>
      splitAmount(100, ["a", "b"], "custom", { a: 20, b: 70 }),
    ).toThrow();
  });
  it("份數與大額", () => {
    expect(
      splitAmount(400, ["a", "b", "c"], "weighted", { a: 2, b: 1, c: 1 }).map(
        (s) => s.share_amount,
      ),
    ).toEqual([200, 100, 100]);
    expect(
      splitAmount(
        100000000,
        ids,
        "weighted",
        Object.fromEntries(ids.map((id) => [id, 9999])),
      ).reduce((s, x) => s + x.share_amount, 0),
    ).toBe(100000000);
  });
  it.each([0, -1, NaN, Infinity, 1.5, 100000001])("拒絕非法消費 %s", (n) =>
    expect(() => splitAmount(n, ids, "equal")).toThrow(),
  );
  it.each(["", "1.2", "1e3", "-5", "1,000", " 2 ", undefined, null])(
    "拒絕非法輸入 %s",
    (n) => expect(() => integer(n, 1)).toThrow(),
  );
  it("拒絕空成員、重複、零份數", () => {
    expect(() => splitAmount(10, [], "equal")).toThrow();
    expect(() => splitAmount(10, ["a", "a"], "equal")).toThrow();
    expect(() => splitAmount(10, ["a"], "weighted", { a: 0 })).toThrow();
  });
  it("一人的活動", () => {
    expect(settle(statistics(["a"], [expense(100, "a", ["a"])]))).toEqual([]);
  });
  it("付款人不參與", () => {
    const r = statistics(ids, [expense(500, "a", ids.slice(1))]);
    expect(r[0]).toMatchObject({ paid: 500, share: 0, remaining: 500 });
    expect(settle(r)).toHaveLength(5);
  });
  it("多日、多付款人、自訂與最終結算", () => {
    const es = [
      expense(1800, "a"),
      expense(480, "d", ["a", "b", "d", "f"]),
      expense(4200, "b", ids, "2026-09-26"),
      {
        ...expense(310, "f", ["b", "c", "f"], "2026-09-26"),
        mode: "custom" as const,
        splits: splitAmount(310, ["b", "c", "f"], "custom", {
          b: 100,
          c: 100,
          f: 110,
        }),
      },
    ];
    const r = statistics(ids, es);
    expect(r.map((x) => x.net)).toEqual([680, 2980, -1100, -640, -1000, -920]);
    expect(r.reduce((s, x) => s + x.paid, 0)).toBe(6790);
    expect(
      statistics(
        ids,
        es.filter((e) => e.date === "2026-09-25"),
      ).reduce((s, x) => s + x.paid, 0),
    ).toBe(2280);
    const ts = settle(r);
    expect(ts.length).toBe(5);
    const payments = ts.map((t, i) => ({
      ...t,
      id: String(i),
      event_id: "event",
      created_at: "",
      updated_at: "",
      status: "confirmed" as const,
      paid_at: "",
      confirmed_at: "",
      disputed_at: null,
      confirmation_method: "manual" as const,
    }));
    expect(settle(statistics(ids, es, payments))).toEqual([]);
  });
  it("一人支付全部", () =>
    expect(
      settle(statistics(ids, [expense(1800, "a"), expense(600, "a")])),
    ).toHaveLength(5));
  it("修改、刪除與已付轉帳保留", () => {
    const e = expense(100, "a", ["a", "b"]);
    const p: Payment = {
      id: "p",
      event_id: "event",
      from_id: "b",
      to_id: "a",
      amount: 50,
      created_at: "",
      updated_at: "",
      status: "confirmed",
      paid_at: "",
      confirmed_at: "",
      disputed_at: null,
      confirmation_method: "manual",
    };
    expect(settle(statistics(["a", "b"], [e], [p]))).toEqual([]);
    expect(
      settle(statistics(["a", "b"], [{ ...e, deleted_at: "now" }], [p])),
    ).toEqual([{ from_id: "a", to_id: "b", amount: 50 }]);
    expect(statistics(["a", "b"], [expense(80, "a", ["a", "b"])])[0].net).toBe(
      40,
    );
  });
  it("找出比最大金額貪婪更少的轉帳方案", () => {
    const values = [-8, -7, -5, 10, 8, 2];
    const ts = settle(ids.map((id, i) => ({ id, remaining: values[i] })));
    expect(ts).toHaveLength(4);
  });
  it("1000 組整數分攤與結算守恆", () => {
    for (let k = 1; k <= 1000; k++) {
      const amount = k * 97;
      const splits = splitAmount(
        amount,
        ids,
        "weighted",
        Object.fromEntries(ids.map((id, i) => [id, ((k + i) % 9) + 1])),
      );
      expect(splits.reduce((s, x) => s + x.share_amount, 0)).toBe(amount);
      const e = { ...expense(amount, ids[k % 6]), splits };
      const s = statistics(ids, [e]);
      const ts = settle(s);
      for (const t of ts) {
        s.find((x) => x.id === t.from_id)!.remaining += t.amount;
        s.find((x) => x.id === t.to_id)!.remaining -= t.amount;
      }
      expect(s.every((x) => x.remaining === 0)).toBe(true);
    }
  });
});
