import {
  adminClient,
  apiError,
  cleanupQueuedProofs,
  proofObjectPath,
  TRANSFER_PROOF_BUCKET,
  validBookSecret,
  validateCompressedProof,
} from "@/lib/transfer-server";

export const runtime = "nodejs";
export const maxDuration = 30;

const uuid = /^[a-f0-9-]{36}$/i;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ secret: string }> },
) {
  let uploadedPath = "";
  try {
    const { secret } = await params;
    if (!validBookSecret(secret)) throw new Error("invalid_link");
    const form = await request.formData();
    const file = form.get("proof");
    const actor = String(form.get("actor") ?? "");
    const eventId = String(form.get("event_id") ?? "");
    const fromId = String(form.get("from_id") ?? "");
    const toId = String(form.get("to_id") ?? "");
    const revision = Number(form.get("revision"));
    const amount = Number(form.get("amount"));
    const existingId = String(form.get("settlement_id") ?? "");
    if (
      !(file instanceof File) ||
      ![actor, eventId, fromId, toId].every((value) => uuid.test(value)) ||
      (existingId && !uuid.test(existingId)) ||
      !Number.isSafeInteger(revision) ||
      !Number.isSafeInteger(amount) ||
      amount <= 0
    )
      throw new Error("invalid_request");
    const fileError = validateCompressedProof(file);
    if (fileError) throw new Error(fileError);
    const settlementId = existingId || crypto.randomUUID();
    uploadedPath = proofObjectPath(secret, eventId, settlementId);
    const admin = adminClient();
    const { error: uploadError } = await admin.storage
      .from(TRANSFER_PROOF_BUCKET)
      .upload(uploadedPath, file, {
        contentType: file.type,
        cacheControl: "300",
        upsert: false,
      });
    if (uploadError) throw new Error("proof_upload_failed");
    const { error: databaseError } = await admin.rpc("submit_transfer_proof", {
      p_secret: secret,
      p_revision: revision,
      p_actor: actor,
      p_event: eventId,
      p_from: fromId,
      p_to: toId,
      p_amount: amount,
      p_settlement: settlementId,
      p_proof_path: uploadedPath,
    });
    if (databaseError) throw new Error(databaseError.message);
    uploadedPath = "";
    await cleanupQueuedProofs(admin).catch(() => undefined);
    return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (uploadedPath) {
      try {
        const admin = adminClient();
        const { error: removeError } = await admin.storage
          .from(TRANSFER_PROOF_BUCKET)
          .remove([uploadedPath]);
        if (removeError)
          await admin.rpc("queue_proof_cleanup", { p_object_path: uploadedPath });
      } catch {
        // The response stays generic and never logs the object path.
      }
    }
    const response = apiError(error);
    return Response.json({ error: response.message }, { status: response.status });
  }
}
