import {
  adminClient,
  apiError,
  TRANSFER_PROOF_BUCKET,
  validBookSecret,
} from "@/lib/transfer-server";

export const runtime = "nodejs";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ secret: string; id: string }> },
) {
  try {
    const { secret, id } = await params;
    const actor = request.headers.get("x-ledger-actor") ?? "";
    if (!validBookSecret(secret)) throw new Error("invalid_link");
    const admin = adminClient();
    const { data: objectPath, error: pathError } = await admin.rpc(
      "get_transfer_proof_path",
      { p_secret: secret, p_actor: actor, p_settlement: id },
    );
    if (pathError || typeof objectPath !== "string")
      throw new Error(pathError?.message ?? "proof_unavailable");
    const { data, error } = await admin.storage
      .from(TRANSFER_PROOF_BUCKET)
      .createSignedUrl(objectPath, 600);
    if (error || !data?.signedUrl) throw new Error("proof_unavailable");
    return Response.json(
      { url: data.signedUrl, expires_in: 600 },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const response = apiError(error);
    return Response.json({ error: response.message }, { status: response.status });
  }
}
