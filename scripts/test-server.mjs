// LOCAL TEST ONLY. Real PostgreSQL migration + RPC, with an HTTP PostgREST-compatible adapter.
// This file is never imported by the Next.js application or deployed as an API route.
import { PGlite } from "@electric-sql/pglite";
import { readFile, readdir } from "node:fs/promises";
import { createServer } from "node:http";
const db = new PGlite();
await db.exec("create role anon; create role authenticated;");
for (const file of (await readdir("supabase/migrations"))
  .filter((f) => f.endsWith(".sql"))
  .sort()) {
  await db.exec(await readFile(`supabase/migrations/${file}`, "utf8"));
}
const results = await db.exec(await readFile("supabase/seed.sql", "utf8"));
const path = results
  .flatMap((r) => r.rows)
  .find((r) => r.secret_book_path).secret_book_path;
const server = createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "http://127.0.0.1:3000");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "authorization,apikey,content-type,x-client-info,x-supabase-api-version,content-profile,accept-profile,prefer",
  );
  res.setHeader("Access-Control-Allow-Methods", "POST,GET,OPTIONS");
  res.setHeader("Content-Type", "application/json");
  if (req.method === "OPTIONS") {
    res.end();
    return;
  }
  if (req.url === "/test/book") {
    res.end(JSON.stringify({ path }));
    return;
  }
  if (req.url === "/health") {
    res.end("{}");
    return;
  }
  try {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const p = JSON.parse(raw);
    if (req.url === "/rest/v1/rpc/read_book") {
      const result = await db.query("select public.read_book($1) book", [
        p.p_secret,
      ]);
      res.end(JSON.stringify(result.rows[0].book));
    } else if (req.url === "/rest/v1/rpc/change_book") {
      await db.query("select public.change_book($1,$2,$3,$4,$5)", [
        p.p_secret,
        p.p_revision,
        p.p_actor,
        p.p_action,
        JSON.stringify(p.p_data),
      ]);
      res.end("null");
    } else {
      res.statusCode = 404;
      res.end("{}");
    }
  } catch (e) {
    res.statusCode = 400;
    res.end(
      JSON.stringify({ message: e.message, code: e.code ?? "test_error" }),
    );
  }
});
server.listen(54329, "127.0.0.1", () =>
  console.log("Local SQL test adapter ready on 127.0.0.1:54329"),
);
