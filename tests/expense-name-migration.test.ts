import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { expect, it } from "vitest";

it("有既有帳目時仍可安全拆分舊標題與新版備註", async () => {
  const db = new PGlite();
  try {
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
    const migrations = (await readdir("supabase/migrations"))
      .filter((file) => file.endsWith(".sql"))
      .sort();
    for (const file of migrations.filter(
      (file) => file < "202609280002_expense_name.sql",
    ))
      await db.exec(await readFile(`supabase/migrations/${file}`, "utf8"));
    await db.exec(await readFile("supabase/seed.sql", "utf8"));
    await db.exec(`
      update ledger.expenses
      set note=case amount
        when 1800 then '閃身步'
        when 480 then 'Uber'
        when 4200 then 'Airbnb'
        else '飲料'
      end,
      updated_at=case when amount=1800
        then timestamptz '2026-09-28 10:01:00+00'
        else timestamptz '2026-09-28 09:00:00+00'
      end;
      set constraints ledger.expense_balanced immediate;
    `);
    await db.exec(
      await readFile(
        "supabase/migrations/202609280002_expense_name.sql",
        "utf8",
      ),
    );
    const result = await db.query<{
      amount: number;
      name: string;
      note: string;
    }>("select amount,name,note from ledger.expenses order by amount");
    expect(result.rows.find((row) => row.amount === 1800)).toEqual({
      amount: 1800,
      name: "餐飲",
      note: "閃身步",
    });
    expect(result.rows.find((row) => row.amount === 480)).toEqual({
      amount: 480,
      name: "Uber",
      note: "",
    });
  } finally {
    await db.close();
  }
});
