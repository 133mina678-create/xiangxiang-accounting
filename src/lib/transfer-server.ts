import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { MAX_PROOF_UPLOAD_BYTES, PROOF_TYPES } from "./transfer-state";

export const TRANSFER_PROOF_BUCKET = "transfer-proofs";

export function adminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("server_not_configured");
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

export function validBookSecret(secret: string) {
  return /^[a-f0-9]{64}$/.test(secret);
}

export function proofObjectPath(secret: string, eventId: string, settlementId: string) {
  const workspaceScope = createHash("sha256").update(secret).digest("hex");
  return `${workspaceScope}/${eventId}/${settlementId}/${randomUUID()}.webp`;
}

export function validateCompressedProof(file: File) {
  if (!(PROOF_TYPES as readonly string[]).includes(file.type)) return "invalid_file_type";
  if (file.size <= 0 || file.size > MAX_PROOF_UPLOAD_BYTES) return "invalid_file_size";
  return "";
}

type CleanupRow = { id: string; object_path: string };

export async function cleanupQueuedProofs(admin: SupabaseClient) {
  const { data, error } = await admin.rpc("claim_proof_cleanup", { p_limit: 100 });
  if (error) throw new Error("cleanup_claim_failed");
  const rows = (data ?? []) as CleanupRow[];
  if (!rows.length) return { deleted: 0, deferred: 0 };
  const ids = rows.map((row) => row.id);
  const { error: removeError } = await admin.storage
    .from(TRANSFER_PROOF_BUCKET)
    .remove(rows.map((row) => row.object_path));
  if (removeError) {
    await admin.rpc("defer_proof_cleanup", { p_ids: ids });
    return { deleted: 0, deferred: rows.length };
  }
  const { error: completeError } = await admin.rpc("complete_proof_cleanup", {
    p_ids: ids,
  });
  if (completeError) throw new Error("cleanup_complete_failed");
  return { deleted: rows.length, deferred: 0 };
}

export function apiError(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("conflict"))
    return { status: 409, message: "朋友剛更新了帳本，請重新確認後再試一次。" };
  if (message.includes("invalid_link")) return { status: 404, message: "帳本連結無效。" };
  if (message.includes("只有付款人") || message.includes("只有收款人"))
    return { status: 403, message };
  if (message.includes("狀態已變更") || message.includes("轉帳建議已變動"))
    return { status: 409, message };
  if (message.includes("proof_unavailable"))
    return { status: 404, message: "轉帳證明已刪除或目前無法查看。" };
  if (message === "server_not_configured")
    return { status: 503, message: "轉帳證明服務尚未完成設定。" };
  return { status: 400, message: "操作未完成，請稍後再試。" };
}
