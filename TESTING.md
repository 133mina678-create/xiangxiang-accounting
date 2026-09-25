# 驗收紀錄

環境：Windows、Node.js 24.19.0。測試使用隔離的 PostgreSQL（PGlite）與 Chromium，未連接使用者的雲端帳號。

## 自動化驗證

- Vitest：41 個測試通過，含 1,000 組整數分攤／結算守恆案例。
- 正式 migration 與 seed 在 PostgreSQL 引擎完整執行。
- 驗證匿名能用正確秘密 RPC，不能直接列出私有表格；錯誤秘密拒絕。
- 驗證失敗的自訂金額、非法日期、非法身份、過期 revision 會 rollback。
- 驗證 SQL 重算平均分攤，不信任偽造 share_amount。
- Playwright：手機 390×844＋桌面 1280×900，兩個獨立 browser contexts 共用 SQL 後端。
- UI 流程：選身份 → Demo → 每日統計 → 新增 → 另一端同步 → 同時修改衝突 → 刪除確認 → Undo → 自訂驗證 → 份數分攤 → CSV → 逐筆結清 → 重新整理保持付款狀態 → 建立一人活動 → 記帳並結清。
- 手機頁面無橫向溢出，無 browser runtime exception。
- ESLint、TypeScript、Next.js production build 均執行驗證。

## 已檢查畫面

手機與桌面活動帳目頁已截圖檢查。Playwright 在 `test-results` 產生圖片／失敗 trace；此目錄不納入版本控制。

## 尚需在正式雲端驗收

使用者已建立 Supabase 與 GitHub repository，但尚未提供 Project URL／publishable key，且本機沒有雲端管理憑證，因此 **未宣稱已完成雲端部署**，亦未驗證實際 Supabase PostgREST 設定、代管網域或真實手机網路。正式部署依 README 設定後，應以兩支手機打開同一秘密網址完成一次新增／同步／結算驗收。

本機測試 adapter 不會隨 Next.js app 暴露成 HTTP 路由。它只供驗收，不能替代正式雲端資料庫。

新增驗證：兩個 migration 依序套用、SQL Editor seed 最後回傳秘密路徑、匿名 RPC 寫入、跨帳本隔離、七項 RLS／函式權限檢查、Vercel 拒絕缺漏設定與管理員 key。
