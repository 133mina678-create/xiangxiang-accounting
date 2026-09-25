// Vercel injects environment variables before the build. Never print key values.
export function validateDeploymentEnv(env) {
  if (env.VERCEL !== "1") return;
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const key = env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key)
    throw new Error(
      "請設定 NEXT_PUBLIC_SUPABASE_URL 與 NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY 後重新部署。",
    );
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL 必須是完整 HTTPS Project URL。");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname === "your-project.supabase.co" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    parsed.pathname !== "/"
  )
    throw new Error(
      "請使用 Supabase Connect 顯示的 HTTPS Project URL（不含路徑）。",
    );
  if (key.startsWith("sb_secret_"))
    throw new Error(
      "不可將 secret key 放入 NEXT_PUBLIC 環境變數，請改用 publishable key。",
    );
  if (!key.startsWith("sb_publishable_")) {
    let role;
    try {
      role = JSON.parse(
        Buffer.from(key.split(".")[1], "base64url").toString(),
      ).role;
    } catch {
      /* Invalid legacy key. */
    }
    if (role !== "anon")
      throw new Error(
        "只能使用 publishable key 或 role=anon 的舊版 key；禁止 service role。",
      );
  }
}
