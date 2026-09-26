import { readFile } from "node:fs/promises";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { database, read, change } from "./database";
import { settle, statistics } from "../src/lib/calculations";
let db: PGlite, secret: string;
beforeAll(async () => {
  ({ db, secret } = await database());
});
afterAll(async () => {
  await db?.close();
});
describe("真實 migration / PostgreSQL RPC", () => {
  it("seed 與跨日統計", async () => {
    const b = await read(db, secret);
    expect(b.members).toHaveLength(6);
    expect(b.events).toHaveLength(1);
    expect(b.expenses).toHaveLength(4);
    expect(b.expenses.reduce((s, x) => s + x.amount, 0)).toBe(6790);
  });
  it("migration 與 seed 以文字欄位保存銀行資料", async () => {
    const b = await read(db, secret);
    const bank = Object.fromEntries(
      b.members.map((member) => [
        member.name,
        [member.bank_code, member.bank_name, member.bank_account],
      ]),
    );
    expect(bank).toEqual({
      厚諾: ["822", "中國信託", "078540354361"],
      星醬: ["009", "彰化銀行", "61248603680100"],
      無語: ["808", "玉山銀行", "0381979312472"],
      庫莫: ["006", "合作金庫", "251899012944"],
      千瑾: ["700", "郵局", "01410091872553"],
      兔子草: [null, null, null],
    });
  });
  it("銀行資料 migration 可安全重跑", async () => {
    await expect(
      db.exec(
        await readFile(
          "supabase/migrations/202609260004_member_bank_details.sql",
          "utf8",
        ),
      ),
    ).resolves.toBeDefined();
    expect(
      (await read(db, secret)).members.find((m) => m.name === "兔子草"),
    ).toMatchObject({
      bank_code: null,
      bank_name: null,
      bank_account: null,
    });
  });
  it("匿名可以使用秘密 RPC，但不能存取或列出表格", async () => {
    await db.exec("set role anon");
    try {
      expect((await read(db, secret)).members).toHaveLength(6);
      await expect(db.query("select * from ledger.workspaces")).rejects.toThrow(
        /permission denied/,
      );
      await expect(read(db, "a".repeat(64))).rejects.toThrow("invalid_link");
      await expect(read(db, "1")).rejects.toThrow("invalid_link");
      await expect(
        db.query("select ledger.balance(gen_random_uuid(),gen_random_uuid())"),
      ).rejects.toThrow(/permission denied/);
    } finally {
      await db.exec("reset role");
    }
  });
  it("整筆拒絕自訂金額不平衡、不接受小數", async () => {
    const b = await read(db, secret),
      e = b.expenses[0];
    await expect(
      change(db, secret, b.revision, b.members[0].id, "expense.save", {
        ...e,
        amount: 123,
        mode: "custom",
        splits: [{ member_id: e.payer_id, share_amount: 122 }],
      }),
    ).rejects.toThrow("分攤合計");
    expect((await read(db, secret)).revision).toBe(b.revision);
    await expect(
      change(db, secret, b.revision, b.members[0].id, "expense.save", {
        ...e,
        amount: 123.5,
      }),
    ).rejects.toThrow("正整數");
  });
  it("過期 revision 不覆蓋新資料", async () => {
    const b = await read(db, secret);
    await expect(
      change(db, secret, b.revision - 1, b.members[0].id, "event.archive", {
        event_id: b.events[0].id,
        archived: true,
      }),
    ).rejects.toThrow("conflict");
  });
  it("範圍、跨帳本與成員防護", async () => {
    const b = await read(db, secret),
      e = b.expenses[0];
    await expect(
      change(db, secret, b.revision, b.members[0].id, "expense.save", {
        ...e,
        date: "2026-10-01",
      }),
    ).rejects.toThrow("日期");
    await expect(
      change(db, secret, b.revision, b.members[0].id, "expense.save", {
        ...e,
        event_id: crypto.randomUUID(),
      }),
    ).rejects.toThrow("invalid_event");
    await expect(
      change(db, secret, b.revision, crypto.randomUUID(), "expense.delete", {
        event_id: e.event_id,
        id: e.id,
      }),
    ).rejects.toThrow("身份");
  });
  it("伺服器重新計算平均分，忽略偽造分攤", async () => {
    let b = await read(db, secret);
    const e = b.expenses.find((e) => e.note === "鼎王晚餐")!;
    await change(db, secret, b.revision, b.members[0].id, "expense.save", {
      ...e,
      amount: 100,
      splits: e.splits.slice(0, 3).map((s) => ({ ...s, share_amount: 9999 })),
    });
    b = await read(db, secret);
    expect(
      b.expenses.find((x) => x.id === e.id)!.splits.map((s) => s.share_amount),
    ).toEqual([34, 33, 33]);
  });
  it("軟刪除 / 復原後守恆", async () => {
    let b = await read(db, secret);
    const e = b.expenses[0];
    const before = statistics(
      b.members.map((m) => m.id),
      b.expenses,
    ).reduce((s, x) => s + x.paid, 0);
    await change(db, secret, b.revision, b.members[0].id, "expense.delete", {
      id: e.id,
      event_id: e.event_id,
    });
    b = await read(db, secret);
    expect(
      statistics(
        b.members.map((m) => m.id),
        b.expenses,
      ).reduce((s, x) => s + x.paid, 0),
    ).toBe(before - e.amount);
    await change(db, secret, b.revision, b.members[0].id, "expense.restore", {
      id: e.id,
      event_id: e.event_id,
    });
    b = await read(db, secret);
    expect(
      statistics(
        b.members.map((m) => m.id),
        b.expenses,
      ).reduce((s, x) => s + x.paid, 0),
    ).toBe(before);
  });
  it("實際寫入轉帳、重複送出被拒、全部結清", async () => {
    let b = await read(db, secret);
    let ts = settle(
      statistics(
        b.members.map((m) => m.id),
        b.expenses,
        b.payments,
      ),
    );
    while (ts.length) {
      const rev = b.revision;
      const data = { event_id: b.events[0].id, ...ts[0] };
      await change(db, secret, rev, b.members[0].id, "payment.add", data);
      await expect(
        change(db, secret, rev, b.members[0].id, "payment.add", data),
      ).rejects.toThrow("conflict");
      b = await read(db, secret);
      ts = settle(
        statistics(
          b.members.map((m) => m.id),
          b.expenses,
          b.payments,
        ),
      );
    }
    expect(b.payments.length).toBeGreaterThan(0);
    expect(
      statistics(
        b.members.map((m) => m.id),
        b.expenses,
        b.payments,
      ).every((x) => x.remaining === 0),
    ).toBe(true);
  });
  it("deployment SQL verifies RLS, grants and private publications", async () => {
    const checks = await db.query<{ check_name: string; passed: boolean }>(
      await readFile("supabase/verify.sql", "utf8"),
    );
    expect(checks.rows).toHaveLength(8);
    for (const check of checks.rows)
      expect(check.passed, check.check_name).toBe(true);
  });
  it("authenticator 切換成 anon 後可提交延遲分攤 trigger", async () => {
    const isolated = await database();
    try {
      let b = await read(isolated.db, isolated.secret);
      const actor = b.members[0];
      const event = b.events[0];
      await isolated.db.exec(
        "create role authenticator noinherit; grant anon to authenticator; set session authorization authenticator; set role anon;",
      );
      await change(
        isolated.db,
        isolated.secret,
        b.revision,
        actor.id,
        "expense.save",
        {
          event_id: event.id,
          date: event.start_date,
          amount: 1,
          payer_id: actor.id,
          category: "other",
          note: "延遲 trigger 權限測試",
          mode: "equal",
          splits: [{ member_id: actor.id }],
        },
      );
      b = await read(isolated.db, isolated.secret);
      expect(
        b.expenses.some(
          (expense) =>
            expense.note === "延遲 trigger 權限測試" && expense.amount === 1,
        ),
      ).toBe(true);
    } finally {
      await isolated.db.close();
    }
  });
  it("anon can edit with the secret and cannot edit without it", async () => {
    const b = await read(db, secret);
    await db.exec("set role anon");
    try {
      await expect(
        change(
          db,
          "a".repeat(64),
          b.revision,
          b.members[0].id,
          "event.archive",
          { event_id: b.events[0].id, archived: true },
        ),
      ).rejects.toThrow("invalid_link");
      await change(db, secret, b.revision, b.members[0].id, "event.archive", {
        event_id: b.events[0].id,
        archived: true,
      });
      const updated = await read(db, secret);
      expect(updated.events[0].archived).toBe(true);
      await change(
        db,
        secret,
        updated.revision,
        b.members[0].id,
        "event.archive",
        { event_id: b.events[0].id, archived: false },
      );
    } finally {
      await db.exec("reset role");
    }
  });
  it("seed returns the secret as its final result and isolates different books", async () => {
    const result = await db.exec(await readFile("supabase/seed.sql", "utf8"));
    const row = result.at(-1)!.rows[0] as { secret_book_path: string };
    expect(row.secret_book_path).toMatch(/^\/book\/[a-f0-9]{64}$/);
    const other = await read(db, row.secret_book_path.split("/").at(-1)!);
    const original = await read(db, secret);
    expect(other.members[0].id).not.toBe(original.members[0].id);
    await expect(
      change(
        db,
        secret,
        original.revision,
        original.members[0].id,
        "event.archive",
        { event_id: other.events[0].id, archived: true },
      ),
    ).rejects.toThrow("invalid_event");
  });
});
