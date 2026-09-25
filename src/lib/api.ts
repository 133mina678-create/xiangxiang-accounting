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
