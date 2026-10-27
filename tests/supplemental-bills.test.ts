import { afterEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import {
  change,
  database,
  read,
  saveSupplement,
  settleSupplement,
  startReview,
  startSettlement,
  transitionReview,
  transitionSupplement,
} from "./database";
import { settle, statistics } from "../src/lib/calculations";

let open: PGlite[] = [];
afterEach(async () => {
  await Promise.all(open.map((db) => db.close()));
  open = [];
});

async function setup() {
  const state = await database();
  open.push(state.db);
  const book = await read(state.db, state.secret);
  return {
    ...state,
    book,
    event: book.events[0],
    actor: book.members[0].id,
  };
}

function proposal(
  source: Awaited<ReturnType<typeof read>>["expenses"][number],
  payer = source.payer_id,
  splits = source.splits,
) {
  return {
    name: source.name,
    date: source.date,
    amount: splits.reduce((sum, split) => sum + split.share_amount, 0),
    payer_id: payer,
    category: source.category,
    note: source.note,
    mode: "custom",
    splits: splits.map((split) => ({
      member_id: split.member_id,
      share_amount: split.share_amount,
      weight: 1,
    })),
  };
}

async function confirmAll(
  db: PGlite,
  secret: string,
  eventId: string,
  bill: Awaited<ReturnType<typeof read>>["supplemental_bills"][number],
) {
  for (const participant of bill.version.participants)
    if (participant.status !== "confirmed")
      await transitionSupplement(db, {
        secret,
        actor: participant.member_id,
        eventId,
        billId: bill.id,
        versionId: bill.version.id,
        action: "confirm",
      });
}

describe("補充／修正帳單資料庫流程", () => {
  it("主結算與補充轉帳完成後可正常結束活動", async () => {
    const { db, secret, book, event, actor } = await setup();
    const mainPlan = settle(
      statistics(event.members, book.expenses, book.payments),
    ).map((transfer) => ({ ...transfer, id: crypto.randomUUID() }));
    await startSettlement(db, {
      secret,
      revision: book.revision,
      actor,
      eventId: event.id,
      plan: mainPlan,
    });
    await db.query(
      `update ledger.settlements
       set status='confirmed',paid_at=clock_timestamp(),
           confirmed_at=clock_timestamp(),confirmation_method='manual'
       where event_id=$1 and snapshot_id=(
         select settlement_snapshot_id from ledger.events where id=$1
       )`,
      [event.id],
    );
    await db.query(
      "select ledger.refresh_snapshot_status(settlement_snapshot_id) from ledger.events where id=$1",
      [event.id],
    );

    let current = await read(db, secret);
    const second = current.members[1].id;
    const billId = await saveSupplement(db, {
      secret,
      revision: current.revision,
      actor,
      submit: true,
      data: {
        id: crypto.randomUUID(),
        event_id: event.id,
        kind: "expense",
        source_expense_id: null,
        reason: "漏記點心",
        actor_confirm: true,
        proposal: {
          name: "點心",
          date: event.start_date,
          amount: 103,
          payer_id: second,
          category: "food",
          note: "",
          mode: "custom",
          splits: [{ member_id: actor, share_amount: 103, weight: 1 }],
        },
      },
    });
    current = await read(db, secret);
    let bill = current.supplemental_bills.find((row) => row.id === billId)!;
    await confirmAll(db, secret, event.id, bill);
    current = await read(db, secret);
    bill = current.supplemental_bills.find((row) => row.id === billId)!;
    await settleSupplement(db, {
      secret,
      revision: current.revision,
      actor,
      eventId: event.id,
      billId,
      versionId: bill.version.id,
    });
    await db.query(
      `update ledger.settlements s
       set status='confirmed',paid_at=clock_timestamp(),
           confirmed_at=clock_timestamp(),confirmation_method='manual'
       from ledger.settlement_snapshots ss
       where s.snapshot_id=ss.id and ss.supplemental_bill_id=$1`,
      [billId],
    );
    await db.query(
      "select ledger.refresh_snapshot_status(id) from ledger.settlement_snapshots where supplemental_bill_id=$1",
      [billId],
    );

    current = await read(db, secret);
    await change(db, secret, current.revision, actor, "event.close", {
      event_id: event.id,
    });
    current = await read(db, secret);
    expect(current.events[0].status).toBe("closed");
  });

  it("A、B 的補充費用只要求 A、B，結算不改寫主帳", async () => {
    const { db, secret, book, event, actor } = await setup();
    const second = book.members[1].id;
    const billId = crypto.randomUUID();
    await saveSupplement(db, {
      secret,
      revision: book.revision,
      actor,
      submit: true,
      data: {
        id: billId,
        event_id: event.id,
        kind: "expense",
        source_expense_id: null,
        reason: "漏記兩人點心",
        actor_confirm: true,
        proposal: {
          name: "點心",
          date: event.start_date,
          amount: 300,
          payer_id: second,
          category: "food",
          note: "",
          mode: "custom",
          splits: [{ member_id: actor, share_amount: 300, weight: 1 }],
        },
      },
    });
    let current = await read(db, secret);
    let bill = current.supplemental_bills.find((row) => row.id === billId)!;
    expect(
      bill.version.participants.map((row) => row.member_id).sort(),
    ).toEqual([actor, second].sort());
    expect(
      book.members
        .slice(2)
        .every(
          (member) =>
            !bill.version.participants.some(
              (row) => row.member_id === member.id,
            ),
        ),
    ).toBe(true);
    await confirmAll(db, secret, event.id, bill);
    current = await read(db, secret);
    bill = current.supplemental_bills.find((row) => row.id === billId)!;
    const snapshot = await settleSupplement(db, {
      secret,
      revision: current.revision,
      actor,
      eventId: event.id,
      billId,
      versionId: bill.version.id,
    });
    expect(snapshot).toBeTruthy();
    current = await read(db, secret);
    expect(current.events[0].settlement_state).toBe("draft");
    expect(current.expenses).toHaveLength(book.expenses.length);
    const payment = current.payments.find(
      (row) => row.supplemental_bill_id === billId,
    )!;
    expect(payment).toMatchObject({
      from_id: actor,
      to_id: second,
      amount: 300,
      source_kind: "supplemental",
      status: "pending_payment",
    });
  });

  it("主帳未結算時修正只重設受影響者，原確認與總額保持一致", async () => {
    const { db, secret, book, event, actor } = await setup();
    const round = await startReview(db, {
      secret,
      revision: book.revision,
      actor,
      eventId: event.id,
    });
    const originalReview = (await read(db, secret)).reviews.find(
      (r) => r.id === round,
    )!;
    for (const participant of originalReview.participants)
      await transitionReview(db, {
        secret,
        actor: participant.member_id,
        eventId: event.id,
        roundId: round,
        action: "confirm",
      });
    let current = await read(db, secret);
    const source = current.expenses[0];
    const changed = source.splits.map((split, index) => ({
      ...split,
      share_amount:
        split.share_amount + (index === 0 ? 10 : index === 1 ? -10 : 0),
    }));
    const billId = await saveSupplement(db, {
      secret,
      revision: current.revision,
      actor,
      submit: true,
      data: {
        id: crypto.randomUUID(),
        event_id: event.id,
        kind: "correction",
        source_expense_id: source.id,
        reason: "前兩人分攤寫反",
        actor_confirm: true,
        proposal: proposal(source, source.payer_id, changed),
      },
    });
    current = await read(db, secret);
    let bill = current.supplemental_bills.find((row) => row.id === billId)!;
    expect(bill.version.participants).toHaveLength(2);
    await confirmAll(db, secret, event.id, bill);
    current = await read(db, secret);
    bill = current.supplemental_bills.find((row) => row.id === billId)!;
    expect(
      await settleSupplement(db, {
        secret,
        revision: current.revision,
        actor,
        eventId: event.id,
        billId,
        versionId: bill.version.id,
      }),
    ).toBeNull();
    current = await read(db, secret);
    const after = current.expenses.find((row) => row.id === source.id)!;
    expect(after.splits.map((row) => row.share_amount)).toEqual(
      changed.map((row) => row.share_amount),
    );
    expect(after.amount).toBe(source.amount);
    const review = current.reviews.find((row) => row.id === round)!;
    const affected = new Set(
      bill.version.participants.map((row) => row.member_id),
    );
    expect(
      review.participants
        .filter((row) => !affected.has(row.member_id))
        .every((row) => row.confirmed_at),
    ).toBe(true);
  });

  it("異議跨版本保留，確認新版才視為明確接受", async () => {
    const { db, secret, book, event, actor } = await setup();
    const second = book.members[1].id;
    const data = {
      id: crypto.randomUUID(),
      event_id: event.id,
      kind: "expense",
      source_expense_id: null,
      reason: "漏記飲料",
      actor_confirm: true,
      proposal: {
        name: "飲料",
        date: event.start_date,
        amount: 200,
        payer_id: actor,
        category: "drink",
        note: "",
        mode: "custom",
        splits: [
          { member_id: actor, share_amount: 100, weight: 1 },
          { member_id: second, share_amount: 100, weight: 1 },
        ],
      },
    };
    const billId = await saveSupplement(db, {
      secret,
      revision: book.revision,
      actor,
      submit: true,
      data,
    });
    let current = await read(db, secret);
    let bill = current.supplemental_bills.find((row) => row.id === billId)!;
    await transitionSupplement(db, {
      secret,
      actor: second,
      eventId: event.id,
      billId,
      versionId: bill.version.id,
      action: "reject",
      reason: "金額不對",
    });
    current = await read(db, secret);
    await saveSupplement(db, {
      secret,
      revision: current.revision,
      actor,
      submit: true,
      data: { ...data, id: billId, reason: "修正版飲料" },
    });
    current = await read(db, secret);
    bill = current.supplemental_bills.find((row) => row.id === billId)!;
    expect(bill.version.version).toBe(2);
    expect(bill.version.disputes.some((row) => !row.resolved_at)).toBe(true);
    await transitionSupplement(db, {
      secret,
      actor: second,
      eventId: event.id,
      billId,
      versionId: bill.version.id,
      action: "confirm",
    });
    current = await read(db, secret);
    bill = current.supplemental_bills.find((row) => row.id === billId)!;
    expect(bill.version.disputes.every((row) => row.resolved_at)).toBe(true);
  });

  it("主帳正式結算後修正會暫停未付款批次並建立守恆替代批次", async () => {
    const { db, secret, book, event, actor } = await setup();
    const mainPlan = settle(
      statistics(event.members, book.expenses, book.payments),
    ).map((row) => ({ ...row, id: crypto.randomUUID() }));
    await startSettlement(db, {
      secret,
      revision: book.revision,
      actor,
      eventId: event.id,
      plan: mainPlan,
    });
    let current = await read(db, secret);
    const source = current.expenses[0];
    const changed = source.splits.map((split, index) => ({
      ...split,
      share_amount:
        split.share_amount + (index === 0 ? 20 : index === 1 ? -20 : 0),
    }));
    const billId = await saveSupplement(db, {
      secret,
      revision: current.revision,
      actor,
      submit: true,
      data: {
        id: crypto.randomUUID(),
        event_id: event.id,
        kind: "correction",
        source_expense_id: source.id,
        reason: "正式結算後差額修正",
        actor_confirm: true,
        proposal: proposal(source, source.payer_id, changed),
      },
    });
    current = await read(db, secret);
    expect(current.payments.some((row) => row.status === "paused")).toBe(true);
    let bill = current.supplemental_bills.find((row) => row.id === billId)!;
    await confirmAll(db, secret, event.id, bill);
    current = await read(db, secret);
    bill = current.supplemental_bills.find((row) => row.id === billId)!;
    await settleSupplement(db, {
      secret,
      revision: current.revision,
      actor,
      eventId: event.id,
      billId,
      versionId: bill.version.id,
    });
    current = await read(db, secret);
    expect(current.payments.some((row) => row.status === "paused")).toBe(false);
    expect(current.payments.some((row) => row.status === "superseded")).toBe(
      true,
    );
    const active = current.payments.filter((row) =>
      ["pending_payment", "record_only"].includes(row.status),
    );
    expect(active.reduce((sum, row) => sum + row.amount, 0)).toBeGreaterThan(0);
    const net = new Map(event.members.map((id) => [id, 0]));
    for (const payment of active) {
      net.set(payment.from_id, net.get(payment.from_id)! - payment.amount);
      net.set(payment.to_id, net.get(payment.to_id)! + payment.amount);
    }
    expect([...net.values()].reduce((sum, value) => sum + value, 0)).toBe(0);
  });

  it("截止、裝置時間、偽造成員與同一原消費競態由後端拒絕", async () => {
    const { db, secret, book, event, actor } = await setup();
    const second = book.members[1].id;
    const data = {
      id: crypto.randomUUID(),
      event_id: event.id,
      kind: "expense",
      source_expense_id: null,
      reason: "期限測試",
      actor_confirm: false,
      proposal: {
        name: "期限測試",
        date: event.start_date,
        amount: 100,
        payer_id: actor,
        category: "other",
        note: "",
        mode: "custom",
        splits: [{ member_id: second, share_amount: 100, weight: 1 }],
      },
    };
    const billId = await saveSupplement(db, {
      secret,
      revision: book.revision,
      actor,
      submit: true,
      data,
    });
    let current = await read(db, secret);
    let bill = current.supplemental_bills.find((row) => row.id === billId)!;
    await expect(
      settleSupplement(db, {
        secret,
        revision: current.revision,
        actor,
        eventId: event.id,
        billId,
        versionId: bill.version.id,
      }),
    ).rejects.toThrow("48 小時");
    await expect(
      transitionSupplement(db, {
        secret,
        actor: book.members[2].id,
        eventId: event.id,
        billId,
        versionId: bill.version.id,
        action: "confirm",
      }),
    ).rejects.toThrow("必要確認成員");
    await db.query(
      `update ledger.supplemental_bill_versions set
       started_at=clock_timestamp()-interval '48 hours',deadline_at=clock_timestamp()
       where id=$1`,
      [bill.version.id],
    );
    current = await read(db, secret);
    bill = current.supplemental_bills.find((row) => row.id === billId)!;
    expect(bill.version.deadline_reached).toBe(true);
    await settleSupplement(db, {
      secret,
      revision: current.revision,
      actor,
      eventId: event.id,
      billId,
      versionId: bill.version.id,
    });
  });
});
