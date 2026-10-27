# 結算前個人消費明細確認

## 狀態與規則

每個活動同時最多一個 `open` 核對輪次。輪次最後會成為：

- `open`：帳務固定，等待確認、異議處理或期限到達。
- `settled`：已被一次正式結算消耗，不可重用。
- `canceled`：已取消，保留歷史；新輪次從新的 48 小時重新開始。

成員確認存在 `settlement_review_participants.confirmed_at`。未確認與逾期未確認都保持 `null`。異議獨立保存，只有提出者可撤回；撤回不會自動確認。臨時成員不建立 participant，但其消費與分攤包含在 `content_snapshot` 和正式結算中。

正式結算資格不是額外儲存的狀態，而是在操作當下由資料庫計算：輪次仍為 open、帳務內容等於本輪快照、沒有未撤回異議，並且全員已確認或資料庫時間已到 `deadline_at`。瀏覽器倒數只用於顯示。

付款提交後的 72 小時收款確認仍由原本 `settlements` 狀態機與排程處理，和本功能完全分開。

## 資料庫變更

新增 migration：`202610270001_pre_settlement_reviews.sql`。

新增私有表：

- `ledger.settlement_review_rounds`
- `ledger.settlement_review_participants`
- `ledger.settlement_review_disputes`

新增公開但必須帶秘密連結的 RPC：

- `start_settlement_review`
- `transition_settlement_review`
- `cancel_settlement_review`

既有 `start_settlement` 的名稱及參數不變，但會先執行新門檻。舊實作改名為無匿名執行權的 `start_settlement_v1`，只能由新 wrapper 在同一 transaction 內呼叫。內部表全部啟用 RLS，未新增 table policy，也未公開 `ledger` schema。

## 建議部署順序

本文件只描述順序；不要在未授權時執行正式部署。

1. 建立可還原的 Supabase 資料庫備份，記錄部署前 commit 與 migration 版本。
2. 宣告短暫「不可開始新結算」維護窗口；記帳及既有付款流程可保持運作。
3. 套用 `202610270001_pre_settlement_reviews.sql`。它只新增表、欄位、trigger 與 RPC，不改寫既有帳目或付款資料。
4. 立刻部署同一 commit 的前端。
5. 用隔離測試活動驗證：發起、兩個身份確認、提出／撤回異議、取消重開、正式結算。
6. 確認既有等待收款、72 小時自動確認與 proof cleanup 正常。

已正式結算、已付款及已結束的舊活動不會補建核對輪次。migration 後仍為 draft 的活動，在下一次正式結算前才需要核對。

## 安全回復

此功能的後端門檻不能只靠隱藏前端按鈕回復，否則會留下無法操作或可繞過的活動。

- 若前端顯示有問題：保留 migration 與資料庫門檻，回滾前端到可讀帳版本，暫停「發起確認／開始新結算」，修復後再部署。既有付款與 72 小時確認不受影響。
- 若某個 open 輪次需要解鎖：優先修復前端後，使用 `cancel_settlement_review` 正常取消；這會保留取消紀錄並恢復該活動編輯。不要直接刪除輪次。
- 若 migration 本身在套用時失敗：PostgreSQL migration transaction 應整體 rollback；檢查錯誤後修正 migration，不要部分手動建表。
- migration 已成功後不要 drop 新表或還原舊 `start_settlement`，那會移除門檻。採向前修復；必要時暫停新的核對與結算入口，保留所有輪次、帳目、正式快照及付款能力。

## 已知限制

- 「我是誰」仍是 localStorage 協作身份，不是強身份驗證。持有秘密連結者可能切換身份。
- 沒有 Email、LINE 或簡訊背景推播；「複製提醒訊息」只複製文字，不會自動傳送。
- 目前尚未提供正式結算後的補充結算批次 UI。歷史正式快照與付款不可覆寫。
