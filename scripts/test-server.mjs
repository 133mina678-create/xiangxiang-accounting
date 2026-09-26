// LOCAL TEST ONLY. Real PostgreSQL migration + RPC, with an HTTP PostgREST-compatible adapter.
// This file is never imported by the Next.js application or deployed as an API route.
import { PGlite } from "@electric-sql/pglite";
import { readFile, readdir } from "node:fs/promises";
import { createServer } from "node:http";
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
const results = await db.exec(await readFile("supabase/seed.sql", "utf8"));
const path = results
  .flatMap((r) => r.rows)
  .find((r) => r.secret_book_path).secret_book_path;
const proofObjects = new Map();
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
    if (req.url?.startsWith("/storage/v1/object/transfer-proofs/")) {
      const objectPath = decodeURIComponent(
        req.url.split("?")[0].slice("/storage/v1/object/transfer-proofs/".length),
      );
      if (req.method === "POST") {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        proofObjects.set(objectPath, Buffer.concat(chunks));
        res.end(JSON.stringify({ Key: `transfer-proofs/${objectPath}` }));
        return;
      }
      if (req.method === "GET" && proofObjects.has(objectPath)) {
        res.setHeader("Content-Type", "image/webp");
        res.end(proofObjects.get(objectPath));
        return;
      }
    }
    if (req.url?.startsWith("/storage/v1/object/sign/transfer-proofs/")) {
      const objectPath = decodeURIComponent(
        req.url.split("?")[0].slice("/storage/v1/object/sign/transfer-proofs/".length),
      );
      if (!proofObjects.has(objectPath)) throw new Error("proof not found");
      for await (const _chunk of req) void _chunk;
      res.end(
        JSON.stringify({
          signedURL: `/storage/v1/object/transfer-proofs/${encodeURIComponent(objectPath)}?token=test`,
        }),
      );
      return;
    }
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const p = raw ? JSON.parse(raw) : {};
    if (req.url === "/storage/v1/object/transfer-proofs" && req.method === "DELETE") {
      for (const objectPath of p.prefixes ?? []) proofObjects.delete(objectPath);
      res.end(JSON.stringify({ message: "Successfully deleted" }));
      return;
    }
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
    } else if (req.url === "/rest/v1/rpc/submit_transfer_proof") {
      const result = await db.query(
        "select public.submit_transfer_proof($1,$2,$3,$4,$5,$6,$7,$8,$9) result",
        [p.p_secret,p.p_revision,p.p_actor,p.p_event,p.p_from,p.p_to,p.p_amount,p.p_settlement,p.p_proof_path],
      );
      res.end(JSON.stringify(result.rows[0].result));
    } else if (req.url === "/rest/v1/rpc/transition_transfer") {
      const result = await db.query(
        "select public.transition_transfer($1,$2,$3,$4,$5) result",
        [p.p_secret,p.p_revision,p.p_actor,p.p_settlement,p.p_action],
      );
      res.end(JSON.stringify(result.rows[0].result));
    } else if (req.url === "/rest/v1/rpc/get_transfer_proof_path") {
      const result = await db.query(
        "select public.get_transfer_proof_path($1,$2,$3) result",
        [p.p_secret,p.p_actor,p.p_settlement],
      );
      res.end(JSON.stringify(result.rows[0].result));
    } else if (req.url === "/rest/v1/rpc/process_due_transfers") {
      const result = await db.query("select public.process_due_transfers() result");
      res.end(JSON.stringify(result.rows[0].result));
    } else if (req.url === "/rest/v1/rpc/claim_proof_cleanup") {
      const result = await db.query(
        "select * from public.claim_proof_cleanup($1)",
        [p.p_limit],
      );
      res.end(JSON.stringify(result.rows));
    } else if (req.url === "/rest/v1/rpc/complete_proof_cleanup") {
      await db.query("select public.complete_proof_cleanup($1::uuid[])", [p.p_ids]);
      res.end("null");
    } else if (req.url === "/rest/v1/rpc/defer_proof_cleanup") {
      await db.query("select public.defer_proof_cleanup($1::uuid[])", [p.p_ids]);
      res.end("null");
    } else if (req.url === "/rest/v1/rpc/queue_proof_cleanup") {
      await db.query("select public.queue_proof_cleanup($1)", [p.p_object_path]);
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
