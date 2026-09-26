# 香香的記帳本

**已有 Supabase / GitHub 專案：依 [正式上線步驟](DEPLOY.md) 完成部署。**

六位朋友專用的旅行／聚會共同分帳工具。沒有登入、沒有收入與資產功能；打開同一個秘密連結，就能共同記帳。手機優先，桌面也可使用。

## 技術與架構

- Next.js 16 App Router、React 19、TypeScript；使用語意 HTML、原生可存取 dialog、Lucide 圖示及自訂暖色 CSS。
- Supabase PostgreSQL 是唯一正式資料來源。瀏覽器使用 publishable／anon key 呼叫兩個受秘密連結保護的 RPC。
- Vercel 部署 Next.js。沒有服務端管理員金鑰、會員或 Supabase Auth。
- Vitest 測試整數計算；PGlite 在真實 PostgreSQL 引擎執行正式 migration／seed／RPC；Playwright 測試兩個獨立瀏覽器的完整操作。
- 為了讓可匿名使用的權限模型簡單可靠，採 **3 秒輪詢的近即時同步**，而非 Supabase Realtime 公開頻道。背景分頁暫停輪詢，回到頁面或網路恢復立即同步。六人小團體不需要維護 WebSocket token 簽發服務。介面會顯示同步／斷線狀態。

## 已實作功能

活動建立／編輯／收藏、固定六人身份選擇、活動成員、跨日帳目、日期／付款人／分類篩選、消費新增／詳情／修改／軟刪除、12 秒 Undo、永久保留的回收區、平均／自訂／份數分攤、尾差預覽、每日與活動統計、最少筆數結算、收款銀行末四碼與一鍵複製、已付款標記與撤銷、CSV 匯出、最近 100 筆修改紀錄。

結束日期可省略；未設定時允許開始日期以後的任意日期。日期預設今天，但今天若超過活動範圍則移到最近的合法日期。活動是否進行中由使用者「移至過去活動」決定，不會午夜自動消失。每筆消費的付款人可不參與分攤。

## 本地開發

需要 Node.js 24 LTS、pnpm 11.19.0（已在 package.json 固定版本）。

```sh
corepack enable
pnpm install --frozen-lockfile
cp .env.example .env.local
pnpm dev
```

PowerShell 複製環境檔：`Copy-Item .env.example .env.local`。開啟 `http://localhost:3000`，再使用下面 SQL 產生的 `/book/…` 路徑進入帳本。

### 尚未建立雲端時的本機預覽

執行 `pnpm preview:local`，終端會顯示完整秘密連結。這個便利模式使用隔離的 PostgreSQL 測試引擎，綁定本機 127.0.0.1；不需要環境變數，資料在停止服務後清空，**不能把此網址傳到群組當作正式服務**。結束用 Ctrl+C。請不要與 `pnpm test:e2e` 或其他 3000／54329 連接埠服務同時執行。

### 環境變數

| 變數                                   | 值                                                        |
| -------------------------------------- | --------------------------------------------------------- |
| `NEXT_PUBLIC_SUPABASE_URL`             | Supabase Project URL，例如 `https://abcdefgh.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Publishable key，或既有專案的 anon key                    |
| `ENABLE_EXPERIMENTAL_COREPACK`         | Vercel 填 `1`，使用指定的 pnpm 版本                       |

兩個值本來就適合公開前端使用。**不能填 service role key、secret key、資料庫密碼或 JWT signing key。** `.env.local` 已排除版本控制。環境變數在建置時寫入前端，Vercel 修改後必須重新部署。

## Supabase 設定與 migration

1. 在自己的 Supabase 帳號建立專案，選擇鄰近地區（例如 Singapore）。
2. 優先讓 GitHub integration（main、Working directory `.`、Deploy to production）依檔名順序套用 `supabase/migrations/` 中的 migrations。或用已 link 的 CLI 執行 `supabase db push`。不要混用手動 SQL 與自動 migration；詳細步驟見 DEPLOY.md。
3. SQL Editor 執行 `supabase/seed.sql` **一次**。這會建立新帳本、六位固定成員及指定的「台北三天兩夜」Demo。結果表的 `secret_book_path` 是新帳本的秘密路徑，請妥善保存。
4. 將路徑接在應用程式網域後，例如 `https://your-app.vercel.app/book/<64個隨機十六進位字元>`。
5. Project Settings → API 取得 Project URL 與 publishable／anon key，填入 `.env.local` 及 Vercel 環境變數。
6. Data API exposed schemas 只需預設 `public`；**不要 expose `ledger` schema**，不要替內部資料表新增公開 RLS policy。

`supabase/config.toml` 已關閉自動 seed；production 的 API 設定仍須在控制台確認，`config.toml` 不會預設覆蓋 production API 設定。

`seed.sql` 每次執行都會建立另一個獨立帳本與全新連結，不會覆寫舊資料。它不含固定公開密碼。秘密只在建立時回傳，資料庫儲存 SHA-256 hash，無法從資料庫 hash 還原網址。SQL Editor 請使用結果表取得路徑；不要將結果貼進公開 issue、Git repo 或截圖。

如果不想使用 Demo，進入後把 Demo 活動移到過去活動即可；若要完全空帳本，可複製 seed，刪除四個 `expense.save` 呼叫與 `event.save` 呼叫，保留 workspace／members／secret path 建立段落。

## Vercel 部署

1. 將此資料夾作為獨立 Git repository 推到自己的 GitHub／GitLab。不要把整個磁碟根目錄上傳。
2. Vercel → Add New Project → Import 該 repository，Framework 選 Next.js。
3. Root Directory 使用本專案根目錄；Install Command 保留自動偵測，Build Command `pnpm build`，Node.js 選 24.x。
4. 在 Production（必要時 Preview）加入前述兩個環境變數，另加入 `ENABLE_EXPERIMENTAL_COREPACK=1`，讓 Vercel 使用 package.json 指定的 pnpm 版本。
5. Deploy，取得網域，接上 Supabase seed 回傳的秘密路徑。
6. 如果 Vercel 專案啟用了 Deployment Protection，正式群組使用的 Production 網域須允許朋友直接開啟；Preview 可以保留保護。
7. 先在兩支手機開啟同一個完整連結：一支新增測試帳，另一支應在約 3 秒內看見。新增／修改／刪除後檢查統計與結算，再開始使用。

也可在已登入的 Vercel CLI 使用 `vercel`／`vercel --prod`。本專案不包含你的雲端帳號憑證。沒有 Project URL、publishable key、Supabase schema 和 Vercel 專案時，無法從原始碼憑空提供可用的雲端網址。

## 秘密連結的安全模型

> 任何持有秘密連結的人都具備編輯權限，因此不要公開分享此網址。

- 連結是 capability：以兩個隨機 UUID 的高熵來源產生 64 字元 SHA-256 字串，不能使用流水號。
- 只有 `public.read_book(secret)` 與 `public.change_book(secret, revision, actor, action, data)` 開放 anon／authenticated 執行。兩者每次都驗證完整秘密 hash。
- 所有資料在 `ledger` 私有 schema；所有表啟用 RLS，無公開 policy，且撤銷匿名表格／內部函式權限。沒有「列出所有帳本」API。
- RPC 是刻意設計的 `SECURITY DEFINER` 安全入口，`search_path=''` 且全部物件明確指定 schema。每次 mutation 驗證 workspace／event／actor／關聯成員並在單一 transaction 完成。
- 前端身份只存在 localStorage，僅用於預設付款人和標記操作人。任何持有連結者均可選任何名字，**activity log 不是不可偽造的身份稽核**。
- 設定 `Referrer-Policy: no-referrer`、禁止 iframe、`noindex`，無分析追蹤、第三方字型或第三方圖片。不將秘密寫入活動紀錄。
- 銀行資料和帳本一起受秘密連結保護；畫面只顯示帳號末四碼，完整帳號僅在使用者按下複製時送進剪貼簿，不放入 URL、metadata、activity log 或瀏覽器 console。秘密連結持有人仍可透過受保護 RPC 取得帳本資料，因此連結不可公開。
- 網址仍存在瀏覽器歷史、可能存在代管平台 request logs。若有不信任的共用裝置或公開分享連結，請更換秘密。僅「有網址即可編輯」的產品本身不能區分善意與惡意持有人。
- 如需撤銷外流連結，在 SQL Editor 對目標 workspace 換掉 `secret_hash`，用新隨機秘密的 `sha256(convert_to(new_secret,'UTF8'))`；舊網址立即失效。不要透過匿名 API 開放輪替。
- 沒有公開建立 workspace 的 API，可避免任意訪客濫建帳本；帳本一次性由管理者 SQL 建立，之後朋友可自行建立任意活動。
- 無離線寫入：儲存成功一定已由雲端確認，失敗保留表單供重試，不假裝已同步。管理者應使用 Supabase 的備份能力並定期下載 CSV；CSV 是帳目資料匯出，不是完整資料庫備份。

## 資料一致性與同步

正規化資料表：`workspaces`、`members`、`events`、`event_members`、`expenses`、`expense_splits`、`settlements`、`activity_logs`。可選的銀行代碼、銀行名稱、銀行帳號存放在 `members.bank_code/bank_name/bank_account`；三者皆為 `text`，未提供時皆為 `null`，可保留前導零。

所有金額為整數新台幣元。一筆消費上限 NT$100,000,000、必須大於 0；自訂個別分攤可為 0，份數為 1～10,000。前端使用安全整數與 BigInt 比例運算，SQL 使用 integer／bigint。

- 雲端重新計算平均與份數分攤，**不信任前端提交的 share_amount**。自訂分攤必須總額相符。
- Deferred constraint triggers 在 transaction 結束時驗證每筆 expense 的 splits 合計，連直接管理 SQL 的不平衡修改也會拒絕。
- 外鍵保證付款／分攤／轉帳成員屬於該活動，並防止跨帳本資料串接。
- `change_book` 鎖住 workspace row，核對 revision，執行完整 mutation、紀錄 log、遞增 revision。任何一步失敗就 rollback。
- 表單保留開啟時的 revision，不會因背景同步悄悄前進。遇到衝突先保留輸入、同步最新狀態、顯示提醒；使用者確認後重按儲存才採用新 revision。
- `read_book` 用單一 SQL snapshot 回傳整本資料與 revision，避免金額與 revision 不一致。
- 每 3 秒讀取，同一本帳本所有朋友都使用相同雲端狀態；不將帳目保存在 localStorage。這是小團體 MVP，若日後累積大量活動，可加分頁／revision-only polling；目前讀取整本帳本是有意的簡化。

## 分攤與結算演算法

### 平均／份數

整數除法先取每個人的商，再把未分配的元數按餘數由大到小分配（largest remainder method）。餘數相同依六人的固定順序。平均分攤等同每人一份。

`100 / 3 → 34 + 33 + 33`。所有尾差在建帳時分配，結算階段永遠不會凭空增加或丟失 1 元。前端預覽與 SQL 使用相同 tie-breaking。

### 統計

`淨額 = 實際付款 − 應負擔`。正數為應收、負數為應付。統計頁的淨額不含朋友間轉帳，避免把轉帳當作旅行消費。

`剩餘淨額 = 淨額 + 已轉出 − 已轉入`。結算頁以剩餘淨額運算。六人中搜尋所有可清除至少一方餘額的債務人／債權人配對，選擇轉帳筆數最少的方案（最多 5 筆；全員為零則 0 筆）。六人規模可精確搜尋，不需只依最大餘額貪婪配對。

每次標記已付款記成一筆實際轉帳；伺服器檢查金額正數、不超過雙方目前應付／應收。它不會真的匯款。刪除或修改舊消費不會清除已付轉帳，若有人超付會提出退還方案。可取消誤標的付款。

### Demo 預期結果

| 成員      | 實際付款 | 應負擔 |       淨額 |
| --------- | -------: | -----: | ---------: |
| 🔥 厚諾   |    1,800 |  1,120 |   應收 680 |
| ⭐ 星醬   |    4,200 |  1,220 | 應收 2,980 |
| 💬 無語   |        0 |  1,100 | 應付 1,100 |
| 🦑 庫莫   |      480 |  1,120 |   應付 640 |
| 🥒 千瑾   |        0 |  1,000 | 應付 1,000 |
| 🐰 兔子草 |      310 |  1,230 |   應付 920 |

9/25 總額 **2,280**；9/26 **4,510**；活動合計 **6,790**。應收／應付皆 **3,660**，最少 **5** 筆轉帳。

## 測試與驗證

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm exec playwright install chromium
pnpm test:e2e
pnpm build
```

`pnpm test` 不需要雲端憑證；會在隔離的 PGlite PostgreSQL 引擎執行正式 migration 與 seed，驗證 RPC、金額限制、錯誤 rollback、RLS／權限、soft delete／restore、衝突、轉帳。計算測試包含 1,000 組守恆案例。

`pnpm test:e2e` 自動啟動 **僅限本機測試** 的 PostgreSQL HTTP adapter（127.0.0.1:54329）與 Next dev（127.0.0.1:3000），兩個 browser contexts 使用同一個真實 SQL 後端。測試完成後自動停止。adapter 位於 `scripts/test-server.mjs`，不在 Next 路由裡、不部署成公開 API、不使用 localStorage 存帳目。測試覆蓋手機輸入、桌面朋友看到變更、並行修改衝突、刪除 Undo、自訂驗證、份數、CSV、匯款資料遮罩與複製、未設定銀行資料、結清、重新整理後狀態、一人活動與橫向溢出。

本機 SQL 測試不等於已驗證你的 Supabase 專案設定或 Vercel production 帳號；正式部署後仍需以實際網域做雙手機驗收。

## 日後新增／修改成員

成員資料、顏色與銀行資料在資料庫，不硬編碼在 UI。用管理者 SQL 修改該 workspace 的 `ledger.members.name/icon/color/bank_code/bank_name/bank_account` 即可，舊帳目保持以相同 UUID 關聯。銀行三欄需一起設定或一起設為 `null`，帳號必須用引號包住的文字。`position` 決定顯示順序與尾差順序，不建議更動已使用的順序。

若要新增第七人，目前產品刻意限定六人，需同步調整 `change_book` 的 `members`／`splits` 長度上限，並重新評估精確結算搜尋的效能與測試。不要刪除已有消費／轉帳的成員；改名字不會斷開歷史關聯。活動可取消尚無歷史關聯的成員；回收區中的消費也會保留成員關聯，確保可復原。

## 參考文件

- [Supabase Database Functions](https://supabase.com/docs/guides/database/functions)
- [Supabase RLS](https://supabase.com/docs/guides/database/postgres/row-level-security)
- [Next.js Installation](https://nextjs.org/docs/app/getting-started/installation)

- [Vercel Package Managers](https://vercel.com/docs/package-managers)
- [Vercel Node.js Versions](https://vercel.com/docs/functions/runtimes/node-js/node-js-versions)

精確安裝版本記錄於 `pnpm-lock.yaml`。
