import { createClient } from "@supabase/supabase-js";
import type { Book } from "./types";
export const configured = Boolean(
  process.env.NEXT_PUBLIC_SUPABASE_URL &&
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
);
const client = configured
  ? createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
      {
        auth: {
          persistSession: false,
          autoRefreshToken: false,
          detectSessionInUrl: false,
        },
      },
    )
  : null;
export async function readBook(secret: string): Promise<Book> {
  if (!client)
    throw new Error("尚未連接雲端帳本，請先依 README 設定 Supabase。");
  const { data, error } = await client.rpc("read_book", { p_secret: secret });
  if (error)
    throw new Error(
      error.message === "invalid_link"
        ? "連結無效，請確認群組中的完整帳本網址。"
        : "無法讀取雲端帳本，請確認網路後重試。",
    );
  return data;
}
export async function mutate(
  secret: string,
  revision: number,
  actor: string,
  action: string,
  payload: unknown,
): Promise<void> {
  if (!client) throw new Error("尚未連接雲端帳本");
  const { error } = await client.rpc("change_book", {
    p_secret: secret,
    p_revision: revision,
    p_actor: actor,
    p_action: action,
    p_data: payload,
  });
  if (error) {
    if (error.message.includes("conflict"))
      throw new Error(
        "朋友剛更新了帳本，已重新同步。你的輸入仍保留，請確認後再次儲存。",
      );
    throw new Error(error.message);
  }
}

async function parseResponse(response: Response) {
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) throw new Error(body.error || "操作未完成，請稍後再試。");
  return body;
}

export async function submitTransferProof(
  secret: string,
  input: {
    proof: File;
    revision: number;
    actor: string;
    event_id: string;
    from_id: string;
    to_id: string;
    amount: number;
    settlement_id?: string;
  },
) {
  const form = new FormData();
  form.set("proof", input.proof);
  for (const [key, value] of Object.entries(input))
    if (key !== "proof" && value !== undefined) form.set(key, String(value));
  return parseResponse(
    await fetch(`/api/book/${secret}/transfer-proof`, {
      method: "POST",
      body: form,
    }),
  );
}

export async function transitionTransfer(
  secret: string,
  id: string,
  revision: number,
  actor: string,
  action: "confirm" | "dispute",
) {
  return parseResponse(
    await fetch(`/api/book/${secret}/transfer/${id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ revision, actor, action }),
    }),
  );
}

export async function transferProofUrl(secret: string, id: string, actor: string) {
  const response = await fetch(`/api/book/${secret}/transfer/${id}/proof`, {
    headers: { "x-ledger-actor": actor },
    cache: "no-store",
  });
  const body = (await parseResponse(response)) as { url?: string };
  if (!body.url) throw new Error("轉帳證明目前無法查看。");
  return body.url;
}
