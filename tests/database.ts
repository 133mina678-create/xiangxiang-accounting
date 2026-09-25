import { PGlite } from "@electric-sql/pglite";
import { readFile, readdir } from "node:fs/promises";
import type { Book } from "../src/lib/types";
export async function database() {
  const db = new PGlite();
  await db.exec("create role anon; create role authenticated;");
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
