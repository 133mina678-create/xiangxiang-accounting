import { afterEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import {
  cancelReview,
  change,
  database,
  read,
  saveDiscountExpense,
  startReview,
  startSettlement,
  transitionReview,
} from "./database";
import { settle, statistics } from "../src/lib/calculations";

let openDatabases: PGlite[] = [];
afterEach(async () => {
  await Promise.all(openDatabases.map((db) => db.close()));
  openDatabases = [];
});

async function setup() {
  const state = await database();
  openDatabases.push(state.db);
  const book = await read(state.db, state.secret);
  const event = book.events[0];
  const actor = book.members[0].id;
  return { ...state, book, event, actor };
}

function planFor(book: Awaited<ReturnType<typeof read>>, eventId: string) {
  const expenses = book.expenses.filter(
    (expense) => expense.event_id === eventId && !expense.deleted_at,
  );
  const payments = book.payments.filter(
    (payment) => payment.event_id === eventId,
  );
  const event = book.events.find((candidate) => candidate.id === eventId)!;
  return settle(statistics(event.members, expenses, payments)).map(
    (transfer) => ({
      ...transfer,
      id: crypto.randomUUID(),
    }),
  );
}

async function activeReview(db: PGlite, secret: string, eventId: string) {
  const book = await read(db, secret);
  return book.reviews.find(
    (review) => review.event_id === eventId && review.status === "open",
  )!;
}

describe("結算前個人消費明細確認 migration / RPC", () => {
  it("全員可提前確認，重複發起與確認具冪等性，正式快照綁定同一輪", async () => {
    const { db, secret, book, event, actor } = await setup();
    const roundId = await startReview(db, {
      secret,
      revision: book.revision,
      actor,
      eventId: event.id,
    });
    expect(
      await startReview(db, {
        secret,
        revision: book.revision,
        actor,
        eventId: event.id,
      }),
    ).toBe(roundId);
    let review = await activeReview(db, secret, event.id);
    expect(review.participants).toHaveLength(6);
    for (const participant of review.participants)
      await transitionReview(db, {
        secret,
        actor: participant.member_id,
        eventId: event.id,
        roundId,
        action: "confirm",
      });
    await transitionReview(db, {
      secret,
      actor,
      eventId: event.id,
      roundId,
      action: "confirm",
    });
    const ready = await read(db, secret);
    review = ready.reviews.find((candidate) => candidate.id === roundId)!;
    expect(
      review.participants.every((participant) => participant.confirmed_at),
    ).toBe(true);
    const plan = planFor(ready, event.id);
    await startSettlement(db, {
      secret,
      revision: ready.revision,
      actor,
      eventId: event.id,
      plan,
      prepareReview: false,
    });
    const settled = await read(db, secret);
    expect(settled.events[0].settlement_state).toBe("locked");
    expect(
      settled.reviews.find((candidate) => candidate.id === roundId)?.status,
    ).toBe("settled");
    const snapshot = await db.query<{ review_round_id: string }>(
      "select review_round_id from ledger.settlement_snapshots where event_id=$1",
      [event.id],
    );
    expect(snapshot.rows[0].review_round_id).toBe(roundId);
  });

  it("未全員確認且未到期會拒絕；截止當下允許且未確認者不產生假時間", async () => {
    const { db, secret, book, event, actor } = await setup();
    const roundId = await startReview(db, {
      secret,
      revision: book.revision,
      actor,
      eventId: event.id,
    });
    let current = await read(db, secret);
    const plan = planFor(current, event.id);
    await expect(
      startSettlement(db, {
        secret,
        revision: current.revision,
        actor,
        eventId: event.id,
        plan,
        prepareReview: false,
      }),
    ).rejects.toThrow("48 小時");
    expect((await activeReview(db, secret, event.id)).deadline_reached).toBe(
      false,
    );
    await db.query(
      `with boundary as (
         select clock_timestamp()-interval '48 hours'+interval '1 second' started_at
       )
       update ledger.settlement_review_rounds
       set started_at=boundary.started_at,
           deadline_at=boundary.started_at+interval '48 hours'
       from boundary
       where id=$1`,
      [roundId],
    );
    current = await read(db, secret);
    expect((await activeReview(db, secret, event.id)).deadline_reached).toBe(
      false,
    );
    await expect(
      startSettlement(db, {
        secret,
        revision: current.revision,
        actor,
        eventId: event.id,
        plan,
        prepareReview: false,
      }),
    ).rejects.toThrow("48 小時");
    await db.query(
      `with boundary as (
         select clock_timestamp()-interval '48 hours' started_at
       )
       update ledger.settlement_review_rounds
       set started_at=boundary.started_at,
           deadline_at=boundary.started_at+interval '48 hours'
       from boundary
       where id=$1`,
      [roundId],
    );
    current = await read(db, secret);
    expect((await activeReview(db, secret, event.id)).deadline_reached).toBe(
      true,
    );
    await startSettlement(db, {
      secret,
      revision: current.revision,
      actor,
      eventId: event.id,
      plan,
      prepareReview: false,
    });
    const participants = await db.query<{ confirmed_at: string | null }>(
      "select confirmed_at from ledger.settlement_review_participants where round_id=$1",
      [roundId],
    );
    expect(
      participants.rows.every(
        (participant) => participant.confirmed_at === null,
      ),
    ).toBe(true);
  });

  it("異議到期後仍阻擋；提出者撤回不等於確認；取消重開不沿用舊輪", async () => {
    const { db, secret, book, event, actor } = await setup();
    const roundId = await startReview(db, {
      secret,
      revision: book.revision,
      actor,
      eventId: event.id,
    });
    await transitionReview(db, {
      secret,
      actor,
      eventId: event.id,
      roundId,
      action: "confirm",
    });
    await transitionReview(db, {
      secret,
      actor,
      eventId: event.id,
      roundId,
      action: "dispute",
      reason: "這筆費用需要重新確認",
      expenseId: book.expenses[0].id,
    });
    await db.query(
      `update ledger.settlement_review_rounds
       set started_at=clock_timestamp()-interval '48 hours',deadline_at=clock_timestamp()
       where id=$1`,
      [roundId],
    );
    let current = await read(db, secret);
    await expect(
      startSettlement(db, {
        secret,
        revision: current.revision,
        actor,
        eventId: event.id,
        plan: planFor(current, event.id),
        prepareReview: false,
      }),
    ).rejects.toThrow("異議");
    await transitionReview(db, {
      secret,
      actor,
      eventId: event.id,
      roundId,
      action: "withdraw_dispute",
    });
    current = await read(db, secret);
    expect(
      current.reviews
        .find((review) => review.id === roundId)!
        .participants.find((participant) => participant.member_id === actor)
        ?.confirmed_at,
    ).toBeNull();
    await cancelReview(db, {
      secret,
      revision: current.revision,
      actor,
      eventId: event.id,
      roundId,
    });
    current = await read(db, secret);
    const nextRound = await startReview(db, {
      secret,
      revision: current.revision,
      actor,
      eventId: event.id,
    });
    expect(nextRound).not.toBe(roundId);
    const history = (await read(db, secret)).reviews.filter(
      (review) => review.event_id === event.id,
    );
    expect(history.map((review) => review.status)).toEqual([
      "canceled",
      "open",
    ]);
    expect(
      history[1].participants.every((participant) => !participant.confirmed_at),
    ).toBe(true);
  });

  it("核對期間資料庫封鎖帳務寫入、偽造成員與舊輪次；臨時成員不列必要人數", async () => {
    const { db, secret, book, event, actor } = await setup();
    const guestId = crypto.randomUUID();
    const guestEventId = crypto.randomUUID();
    await change(db, secret, book.revision, actor, "event.save", {
      id: guestEventId,
      name: "臨時成員核對",
      start_date: "2026-10-27",
      end_date: "",
      note: "",
      members: [actor, guestId],
      guests: [{ id: guestId, name: "小明", note: "朋友" }],
    });
    let current = await read(db, secret);
    const roundId = await startReview(db, {
      secret,
      revision: current.revision,
      actor,
      eventId: guestEventId,
    });
    let review = await activeReview(db, secret, guestEventId);
    expect(
      review.participants.map((participant) => participant.member_id),
    ).toEqual([actor]);
    await expect(
      transitionReview(db, {
        secret,
        actor: guestId,
        eventId: guestEventId,
        roundId,
        action: "confirm",
      }),
    ).rejects.toThrow("必要確認成員");
    current = await read(db, secret);
    await expect(
      change(db, secret, current.revision, actor, "expense.save", {
        id: crypto.randomUUID(),
        event_id: guestEventId,
        name: "不應寫入",
        date: "2026-10-27",
        amount: 100,
        payer_id: actor,
        category: "other",
        note: "",
        mode: "equal",
        splits: [{ member_id: actor }],
      }),
    ).rejects.toThrow("確認進行中");
    await expect(
      change(db, secret, current.revision, actor, "event.save", {
        ...current.events.find((candidate) => candidate.id === guestEventId),
        members: [actor, guestId],
      }),
    ).rejects.toThrow("確認進行中");
    const restoreExpense = current.expenses.find(
      (expense) => expense.event_id === event.id,
    )!;
    await change(db, secret, current.revision, actor, "expense.delete", {
      id: restoreExpense.id,
      event_id: event.id,
    });
    current = await read(db, secret);
    const seedExpense = current.expenses.find(
      (expense) => expense.event_id === event.id && !expense.deleted_at,
    )!;
    const mainRound = await startReview(db, {
      secret,
      revision: current.revision,
      actor,
      eventId: event.id,
    });
    current = await read(db, secret);
    await expect(
      change(db, secret, current.revision, actor, "expense.restore", {
        id: restoreExpense.id,
        event_id: event.id,
      }),
    ).rejects.toThrow("確認進行中");
    await expect(
      change(db, secret, current.revision, actor, "expense.delete", {
        id: seedExpense.id,
        event_id: event.id,
      }),
    ).rejects.toThrow("確認進行中");
    await expect(
      saveDiscountExpense(db, secret, current.revision, actor, {
        ...seedExpense,
        event_id: event.id,
        discount_method: "manual",
        amount: seedExpense.amount,
        splits: seedExpense.splits.map((split) => ({
          member_id: split.member_id,
          gross_amount: split.share_amount,
          discount_amount: 0,
        })),
      }),
    ).rejects.toThrow();
    await expect(
      transitionReview(db, {
        secret,
        actor,
        eventId: guestEventId,
        roundId: mainRound,
        action: "confirm",
      }),
    ).rejects.toThrow("失效");
    await cancelReview(db, {
      secret,
      revision: current.revision,
      actor,
      eventId: event.id,
      roundId: mainRound,
    });
    current = await read(db, secret);
    await expect(
      startSettlement(db, {
        secret,
        revision: current.revision,
        actor,
        eventId: event.id,
        plan: planFor(current, event.id),
        prepareReview: false,
      }),
    ).rejects.toThrow("先發起");
    await expect(
      transitionReview(db, {
        secret,
        actor,
        eventId: event.id,
        roundId: mainRound,
        action: "confirm",
      }),
    ).rejects.toThrow("失效");
    review = await activeReview(db, secret, guestEventId);
    expect(review.status).toBe("open");
  });

  it("同時確認不遺失，確認與異議競態維持可解釋狀態", async () => {
    const { db, secret, book, event, actor } = await setup();
    const otherEventId = crypto.randomUUID();
    await change(db, secret, book.revision, actor, "event.save", {
      id: otherEventId,
      name: "另一個活動",
      start_date: "2026-10-27",
      end_date: "",
      note: "",
      members: [actor],
    });
    let current = await read(db, secret);
    const roundId = await startReview(db, {
      secret,
      revision: current.revision,
      actor,
      eventId: event.id,
    });
    current = await read(db, secret);
    await change(db, secret, current.revision, actor, "expense.save", {
      id: crypto.randomUUID(),
      event_id: otherEventId,
      name: "無關活動消費",
      date: "2026-10-27",
      amount: 50,
      payer_id: actor,
      category: "other",
      note: "",
      mode: "equal",
      splits: [{ member_id: actor }],
    });
    const review = await activeReview(db, secret, event.id);
    const first = review.participants[0].member_id;
    const second = review.participants[1].member_id;
    const confirmations = await Promise.allSettled(
      [first, second].map((memberId) =>
        transitionReview(db, {
          secret,
          actor: memberId,
          eventId: event.id,
          roundId,
          action: "confirm",
        }),
      ),
    );
    expect(confirmations.every((result) => result.status === "fulfilled")).toBe(
      true,
    );
    await Promise.allSettled([
      transitionReview(db, {
        secret,
        actor,
        eventId: event.id,
        roundId,
        action: "confirm",
      }),
      transitionReview(db, {
        secret,
        actor,
        eventId: event.id,
        roundId,
        action: "dispute",
        reason: "競態測試",
      }),
    ]);
    const after = await read(db, secret);
    const finalReview = after.reviews.find(
      (candidate) => candidate.id === roundId,
    )!;
    expect(
      finalReview.disputes.some(
        (dispute) => dispute.member_id === actor && !dispute.withdrawn_at,
      ),
    ).toBe(true);
    expect(
      finalReview.participants.find(
        (participant) => participant.member_id === actor,
      )?.confirmed_at,
    ).toBeNull();
  });
});
