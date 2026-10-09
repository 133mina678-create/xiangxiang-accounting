import { afterAll, beforeAll, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import {
  database,
  read,
  change,
  startSettlement,
  submitProof,
  transition,
} from "./database";
import { settle, statistics } from "../src/lib/calculations";
import { createHash } from "node:crypto";
let db: PGlite, secret: string;
beforeAll(async () => {
  ({ db, secret } = await database());
});
afterAll(async () => {
  await db?.close();
});
const manage = (id: string, action: string) =>
  db.query("select public.manage_event_lifecycle($1,$2,$3)", [
    secret,
    id,
    action,
  ]);
it("soft delete hides data, blocks writes, restores unchanged IDs/splits and isolates other events", async () => {
  const before = await read(db, secret);
  const e = before.events[0];
  await change(
    db,
    secret,
    before.revision,
    before.members[0].id,
    "event.save",
    {
      name: "other",
      start_date: e.start_date,
      members: [before.members[0].id],
    },
  );
  await manage(e.id, "delete");
  await manage(e.id, "delete");
  const removed = await read(db, secret);
  expect(removed.events.map((x) => x.id)).not.toContain(e.id);
  expect(removed.expenses).toHaveLength(0);
  expect(removed.deleted_events?.[0]).toMatchObject({
    id: e.id,
    status: e.status,
    expense_count: 4,
  });
  expect(
    new Date(removed.deleted_events![0].purge_after!).getTime() -
      new Date(removed.deleted_events![0].deleted_at!).getTime(),
  ).toBe(30 * 86400000);
  await expect(
    change(db, secret, removed.revision, before.members[0].id, "expense.save", {
      ...before.expenses[0],
      name: "changed",
    }),
  ).rejects.toThrow("最近刪除");
  await expect(
    db.query(
      "update ledger.expense_splits set share_amount=share_amount where event_id=$1",
      [e.id],
    ),
  ).rejects.toThrow("最近刪除");
  await expect(
    db.query("delete from ledger.events where id=$1", [e.id]),
  ).rejects.toThrow("永久清理尚未啟用");
  await manage(e.id, "restore");
  await manage(e.id, "restore");
  const restored = await read(db, secret);
  expect(restored.events.find((x) => x.id === e.id)).toEqual(e);
  expect(restored.expenses).toEqual(before.expenses);
  expect(restored.members).toEqual(before.members);
  expect(restored.events).toHaveLength(2);
});
it("closed empty activity stays closed after restore", async () => {
  let b = await read(db, secret);
  const e = b.events.find((x) => x.name === "other")!;
  await change(db, secret, b.revision, b.members[0].id, "event.close", {
    event_id: e.id,
  });
  b = await read(db, secret);
  const closed = b.events.find((x) => x.id === e.id)!;
  await manage(e.id, "delete");
  await manage(e.id, "restore");
  expect((await read(db, secret)).events.find((x) => x.id === e.id)).toEqual(
    closed,
  );
});
it("five failed management attempts lock the workspace; attempts are atomic and expire", async () => {
  const attempt = (ok: boolean) =>
    db.query<{ result: string }>(
      "select public.authorize_event_admin($1,$2) result",
      [secret, ok],
    );
  for (let i = 0; i < 5; i++)
    expect((await attempt(false)).rows[0].result).toBe("invalid_admin_secret");
  expect((await attempt(true)).rows[0].result).toBe("admin_rate_limited");
  await db.exec(
    "update ledger.workspaces set admin_locked_until=now()-interval '1 second'",
  );
  expect((await attempt(true)).rows[0].result).toBe("allowed");
});
it("management and authorization RPCs cannot be invoked by anonymous users", async () => {
  await db.exec("set role anon");
  try {
    await expect(manage(crypto.randomUUID(), "delete")).rejects.toThrow(
      "permission denied",
    );
    await expect(
      db.query("select public.authorize_event_admin($1,true)", [secret]),
    ).rejects.toThrow("permission denied");
  } finally {
    await db.exec("reset role");
  }
});
it("pending, awaiting, disputed and outstanding storage cleanup prevent deletion; completed history survives restore", async () => {
  let b = await read(db, secret);
  const e = b.events.find((x) => x.name === "台北三天兩夜")!;
  const plan = settle(statistics(e.members, b.expenses, b.payments)).map(
    (x) => ({ ...x, id: crypto.randomUUID() }),
  );
  await startSettlement(db, {
    secret,
    revision: b.revision,
    actor: b.members[0].id,
    eventId: e.id,
    plan,
  });
  await expect(manage(e.id, "delete")).rejects.toThrow("尚未完成");
  for (const p of plan) {
    b = await read(db, secret);
    await submitProof(db, {
      secret,
      revision: b.revision,
      actor: p.from_id,
      eventId: e.id,
      fromId: p.from_id,
      toId: p.to_id,
      amount: p.amount,
      settlementId: p.id,
      path:
        createHash("sha256").update(secret).digest("hex") +
        "/" +
        e.id +
        "/" +
        p.id +
        "/" +
        crypto.randomUUID() +
        ".webp",
    });
    await expect(manage(e.id, "delete")).rejects.toThrow("尚未完成");
    b = await read(db, secret);
    await transition(db, {
      secret,
      revision: b.revision,
      actor: p.to_id,
      settlementId: p.id,
      action: "dispute",
    });
    await expect(manage(e.id, "delete")).rejects.toThrow("尚未完成");
    b = await read(db, secret);
    await transition(db, {
      secret,
      revision: b.revision,
      actor: p.to_id,
      settlementId: p.id,
      action: "confirm",
    });
  }
  await expect(manage(e.id, "delete")).rejects.toThrow("尚未完成");
  await db.exec("delete from ledger.proof_cleanup_queue"); // isolated storage adapter completed its cleanup
  b = await read(db, secret);
  await manage(e.id, "delete");
  await manage(e.id, "restore");
  expect((await read(db, secret)).payments).toEqual(b.payments);
  expect(
    (
      await db.query<{ n: number }>(
        "select count(*)::int n from ledger.settlements where proof_storage_path is not null",
      )
    ).rows[0].n,
  ).toBe(0);
});
