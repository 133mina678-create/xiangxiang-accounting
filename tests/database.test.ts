import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { Book } from "../src/lib/types";
import {
  database,
  read,
  change,
  submitProof,
  transition,
  startSettlement,
  cancelSettlement,
  saveDiscountExpense,
} from "./database";
import { settle, statistics } from "../src/lib/calculations";
let db: PGlite, secret: string;
beforeAll(async () => {
  ({ db, secret } = await database());
});

function proofPath(bookSecret: string, eventId: string, settlementId: string) {
  return `${createHash("sha256").update(bookSecret).digest("hex")}/${eventId}/${settlementId}/${crypto.randomUUID()}.webp`;
}

async function formalize(
  target: PGlite,
  bookSecret: string,
  book: Book,
  firstId = crypto.randomUUID(),
) {
  const transfers = settle(
    statistics(book.events[0].members, book.expenses, book.payments),
  );
  const plan = transfers.map((transfer, index) => ({
    ...transfer,
    id: index === 0 ? firstId : crypto.randomUUID(),
  }));
  await startSettlement(target, {
    secret: bookSecret,
    revision: book.revision,
    actor: book.members[0].id,
    eventId: book.events[0].id,
    plan,
  });
  return { book: await read(target, bookSecret), plan };
}

describe("轉帳確認 migration / PostgreSQL RPC", () => {
  it("上傳證明後等待確認，手動確認會清空證明並排入刪除", async () => {
    const isolated = await database();
    try {
      let book = await read(isolated.db, isolated.secret);
      const settlementId = crypto.randomUUID();
      const formal = await formalize(
        isolated.db,
        isolated.secret,
        book,
        settlementId,
      );
      book = formal.book;
      const transfer = formal.plan[0];
      const path = proofPath(isolated.secret, book.events[0].id, settlementId);
      await submitProof(isolated.db, {
        secret: isolated.secret,
        revision: book.revision,
        actor: transfer.from_id,
        eventId: book.events[0].id,
        fromId: transfer.from_id,
        toId: transfer.to_id,
        amount: transfer.amount,
        settlementId,
        path,
      });
      book = await read(isolated.db, isolated.secret);
      const payment = book.payments.find((row) => row.id === settlementId)!;
      expect(payment.status).toBe("awaiting_confirmation");
      expect(payment.paid_at).toBeTruthy();
      expect(payment).not.toHaveProperty("proof_storage_path");
      const visible = await isolated.db.query<{ path: string }>(
        "select public.get_transfer_proof_path($1,$2,$3) path",
        [isolated.secret, transfer.to_id, settlementId],
      );
      expect(visible.rows[0].path).toBe(path);
      await expect(
        isolated.db.query("select public.get_transfer_proof_path($1,$2,$3)", [
          isolated.secret,
          book.members.find(
            (member) => ![transfer.from_id, transfer.to_id].includes(member.id),
          )!.id,
          settlementId,
        ]),
      ).rejects.toThrow("proof_unavailable");
      await expect(
        submitProof(isolated.db, {
          secret: isolated.secret,
          revision: book.revision - 1,
          actor: transfer.from_id,
          eventId: book.events[0].id,
          fromId: transfer.from_id,
          toId: transfer.to_id,
          amount: transfer.amount,
          settlementId: crypto.randomUUID(),
          path: proofPath(
            isolated.secret,
            book.events[0].id,
            crypto.randomUUID(),
          ),
        }),
      ).rejects.toThrow("conflict");
      await transition(isolated.db, {
        secret: isolated.secret,
        revision: book.revision,
        actor: transfer.to_id,
        settlementId,
        action: "confirm",
      });
      book = await read(isolated.db, isolated.secret);
      expect(
        book.payments.find((payment) => payment.id === settlementId),
      ).toMatchObject({
        status: "confirmed",
        confirmation_method: "manual",
      });
      const internal = await isolated.db.query<{
        proof_storage_path: string | null;
        queued: boolean;
      }>(
        `select s.proof_storage_path,
          exists(select 1 from ledger.proof_cleanup_queue q where q.object_path=$2) queued
         from ledger.settlements s where s.id=$1`,
        [settlementId, path],
      );
      expect(internal.rows[0]).toEqual({
        proof_storage_path: null,
        queued: true,
      });
    } finally {
      await isolated.db.close();
    }
  });

  it("異議會停止自動確認，重新上傳會刪舊證明並重啟 72 小時", async () => {
    const isolated = await database();
    try {
      let book = await read(isolated.db, isolated.secret);
      const settlementId = crypto.randomUUID();
      const formal = await formalize(
        isolated.db,
        isolated.secret,
        book,
        settlementId,
      );
      book = formal.book;
      const transfer = formal.plan[0];
      const oldPath = proofPath(
        isolated.secret,
        book.events[0].id,
        settlementId,
      );
      await submitProof(isolated.db, {
        secret: isolated.secret,
        revision: book.revision,
        actor: transfer.from_id,
        eventId: book.events[0].id,
        fromId: transfer.from_id,
        toId: transfer.to_id,
        amount: transfer.amount,
        settlementId,
        path: oldPath,
      });
      book = await read(isolated.db, isolated.secret);
      await transition(isolated.db, {
        secret: isolated.secret,
        revision: book.revision,
        actor: transfer.to_id,
        settlementId,
        action: "dispute",
      });
      await isolated.db.query(
        "update ledger.settlements set paid_at=now()-interval '100 hours' where id=$1",
        [settlementId],
      );
      expect(
        (
          await isolated.db.query<{ count: number }>(
            "select public.process_due_transfers() count",
          )
        ).rows[0].count,
      ).toBe(0);
      book = await read(isolated.db, isolated.secret);
      expect(
        book.payments.find((payment) => payment.id === settlementId)?.status,
      ).toBe("disputed");
      const newPath = proofPath(
        isolated.secret,
        book.events[0].id,
        settlementId,
      );
      await submitProof(isolated.db, {
        secret: isolated.secret,
        revision: book.revision,
        actor: transfer.from_id,
        eventId: book.events[0].id,
        fromId: transfer.from_id,
        toId: transfer.to_id,
        amount: transfer.amount,
        settlementId,
        path: newPath,
      });
      book = await read(isolated.db, isolated.secret);
      const replaced = book.payments.find(
        (payment) => payment.id === settlementId,
      )!;
      expect(replaced.status).toBe("awaiting_confirmation");
      expect(new Date(replaced.paid_at!).getTime()).toBeGreaterThan(
        Date.now() - 60_000,
      );
      const queued = await isolated.db.query<{ exists: boolean }>(
        "select exists(select 1 from ledger.proof_cleanup_queue where object_path=$1)",
        [oldPath],
      );
      expect(queued.rows[0].exists).toBe(true);
      await transition(isolated.db, {
        secret: isolated.secret,
        revision: book.revision,
        actor: transfer.to_id,
        settlementId,
        action: "confirm",
      });
      expect(
        (await read(isolated.db, isolated.secret)).payments.find(
          (payment) => payment.id === settlementId,
        )?.status,
      ).toBe("confirmed");
    } finally {
      await isolated.db.close();
    }
  });

  it("每小時工作具冪等性，自動確認與活動刪除都會清理 private proof", async () => {
    const isolated = await database();
    try {
      let book = await read(isolated.db, isolated.secret);
      const settlementId = crypto.randomUUID();
      const formal = await formalize(
        isolated.db,
        isolated.secret,
        book,
        settlementId,
      );
      book = formal.book;
      const transfer = formal.plan[0];
      const path = proofPath(isolated.secret, book.events[0].id, settlementId);
      await submitProof(isolated.db, {
        secret: isolated.secret,
        revision: book.revision,
        actor: transfer.from_id,
        eventId: book.events[0].id,
        fromId: transfer.from_id,
        toId: transfer.to_id,
        amount: transfer.amount,
        settlementId,
        path,
      });
      await isolated.db.query(
        "update ledger.settlements set paid_at=now()-interval '72 hours 1 second' where id=$1",
        [settlementId],
      );
      const first = await isolated.db.query<{ count: number }>(
        "select public.process_due_transfers() count",
      );
      const second = await isolated.db.query<{ count: number }>(
        "select public.process_due_transfers() count",
      );
      expect(first.rows[0].count).toBe(1);
      expect(second.rows[0].count).toBe(0);
      book = await read(isolated.db, isolated.secret);
      expect(
        book.payments.find((payment) => payment.id === settlementId),
      ).toMatchObject({
        status: "auto_confirmed",
        confirmation_method: "auto",
      });
      const bucket = await isolated.db.query<{
        public: boolean;
        file_size_limit: number;
        allowed_mime_types: string[];
      }>(
        "select public,file_size_limit,allowed_mime_types from storage.buckets where id='transfer-proofs'",
      );
      expect(bucket.rows[0]).toMatchObject({
        public: false,
        file_size_limit: 2 * 1024 * 1024,
      });
      expect(bucket.rows[0].allowed_mime_types).not.toContain(
        "application/pdf",
      );

      const deletedId = crypto.randomUUID();
      const deletedPath = proofPath(
        isolated.secret,
        book.events[0].id,
        deletedId,
      );
      await isolated.db.query(
        `insert into ledger.settlements(
          id,event_id,from_id,to_id,amount,status,paid_at,proof_storage_path,snapshot_id,
          confirmed_at,confirmation_method
        ) values($1,$2,$3,$4,1,'awaiting_confirmation',now(),$5,$6,null,null)`,
        [
          deletedId,
          book.events[0].id,
          book.events[0].members[0],
          book.events[0].members[1],
          deletedPath,
          book.events[0].settlement_snapshot_id,
        ],
      );
      await isolated.db.exec(
        `select set_config('ledger.cancel_snapshot', '${book.events[0].settlement_snapshot_id}', true);
         delete from ledger.settlements where id='${deletedId}';`,
      );
      expect(
        (
          await isolated.db.query<{ queued: boolean }>(
            "select exists(select 1 from ledger.proof_cleanup_queue where object_path=$1) queued",
            [deletedPath],
          )
        ).rows[0].queued,
      ).toBe(true);

      // A fresh pending proof is removed by the settlement trigger when its
      // owning event is hard-deleted. All related rows cascade as one unit.
      const next = book.payments.find(
        (payment) =>
          payment.status === "pending_payment" && payment.id !== settlementId,
      )!;
      const nextId = next.id;
      const nextPath = proofPath(isolated.secret, book.events[0].id, nextId);
      await submitProof(isolated.db, {
        secret: isolated.secret,
        revision: book.revision,
        actor: next.from_id,
        eventId: book.events[0].id,
        fromId: next.from_id,
        toId: next.to_id,
        amount: next.amount,
        settlementId: nextId,
        path: nextPath,
      });
      await expect(
        isolated.db.query("delete from ledger.events where id=$1", [
          book.events[0].id,
        ]),
      ).rejects.toThrow("必須先移至最近刪除");
      await expect(
        isolated.db.query(
          "select public.manage_event_lifecycle($1,$2,'delete')",
          [isolated.secret, book.events[0].id],
        ),
      ).rejects.toThrow("尚未完成的款項");
      expect(
        (await read(isolated.db, isolated.secret)).payments.some(
          (p) => p.id === nextId,
        ),
      ).toBe(true);
    } finally {
      await isolated.db.close();
    }
  });
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
      兔子草: ["700", "郵局", "00514060075399"],
    });
  });
  it("銀行資料 migrations 可安全重跑", async () => {
    await expect(
      db.exec(
        await readFile(
          "supabase/migrations/202609260004_member_bank_details.sql",
          "utf8",
        ),
      ),
    ).resolves.toBeDefined();
    await expect(
      db.exec(
        await readFile(
          "supabase/migrations/202609260006_add_tuzicao_bank_details.sql",
          "utf8",
        ),
      ),
    ).resolves.toBeDefined();
    expect(
      (await read(db, secret)).members.find((m) => m.name === "兔子草"),
    ).toMatchObject({
      bank_code: "700",
      bank_name: "郵局",
      bank_account: "00514060075399",
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
    const e = b.expenses.find((e) => e.name === "鼎王晚餐")!;
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
  it("活動 cursor 原子輪替尾差，歷史 split 固定且衝突寫入會被拒絕", async () => {
    const isolated = await database();
    try {
      let book = await read(isolated.db, isolated.secret);
      const event = book.events[0];
      const participants = book.members.slice(0, 3).map((member) => member.id);
      const payer = book.members[5].id;
      const savedIds: string[] = [];
      for (let round = 0; round < 4; round++) {
        const id = crypto.randomUUID();
        savedIds.push(id);
        await change(
          isolated.db,
          isolated.secret,
          book.revision,
          book.members[0].id,
          "expense.save",
          {
            id,
            event_id: event.id,
            date: event.start_date,
            amount: 100,
            payer_id: payer,
            category: "other",
            note: `輪替 ${round}`,
            mode: "equal",
            splits: participants.map((member_id) => ({ member_id })),
          },
        );
        book = await read(isolated.db, isolated.secret);
      }
      expect(
        savedIds.map((id) =>
          book.expenses
            .find((expense) => expense.id === id)!
            .splits.map((split) => split.share_amount),
        ),
      ).toEqual([
        [34, 33, 33],
        [33, 34, 33],
        [33, 33, 34],
        [34, 33, 33],
      ]);
      const cursorBeforeExact = book.events[0].remainder_rotation_index;
      await change(
        isolated.db,
        isolated.secret,
        book.revision,
        book.members[0].id,
        "expense.save",
        {
          id: crypto.randomUUID(),
          event_id: event.id,
          date: event.start_date,
          amount: 1800,
          payer_id: payer,
          category: "other",
          note: "整除",
          mode: "equal",
          splits: book.members.map((member) => ({ member_id: member.id })),
        },
      );
      book = await read(isolated.db, isolated.secret);
      expect(book.events[0].remainder_rotation_index).toBe(cursorBeforeExact);
      expect(
        book.expenses
          .find((expense) => expense.id === savedIds[0])!
          .splits.map((split) => split.share_amount),
      ).toEqual([34, 33, 33]);

      const revision = book.revision;
      const concurrent = ["同時 A", "同時 B"].map((note) =>
        change(
          isolated.db,
          isolated.secret,
          revision,
          book.members[0].id,
          "expense.save",
          {
            id: crypto.randomUUID(),
            event_id: event.id,
            date: event.start_date,
            amount: 100,
            payer_id: payer,
            category: "other",
            note,
            mode: "equal",
            splits: participants.map((member_id) => ({ member_id })),
          },
        ),
      );
      const results = await Promise.allSettled(concurrent);
      expect(
        results.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      expect(
        results.filter((result) => result.status === "rejected"),
      ).toHaveLength(1);
    } finally {
      await isolated.db.close();
    }
  });
  it("消費名稱與備註獨立保存，並在資料庫限制備註 300 字", async () => {
    const isolated = await database();
    try {
      let book = await read(isolated.db, isolated.secret);
      const original = book.expenses[0];
      await change(
        isolated.db,
        isolated.secret,
        book.revision,
        book.members[0].id,
        "expense.save",
        { ...original, name: "海底撈", note: "閃身步" },
      );
      book = await read(isolated.db, isolated.secret);
      expect(
        book.expenses.find((expense) => expense.id === original.id),
      ).toMatchObject({
        name: "海底撈",
        note: "閃身步",
      });
      await change(
        isolated.db,
        isolated.secret,
        book.revision,
        book.members[0].id,
        "expense.save",
        {
          ...book.expenses.find((expense) => expense.id === original.id)!,
          note: "",
        },
      );
      book = await read(isolated.db, isolated.secret);
      expect(
        book.expenses.find((expense) => expense.id === original.id)?.note,
      ).toBe("");
      expect(
        book.expenses.find((expense) => expense.id === original.id)?.name,
      ).toBe("海底撈");
      await expect(
        change(
          isolated.db,
          isolated.secret,
          book.revision,
          book.members[0].id,
          "expense.save",
          { ...book.expenses[0], note: "長".repeat(301) },
        ),
      ).rejects.toThrow("300");
    } finally {
      await isolated.db.close();
    }
  });
  it("未結清活動不能結束，結清後由資料庫強制唯讀且 proof 不恢復", async () => {
    const isolated = await database();
    try {
      let book = await read(isolated.db, isolated.secret);
      const event = book.events[0];
      const actor = book.members[0].id;
      await expect(
        change(
          isolated.db,
          isolated.secret,
          book.revision,
          actor,
          "event.close",
          {
            event_id: event.id,
          },
        ),
      ).rejects.toThrow("尚未完成");

      const settlementId = crypto.randomUUID();
      const formal = await formalize(
        isolated.db,
        isolated.secret,
        book,
        settlementId,
      );
      book = formal.book;
      const firstTransfer = formal.plan[0];
      const path = proofPath(isolated.secret, event.id, settlementId);
      await submitProof(isolated.db, {
        secret: isolated.secret,
        revision: book.revision,
        actor: firstTransfer.from_id,
        eventId: event.id,
        fromId: firstTransfer.from_id,
        toId: firstTransfer.to_id,
        amount: firstTransfer.amount,
        settlementId,
        path,
      });
      book = await read(isolated.db, isolated.secret);
      await expect(
        change(
          isolated.db,
          isolated.secret,
          book.revision,
          actor,
          "event.close",
          {
            event_id: event.id,
          },
        ),
      ).rejects.toThrow("尚未完成");
      await transition(isolated.db, {
        secret: isolated.secret,
        revision: book.revision,
        actor: firstTransfer.to_id,
        settlementId,
        action: "confirm",
      });
      book = await read(isolated.db, isolated.secret);
      for (const payment of book.payments.filter(
        (candidate) => candidate.status === "pending_payment",
      )) {
        const nextPath = proofPath(isolated.secret, event.id, payment.id);
        await submitProof(isolated.db, {
          secret: isolated.secret,
          revision: book.revision,
          actor: payment.from_id,
          eventId: event.id,
          fromId: payment.from_id,
          toId: payment.to_id,
          amount: payment.amount,
          settlementId: payment.id,
          path: nextPath,
        });
        book = await read(isolated.db, isolated.secret);
        await transition(isolated.db, {
          secret: isolated.secret,
          revision: book.revision,
          actor: payment.to_id,
          settlementId: payment.id,
          action: "confirm",
        });
        book = await read(isolated.db, isolated.secret);
      }
      await change(
        isolated.db,
        isolated.secret,
        book.revision,
        actor,
        "event.close",
        {
          event_id: event.id,
        },
      );
      book = await read(isolated.db, isolated.secret);
      expect(book.events[0]).toMatchObject({
        status: "closed",
        archived: true,
      });
      expect(book.expenses).toHaveLength(4);
      const internal = await isolated.db.query<{
        proof_storage_path: string | null;
      }>("select proof_storage_path from ledger.settlements where id=$1", [
        settlementId,
      ]);
      expect(internal.rows[0].proof_storage_path).toBeNull();
      await expect(
        change(
          isolated.db,
          isolated.secret,
          book.revision,
          actor,
          "expense.delete",
          {
            event_id: event.id,
            id: book.expenses[0].id,
          },
        ),
      ).rejects.toThrow("唯讀");
      await expect(
        change(
          isolated.db,
          isolated.secret,
          book.revision,
          actor,
          "event.save",
          {
            ...book.events[0],
            members: book.events[0].members,
          },
        ),
      ).rejects.toThrow("唯讀");
    } finally {
      await isolated.db.close();
    }
  });
  it("活動專屬臨時成員可付款、分攤、輪替並列入資訊結算", async () => {
    const isolated = await database();
    try {
      let book = await read(isolated.db, isolated.secret);
      const actor = book.members[0].id;
      const fixed = book.members.slice(0, 2).map((member) => member.id);
      const eventId = crypto.randomUUID();
      const guestId = crypto.randomUUID();
      await change(
        isolated.db,
        isolated.secret,
        book.revision,
        actor,
        "event.save",
        {
          id: eventId,
          name: "有小明的活動",
          start_date: "2026-09-28",
          end_date: "",
          note: "",
          members: [...fixed, guestId],
          guests: [{ id: guestId, name: "小明", note: "星醬的朋友" }],
        },
      );
      book = await read(isolated.db, isolated.secret);
      const guest = book.members.find((member) => member.id === guestId)!;
      expect(guest).toMatchObject({
        name: "小明",
        member_type: "guest",
        guest_event_id: eventId,
        guest_note: "星醬的朋友",
        bank_account: null,
      });
      expect(
        book.events.find((event) => event.id === eventId)?.members,
      ).toContain(guestId);

      const otherEventId = crypto.randomUUID();
      const otherGuestId = crypto.randomUUID();
      await change(
        isolated.db,
        isolated.secret,
        book.revision,
        actor,
        "event.save",
        {
          id: otherEventId,
          name: "另一個小明活動",
          start_date: "2026-09-28",
          end_date: "",
          note: "",
          members: [fixed[0], otherGuestId],
          guests: [{ id: otherGuestId, name: "小明", note: "另一位朋友" }],
        },
      );
      book = await read(isolated.db, isolated.secret);
      expect(otherGuestId).not.toBe(guestId);
      expect(
        book.members.find((member) => member.id === otherGuestId)
          ?.guest_event_id,
      ).toBe(otherEventId);

      const expenseIds: string[] = [];
      for (let round = 0; round < 3; round++) {
        const expenseId = crypto.randomUUID();
        expenseIds.push(expenseId);
        await change(
          isolated.db,
          isolated.secret,
          book.revision,
          actor,
          "expense.save",
          {
            id: expenseId,
            event_id: eventId,
            date: "2026-09-28",
            amount: 100,
            payer_id: guestId,
            category: "food",
            note: `臨時成員輪替 ${round}`,
            mode: "equal",
            splits: [...fixed, guestId].map((member_id) => ({ member_id })),
          },
        );
        book = await read(isolated.db, isolated.secret);
      }
      expect(
        expenseIds.map((id) =>
          book.expenses
            .find((expense) => expense.id === id)!
            .splits.map((split) => split.share_amount),
        ),
      ).toEqual([
        [34, 33, 33],
        [33, 34, 33],
        [33, 33, 34],
      ]);
      const eventExpenses = book.expenses.filter(
        (expense) => expense.event_id === eventId,
      );
      const eventStats = statistics([...fixed, guestId], eventExpenses, []);
      expect(eventStats.find((row) => row.id === guestId)).toMatchObject({
        paid: 300,
        share: 100,
        net: 200,
      });
      const guestTransfers = settle(eventStats);
      expect(
        guestTransfers.every((transfer) => transfer.to_id === guestId),
      ).toBe(true);
      expect(guestTransfers).toHaveLength(2);
      expect(
        book.payments.filter((payment) => payment.event_id === eventId),
      ).toEqual([]);
      await expect(
        change(
          isolated.db,
          isolated.secret,
          book.revision,
          actor,
          "event.save",
          {
            id: eventId,
            name: "有小明的活動",
            start_date: "2026-09-28",
            end_date: "",
            note: "",
            members: fixed,
            guests: [],
          },
        ),
      ).rejects.toThrow("已有帳目紀錄");

      await change(
        isolated.db,
        isolated.secret,
        book.revision,
        actor,
        "event.save",
        {
          id: otherEventId,
          name: "另一個小明活動",
          start_date: "2026-09-28",
          end_date: "",
          note: "",
          members: [fixed[0]],
          guests: [],
        },
      );
      book = await read(isolated.db, isolated.secret);
      expect(book.members.some((member) => member.id === otherGuestId)).toBe(
        false,
      );
      expect(
        book.members.filter((member) => member.member_type === "fixed"),
      ).toHaveLength(6);
      await startSettlement(isolated.db, {
        secret: isolated.secret,
        revision: book.revision,
        actor,
        eventId,
        plan: guestTransfers.map((transfer) => ({
          ...transfer,
          id: crypto.randomUUID(),
        })),
      });
      book = await read(isolated.db, isolated.secret);
      expect(
        book.payments
          .filter((payment) => payment.event_id === eventId)
          .every((payment) => payment.status === "record_only"),
      ).toBe(true);
      await change(
        isolated.db,
        isolated.secret,
        book.revision,
        actor,
        "event.close",
        {
          event_id: eventId,
        },
      );
      book = await read(isolated.db, isolated.secret);
      expect(book.events.find((event) => event.id === eventId)?.status).toBe(
        "closed",
      );
      expect(
        book.payments.filter((payment) => payment.event_id === eventId),
      ).toHaveLength(2);
    } finally {
      await isolated.db.close();
    }
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
  it("正式結算原子建立，重複送出被拒且金額固定", async () => {
    const isolated = await database();
    try {
      const before = await read(isolated.db, isolated.secret);
      const transfers = settle(
        statistics(before.events[0].members, before.expenses, before.payments),
      );
      const plan = transfers.map((transfer) => ({
        ...transfer,
        id: crypto.randomUUID(),
      }));
      await startSettlement(isolated.db, {
        secret: isolated.secret,
        revision: before.revision,
        actor: before.members[0].id,
        eventId: before.events[0].id,
        plan,
      });
      await expect(
        startSettlement(isolated.db, {
          secret: isolated.secret,
          revision: before.revision,
          actor: before.members[0].id,
          eventId: before.events[0].id,
          plan,
          prepareReview: false,
        }),
      ).rejects.toThrow("conflict");
      const after = await read(isolated.db, isolated.secret);
      expect(after.events[0].settlement_state).toBe("locked");
      expect(after.payments).toHaveLength(plan.length);
      expect(
        statistics(
          after.events[0].members,
          after.expenses,
          after.payments,
        ).every((row) => row.remaining === 0),
      ).toBe(true);
      await expect(
        change(
          isolated.db,
          isolated.secret,
          after.revision,
          after.members[0].id,
          "expense.save",
          { ...after.expenses[0], amount: after.expenses[0].amount + 1 },
        ),
      ).rejects.toThrow("帳目已鎖定");
    } finally {
      await isolated.db.close();
    }
  });
  it("尚未提交付款可取消結算；提交後不可取消或重複提交", async () => {
    const isolated = await database();
    try {
      let book = await read(isolated.db, isolated.secret);
      let formal = await formalize(isolated.db, isolated.secret, book);
      book = formal.book;
      await cancelSettlement(isolated.db, {
        secret: isolated.secret,
        revision: book.revision,
        actor: book.members[0].id,
        eventId: book.events[0].id,
      });
      book = await read(isolated.db, isolated.secret);
      expect(book.events[0]).toMatchObject({
        settlement_state: "draft",
        settlement_snapshot_id: null,
      });
      expect(book.payments).toHaveLength(0);

      formal = await formalize(isolated.db, isolated.secret, book);
      book = formal.book;
      const transfer = formal.plan[0];
      const path = proofPath(isolated.secret, book.events[0].id, transfer.id);
      const submission = {
        secret: isolated.secret,
        revision: book.revision,
        actor: transfer.from_id,
        eventId: book.events[0].id,
        fromId: transfer.from_id,
        toId: transfer.to_id,
        amount: transfer.amount,
        settlementId: transfer.id,
        path,
      };
      await submitProof(isolated.db, submission);
      book = await read(isolated.db, isolated.secret);
      await expect(
        cancelSettlement(isolated.db, {
          secret: isolated.secret,
          revision: book.revision,
          actor: book.members[0].id,
          eventId: book.events[0].id,
        }),
      ).rejects.toThrow("已有付款提交");
      await expect(
        submitProof(isolated.db, { ...submission, revision: book.revision }),
      ).rejects.toThrow("已提交");
    } finally {
      await isolated.db.close();
    }
  });
  it("折扣明細原子保存，既有帳目不回填且個人花銷維持守恆", async () => {
    const isolated = await database();
    try {
      let book = await read(isolated.db, isolated.secret);
      const event = book.events[0];
      const [payer, second, third] = book.members;
      const legacyExpense = book.expenses[0];
      expect(legacyExpense.splits[0]).not.toHaveProperty("gross_amount");
      const id = crypto.randomUUID();
      await saveDiscountExpense(
        isolated.db,
        isolated.secret,
        book.revision,
        payer.id,
        {
          id,
          event_id: event.id,
          name: "常客折扣晚餐",
          date: event.start_date,
          amount: 700,
          payer_id: payer.id,
          category: "food",
          note: "原價 780 元，店家折 80 元",
          mode: "custom",
          discount_method: "manual",
          splits: [
            {
              member_id: payer.id,
              gross_amount: 300,
              discount_amount: 30,
              share_amount: 270,
              weight: 1,
            },
            {
              member_id: second.id,
              gross_amount: 280,
              discount_amount: 20,
              share_amount: 260,
              weight: 1,
            },
            {
              member_id: third.id,
              gross_amount: 200,
              discount_amount: 30,
              share_amount: 170,
              weight: 1,
            },
          ],
        },
      );
      book = await read(isolated.db, isolated.secret);
      const saved = book.expenses.find((expense) => expense.id === id)!;
      expect(saved.amount).toBe(700);
      expect(saved.splits).toMatchObject([
        {
          gross_amount: 300,
          discount_amount: 30,
          discount_method: "manual",
          share_amount: 270,
        },
        {
          gross_amount: 280,
          discount_amount: 20,
          discount_method: "manual",
          share_amount: 260,
        },
        {
          gross_amount: 200,
          discount_amount: 30,
          discount_method: "manual",
          share_amount: 170,
        },
      ]);
      expect(
        saved.splits.reduce((sum, split) => sum + split.share_amount, 0),
      ).toBe(700);
      expect(
        book.expenses.find((expense) => expense.id === legacyExpense.id)
          ?.splits,
      ).toEqual(legacyExpense.splits);
      await expect(
        saveDiscountExpense(
          isolated.db,
          isolated.secret,
          book.revision,
          payer.id,
          {
            ...saved,
            splits: [
              {
                member_id: payer.id,
                gross_amount: 100,
                discount_amount: 20,
              },
            ],
          },
        ),
      ).rejects.toThrow("折後金額合計");

      book = await read(isolated.db, isolated.secret);
      const sharedId = crypto.randomUUID();
      await saveDiscountExpense(
        isolated.db,
        isolated.secret,
        book.revision,
        payer.id,
        {
          id: sharedId,
          event_id: event.id,
          name: "共同折扣",
          date: event.start_date,
          amount: 700,
          payer_id: payer.id,
          category: "food",
          note: "",
          mode: "custom",
          discount_method: "shared",
          splits: [
            {
              member_id: payer.id,
              gross_amount: 300,
              discount_amount: 31,
            },
            {
              member_id: second.id,
              gross_amount: 280,
              discount_amount: 29,
            },
            {
              member_id: third.id,
              gross_amount: 200,
              discount_amount: 20,
            },
          ],
        },
      );
      book = await read(isolated.db, isolated.secret);
      expect(
        book.expenses
          .find((expense) => expense.id === sharedId)
          ?.splits.every((split) => split.discount_method === "shared"),
      ).toBe(true);
    } finally {
      await isolated.db.close();
    }
  });
  it("deployment SQL verifies RLS, grants and private publications", async () => {
    const checks = await db.query<{ check_name: string; passed: boolean }>(
      await readFile("supabase/verify.sql", "utf8"),
    );
    expect(checks.rows).toHaveLength(16);
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
    const isolated = await database();
    try {
      let b = await read(isolated.db, isolated.secret);
      const eventId = crypto.randomUUID();
      await change(
        isolated.db,
        isolated.secret,
        b.revision,
        b.members[0].id,
        "event.save",
        {
          id: eventId,
          name: "匿名權限測試",
          start_date: "2026-10-09",
          end_date: "",
          note: "",
          members: [b.members[0].id],
        },
      );
      b = await read(isolated.db, isolated.secret);
      await startSettlement(isolated.db, {
        secret: isolated.secret,
        revision: b.revision,
        actor: b.members[0].id,
        eventId,
        plan: [],
      });
      b = await read(isolated.db, isolated.secret);
      await isolated.db.exec("set role anon");
      await expect(
        change(
          isolated.db,
          "a".repeat(64),
          b.revision,
          b.members[0].id,
          "event.archive",
          { event_id: eventId, archived: true },
        ),
      ).rejects.toThrow("invalid_link");
      await change(
        isolated.db,
        isolated.secret,
        b.revision,
        b.members[0].id,
        "event.archive",
        {
          event_id: eventId,
          archived: true,
        },
      );
      const updated = await read(isolated.db, isolated.secret);
      expect(
        updated.events.find((event) => event.id === eventId)?.archived,
      ).toBe(true);
      await expect(
        change(
          isolated.db,
          isolated.secret,
          updated.revision,
          b.members[0].id,
          "event.archive",
          {
            event_id: eventId,
            archived: false,
          },
        ),
      ).rejects.toThrow("唯讀");
    } finally {
      await isolated.db.exec("reset role");
      await isolated.db.close();
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
