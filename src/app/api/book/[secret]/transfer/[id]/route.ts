import {
  adminClient,
  apiError,
  cleanupQueuedProofs,
  validBookSecret,
} from "@/lib/transfer-server";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ secret: string; id: string }> },
) {
  try {
    const { secret, id } = await params;
    if (!validBookSecret(secret)) throw new Error("invalid_link");
    const body = (await request.json()) as {
      revision?: number;
      actor?: string;
      action?: string;
    };
    if (!Number.isSafeInteger(body.revision) || !body.actor || !body.action)
      throw new Error("invalid_request");
    if (!['confirm', 'dispute'].includes(body.action)) throw new Error("invalid_action");
    const admin = adminClient();
    const { error } = await admin.rpc("transition_transfer", {
      p_secret: secret,
      p_revision: body.revision,
      p_actor: body.actor,
      p_settlement: id,
      p_action: body.action,
    });
    if (error) throw new Error(error.message);
    if (body.action === "confirm")
      await cleanupQueuedProofs(admin).catch(() => undefined);
    return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const response = apiError(error);
    return Response.json({ error: response.message }, { status: response.status });
  }
}
