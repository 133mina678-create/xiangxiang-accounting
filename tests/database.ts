import { PGlite } from "@electric-sql/pglite";
import { readFile, readdir } from "node:fs/promises";
import type { Book, Transfer } from "../src/lib/types";
export async function database() {
  const db = new PGlite();
  await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role;
    create schema storage;
    create table storage.buckets(
      id text primary key,
      name text not null,
      public boolean not null default false,
      file_size_limit bigint,
      allowed_mime_types text[]
    );
  `);
  for (const file of (await readdir("supabase/migrations"))
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    await db.exec(await readFile(`supabase/migrations/${file}`, "utf8"));
  }
  // Execute the real seed, preserving its random secret only within the test process.
  const results = await db.exec(await readFile("supabase/seed.sql", "utf8"));
  const row = results
    .flatMap((r) => r.rows)
    .find((r) => (r as { secret_book_path?: string }).secret_book_path) as {
    secret_book_path: string;
  };
  const secret = row.secret_book_path.split("/").at(-1)!;
  return { db, secret };
}
export async function read(db: PGlite, secret: string) {
  const r = await db.query<{ book: Book }>("select public.read_book($1) book", [
    secret,
  ]);
  return r.rows[0].book;
}
export async function change(
  db: PGlite,
  secret: string,
  revision: number,
  actor: string,
  action: string,
  data: unknown,
) {
  await db.query("select public.change_book($1,$2,$3,$4,$5)", [
    secret,
    revision,
    actor,
    action,
    JSON.stringify(data),
  ]);
}
export async function saveDiscountExpense(
  db: PGlite,
  secret: string,
  revision: number,
  actor: string,
  data: unknown,
) {
  await db.query("select public.save_discount_expense($1,$2,$3,$4)", [
    secret,
    revision,
    actor,
    JSON.stringify(data),
  ]);
}
export async function submitProof(
  db: PGlite,
  input: {
    secret: string;
    revision: number;
    actor: string;
    eventId: string;
    fromId: string;
    toId: string;
    amount: number;
    settlementId: string;
    path: string;
  },
) {
  await db.query(
    "select public.submit_transfer_proof($1,$2,$3,$4,$5,$6,$7,$8,$9)",
    [
      input.secret,
      input.revision,
      input.actor,
      input.eventId,
      input.fromId,
      input.toId,
      input.amount,
      input.settlementId,
      input.path,
    ],
  );
}
export async function startSettlement(
  db: PGlite,
  input: {
    secret: string;
    revision: number;
    actor: string;
    eventId: string;
    plan: (Transfer & { id: string })[];
    prepareReview?: boolean;
  },
) {
  let revision = input.revision;
  if (input.prepareReview !== false) {
    let book = await read(db, input.secret);
    let review = book.reviews.find(
      (candidate) =>
        candidate.event_id === input.eventId && candidate.status === "open",
    );
    if (!review) {
      await startReview(db, {
        secret: input.secret,
        revision: book.revision,
        actor: input.actor,
        eventId: input.eventId,
      });
      book = await read(db, input.secret);
      review = book.reviews.find(
        (candidate) =>
          candidate.event_id === input.eventId && candidate.status === "open",
      )!;
    }
    for (const participant of review.participants) {
      if (!participant.confirmed_at)
        await transitionReview(db, {
          secret: input.secret,
          actor: participant.member_id,
          eventId: input.eventId,
          roundId: review.id,
          action: "confirm",
        });
    }
    revision = (await read(db, input.secret)).revision;
  }
  await db.query("select public.start_settlement($1,$2,$3,$4,$5)", [
    input.secret,
    revision,
    input.actor,
    input.eventId,
    JSON.stringify(input.plan),
  ]);
}

export async function startReview(
  db: PGlite,
  input: {
    secret: string;
    revision: number;
    actor: string;
    eventId: string;
  },
) {
  const result = await db.query<{ id: string }>(
    "select public.start_settlement_review($1,$2,$3,$4) id",
    [input.secret, input.revision, input.actor, input.eventId],
  );
  return result.rows[0].id;
}

export async function transitionReview(
  db: PGlite,
  input: {
    secret: string;
    actor: string;
    eventId: string;
    roundId: string;
    action: "confirm" | "dispute" | "withdraw_dispute";
    reason?: string;
    expenseId?: string;
  },
) {
  await db.query(
    "select public.transition_settlement_review($1,$2,$3,$4,$5,$6,$7)",
    [
      input.secret,
      input.actor,
      input.eventId,
      input.roundId,
      input.action,
      input.reason ?? null,
      input.expenseId ?? null,
    ],
  );
}

export async function cancelReview(
  db: PGlite,
  input: {
    secret: string;
    revision: number;
    actor: string;
    eventId: string;
    roundId: string;
  },
) {
  await db.query("select public.cancel_settlement_review($1,$2,$3,$4,$5)", [
    input.secret,
    input.revision,
    input.actor,
    input.eventId,
    input.roundId,
  ]);
}
export async function cancelSettlement(
  db: PGlite,
  input: {
    secret: string;
    revision: number;
    actor: string;
    eventId: string;
  },
) {
  await db.query("select public.cancel_settlement($1,$2,$3,$4)", [
    input.secret,
    input.revision,
    input.actor,
    input.eventId,
  ]);
}
export async function transition(
  db: PGlite,
  input: {
    secret: string;
    revision: number;
    actor: string;
    settlementId: string;
    action: "confirm" | "dispute" | "withdraw";
  },
) {
  await db.query("select public.transition_transfer($1,$2,$3,$4,$5)", [
    input.secret,
    input.revision,
    input.actor,
    input.settlementId,
    input.action,
  ]);
}
