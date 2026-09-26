# 正式上線：xiangxiang-accounting

現有程式不需要重建。Supabase GitHub 整合負責資料庫 migrations；Vercel 負責網站。連接 GitHub 不等於已建立資料表或已部署網站。

## 0. 上傳已提交的程式

本機已連接既有 repository 並保留其 main 歷史。在 PowerShell 執行 `git -C D:\xiangxiang-ledger push -u origin main`，依 Git Credential Manager 提示登入 GitHub。成功後 repository 應出現 `src`、`supabase`、`package.json` 等檔案。

## 1. 從 Supabase 取得公開與伺服器設定

打開 `xiangxiang-accounting` → **Connect**，取得 Project URL；在 **Settings → API Keys** 取得 publishable key（`sb_publishable_…`）與 Secret key（`sb_secret_…`）。Secret key 只貼到 Vercel 的伺服器環境變數，絕對不要放進 `NEXT_PUBLIC_` 變數。

Vercel → 專案 → Settings → Environment Variables：

| Name                                   | Value                                 |
| -------------------------------------- | ------------------------------------- |
| `NEXT_PUBLIC_SUPABASE_URL`             | Connect 顯示的 `https://…supabase.co` |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | `sb_publishable_…` 或舊版 anon key    |
| `SUPABASE_SECRET_KEY`                  | `sb_secret_…`，只供伺服器使用          |
| `CRON_SECRET`                          | 自行產生至少 32 字元的隨機字串         |
| `ENABLE_EXPERIMENTAL_COREPACK`         | `1`                                   |

不需要資料庫密碼、JWT signing secret 或登入設定。帳本秘密連結也不是環境變數。`SUPABASE_SECRET_KEY` 與 `CRON_SECRET` 只存在 Vercel server runtime，不會寫入前端 bundle；修改後要 Redeploy。

本機開發才需要將 `.env.example` 複製成 `.env.local` 並填值；`.env.example` 保留範例，`.env.local` 不上傳 GitHub。

## 2. 讓 Supabase 套用 migration

Project Settings → Integrations → GitHub：確認 repository 為 `133mina678-create/xiangxiang-accounting`，Working directory 為 **`.`**，production branch 為 **`main`**，並開啟 **Deploy to production**。

推送程式後確認部署成功；應套用：

1. `supabase/migrations/202609250001_ledger.sql`
2. `supabase/migrations/202609260001_harden_api.sql`
3. `supabase/migrations/202609260002_secure_deferred_trigger.sql`
4. `supabase/migrations/202609260003_update_branding_and_member_icon.sql`
5. `supabase/migrations/202609260004_member_bank_details.sql`
6. `supabase/migrations/202609260005_transfer_confirmation.sql`

若開啟選項時程式已經推送，需重新觸發部署：在 GitHub 編輯此文件增加一個空行並 commit 到 main 即可。

SQL Editor 執行 `supabase/verify.sql`，所有 `passed` 都應為 `true`。這支檔案只檢查，不修改帳目、不輸出秘密。Storage 頁面會出現 private `transfer-proofs` bucket；不要切換為 public，也不要新增 anon 讀寫 policy。

不要在整合已套用 migration 後再手動重跑原始建表 SQL。若想改用純 SQL Editor 手動建表，先停用自動 production 部署，再依檔名順序執行全部 migrations；往後恢復整合前必須使用 CLI migration repair 對齊歷史，不能只因資料表存在就假定 migration 已被記錄。

## 3. 建立六人的共同帳本

在 SQL Editor 貼上完整 `supabase/seed.sql` 並按 Run **一次**。它會建立六個成員與 NT$6,790 的 Demo。複製結果中的 `secret_book_path`，像 `/book/…`。

此步驟故意不交由自動部署執行，避免重複建立帳本或將秘密連結寫進部署 log。每次重跑都會建立全新的獨立帳本，舊資料不會消失；請保存第一次產生的連結。

## 4. 部署 Vercel

Vercel → Add New → Project → Import `133mina678-create/xiangxiang-accounting`。Framework 選 **Next.js**，Root Directory 使用 repository 根目錄，Node.js **24.x**，Install Command 保留預設，Build Command **`pnpm build`**。

加入第 1 步的五項環境變數（至少 Production；Preview 要使用時也加入），再按 Deploy。部署後在 Supabase SQL Editor 執行 `select public.configure_transfer_confirmation_cron('https://你的正式網域','與 Vercel 相同的 CRON_SECRET');`。它會把 URL 與 secret 加密存入 Vault，並建立 `0 * * * *` 的每小時 Supabase Cron。現有 Vercel Hobby 方案不支援每小時 Vercel Cron，因此排程刻意放在 Supabase。部署成功後，把 Vercel 網域和第 3 步的路徑接起來，就是六人共用的網址。

## 5. 確認資料共享

用兩個瀏覽器／兩支手機開啟同一完整帳本網址，選不同名字，一邊新增消費，另一邊保持前景應在約 3 秒內看到。再測試修改、復原與結算。

目前是 **3 秒輪詢同步，不是 Supabase Realtime WebSocket**，所以不需開啟 Realtime、Publication 或資料表訂閱。正式資料表不應加入公開 Realtime 頻道。

Data API 保持 enabled 並包含 `public`；不要將 `ledger` 加入 Exposed schemas，也不要加 `using (true)` 的 RLS policy。使用者以秘密連結呼叫受保護 RPC；匿名不具有內部 schema／表格的直接權限。

任何持有秘密連結的人都能編輯，請只分享給六位朋友。

## 本次驗證範圍

SQL、seed、匿名 read/write 權限、錯誤秘密、跨帳本隔離、migration 後安全檢查與 Vercel 環境檢查都有自動測試。這些是在本機 PostgreSQL 引擎完成；未取得正式專案設定前，不代表已連到使用者的 Supabase 或驗證其控制台設定。

參考：[Supabase GitHub production deployment](https://supabase.com/docs/guides/deployment/branching/github-integration#deploying-changes-to-production)、[API keys](https://supabase.com/docs/guides/getting-started/api-keys)、[Vercel Corepack](https://vercel.com/docs/builds/configure-a-build#corepack)。
