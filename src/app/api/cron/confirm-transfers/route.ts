import { adminClient, cleanupQueuedProofs } from "@/lib/transfer-server";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(request: Request) {
  const expected = process.env.CRON_SECRET;
  if (!expected || request.headers.get("authorization") !== `Bearer ${expected}`)
    return Response.json({ error: "unauthorized" }, { status: 401 });
  try {
    const admin = adminClient();
    const { data, error } = await admin.rpc("process_due_transfers");
    if (error) throw new Error("auto_confirm_failed");
    const cleanup = await cleanupQueuedProofs(admin);
    return Response.json(
      { confirmed: Number(data ?? 0), cleanup },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return Response.json({ error: "cron_failed" }, { status: 500 });
  }
}
