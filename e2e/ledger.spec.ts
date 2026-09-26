import { test, expect } from "@playwright/test";
test("手機完整流程、雙人同步、衝突、復原、自訂與份數、結清", async ({
  page,
  browser,
  request,
}) => {
  const { path } = await (
    await request.get("http://127.0.0.1:54329/test/book")
  ).json();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("requestfailed", (r) =>
    console.log("Request failed", r.url(), r.failure()),
  );
  page.on("console", (m) => {
    if (m.type() === "error") console.log(m.text());
  });
  await page.goto(path);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: "http://127.0.0.1:3000",
  });
  await expect(
    page.getByRole("dialog").getByRole("button", { name: "🥒 千瑾" }),
  ).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: "厚諾" }).click();
  await expect(page.getByRole("heading", { name: "奶蛋香香的" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: /香香的記帳本/ }),
  ).toBeVisible();
  await page.getByRole("button", { name: /台北三天兩夜/ }).click();
  await expect(page.getByTestId("event-total")).toHaveText("NT$ 6,790");
  await page.screenshot({
    path: "test-results/mobile-ledger.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "統計", exact: true }).click();
  await expect(page.getByText("應收", { exact: true })).toHaveCount(2);
  await page.getByLabel("統計範圍").selectOption("2026-09-25");
  await expect(page.getByText("NT$ 2,280", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "帳目", exact: true }).click();
  const second = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  });
  const friend = await second.newPage();
  await friend.goto(path);
  await friend
    .getByRole("dialog")
    .getByRole("button", { name: "星醬" })
    .click();
  await friend.getByRole("button", { name: /台北三天兩夜/ }).click();
  await friend.screenshot({
    path: "test-results/desktop-ledger.png",
    fullPage: true,
  });
  await friend
    .getByRole("button", { name: "最後怎麼付？", exact: true })
    .click();
  await expect(friend.getByText("822 中國信託", { exact: true })).toBeVisible();
  await friend.screenshot({
    path: "test-results/desktop-settlement.png",
    fullPage: true,
  });
  expect(
    await friend.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await friend.getByRole("button", { name: "帳目", exact: true }).click();
  await page.getByRole("button", { name: "新增消費", exact: true }).click();
  await page.getByLabel("消費金額", { exact: true }).fill("100");
  await page.getByLabel("備註（選填）", { exact: true }).fill("測試點心");
  await page.getByRole("button", { name: "儲存消費", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(friend.getByRole("button", { name: /測試點心/ })).toBeVisible({
    timeout: 10000,
  });
  await expect(friend.getByTestId("event-total")).toHaveText("NT$ 6,890");
  // Both edit the same record. Polling must not advance the form's base revision.
  await page.getByRole("button", { name: /測試點心/ }).click();
  await page.getByRole("button", { name: "修改", exact: true }).click();
  await friend.getByRole("button", { name: /測試點心/ }).click();
  await friend.getByRole("button", { name: "修改", exact: true }).click();
  await page.getByLabel("消費金額", { exact: true }).fill("120");
  await page.getByRole("button", { name: "儲存修改", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(friend.getByTestId("event-total")).toHaveText("NT$ 6,910", {
    timeout: 10000,
  });
  await friend.getByLabel("消費金額", { exact: true }).fill("150");
  await friend.getByRole("button", { name: "儲存修改", exact: true }).click();
  await expect(friend.getByRole("dialog").getByRole("alert")).toContainText(
    "朋友剛更新",
  );
  await friend.getByRole("button", { name: "關閉", exact: true }).click();
  // Confirm delete, then restore through undo.
  await page.getByRole("button", { name: /測試點心/ }).click();
  await page.getByRole("button", { name: "刪除", exact: true }).click();
  await page.getByRole("button", { name: "確認", exact: true }).click();
  await expect(page.getByRole("button", { name: /測試點心/ })).toHaveCount(0);
  await page.getByRole("button", { name: "復原 Undo" }).click();
  await expect(page.getByRole("button", { name: /測試點心/ })).toBeVisible();
  // Custom mode rejects mismatch, allows zero share, then weighted edit.
  await page.getByRole("button", { name: /測試點心/ }).click();
  await page.getByRole("button", { name: "修改", exact: true }).click();
  await page
    .getByRole("combobox", { name: "分攤方式", exact: true })
    .selectOption("custom");
  await page.getByLabel("厚諾分攤金額").fill("21");
  await expect(page.getByRole("button", { name: "儲存修改" })).toBeDisabled();
  await page.getByLabel("厚諾分攤金額").fill("20");
  await page.getByRole("button", { name: "儲存修改" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: /測試點心/ }).click();
  await page.getByRole("button", { name: "修改", exact: true }).click();
  await page
    .getByRole("combobox", { name: "分攤方式", exact: true })
    .selectOption("weighted");
  await page.getByLabel("厚諾份數").fill("2");
  await page.getByRole("button", { name: "儲存修改" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  // CSV.
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "匯出 CSV" }).click();
  expect((await download).suggestedFilename()).toContain("台北三天兩夜");
  // A payer uploads one proof, the recipient can dispute, then confirm a
  // replacement proof. Settlement amounts and bank-copy behavior stay intact.
  await page.getByRole("button", { name: "最後怎麼付？", exact: true }).click();
  const hounuoTransfer = page
    .getByTestId("transfer-card")
    .filter({ hasText: "822 中國信託" })
    .first();
  await expect(hounuoTransfer).toContainText("•••• •••• 4361");
  await expect(hounuoTransfer).not.toContainText("078540354361");
  await page.screenshot({
    path: "test-results/mobile-settlement.png",
    fullPage: true,
  });
  await hounuoTransfer.getByRole("button", { name: "複製帳號" }).click();
  await expect(
    hounuoTransfer.getByRole("button", { name: "已複製" }),
  ).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    "078540354361",
  );
  await expect(page.getByRole("status")).toContainText("已複製厚諾的匯款帳號");
  await expect(
    hounuoTransfer.getByRole("button", { name: "複製匯款資訊" }),
  ).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  const pendingCard = page.getByTestId("transfer-card").first();
  const transferLabel = (await pendingCard.getAttribute("aria-label"))!;
  const [transferPayer, transferRecipient] = transferLabel.split("匯款給");
  const selectIdentity = async (name: string) => {
    await page.getByRole("button", { name: "切換我是誰" }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name, exact: false })
      .click();
  };
  await selectIdentity(transferPayer);
  await pendingCard.getByRole("button", { name: "我已轉帳" }).click();
  const proofPng = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQMcAAAAASUVORK5CYII=",
    "base64",
  );
  await page.getByLabel("選擇轉帳證明圖片").setInputFiles({
    name: "proof.png",
    mimeType: "image/png",
    buffer: proofPng,
  });
  await expect(page.getByAltText("待上傳的轉帳證明預覽")).toBeVisible();
  await page.getByRole("button", { name: "確認提交" }).click();
  await expect(page.getByText("等待收款人確認", { exact: true })).toBeVisible();
  const activeCard = page
    .getByTestId("settlement-card")
    .filter({ hasText: transferPayer })
    .filter({ hasText: transferRecipient })
    .first();
  await selectIdentity(transferRecipient);
  await activeCard.getByRole("button", { name: "查看轉帳證明" }).click();
  await expect(page.getByAltText("轉帳證明", { exact: true })).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: "關閉" }).click();
  await activeCard.getByRole("button", { name: "尚未收到" }).click();
  await page.getByRole("button", { name: "確認", exact: true }).click();
  await expect(page.getByText("尚未收到／有問題", { exact: true })).toBeVisible();
  await expect(activeCard.getByText("自動確認已暫停", { exact: false })).toBeVisible();
  await selectIdentity(transferPayer);
  await activeCard.getByRole("button", { name: "重新上傳證明" }).click();
  await page.getByLabel("選擇轉帳證明圖片").setInputFiles({
    name: "replacement.png",
    mimeType: "image/png",
    buffer: proofPng,
  });
  await page.getByRole("button", { name: "確認提交" }).click();
  await expect(page.getByText("等待收款人確認", { exact: true })).toBeVisible();
  await selectIdentity(transferRecipient);
  await activeCard.getByRole("button", { name: "確認收到" }).click();
  await expect(page.getByText(/確定已收到 NT\$/)).toBeVisible();
  await page.getByRole("button", { name: "確認", exact: true }).click();
  await expect(activeCard.getByText("已確認", { exact: true })).toBeVisible();
  await expect(activeCard.getByText("轉帳證明已依隱私設計刪除。", { exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: /台北三天兩夜/ }).click();
  await page.getByRole("button", { name: "最後怎麼付？", exact: true }).click();
  await expect(page.getByText("已確認", { exact: true })).toBeVisible();
  // A recipient without bank details stays in settlement and has no copy action.
  await page.getByRole("button", { name: "所有活動", exact: true }).click();
  await page.getByRole("button", { name: "新增活動", exact: true }).click();
  await page.getByLabel("活動名稱").fill("兔子收款測試");
  for (const name of ["星醬", "無語", "庫莫", "千瑾"])
    await page
      .getByRole("dialog")
      .getByRole("button", { name, exact: false })
      .click();
  await page.getByRole("button", { name: "建立活動", exact: true }).click();
  await page.getByRole("button", { name: /兔子收款測試/ }).click();
  await page.getByRole("button", { name: "新增消費", exact: true }).click();
  await page.getByLabel("消費金額", { exact: true }).fill("100");
  await page
    .getByRole("group", { name: "誰先付款？" })
    .getByRole("button", { name: /兔子草/ })
    .click();
  await page.getByRole("button", { name: "儲存消費", exact: true }).click();
  await page.getByRole("button", { name: "最後怎麼付？", exact: true }).click();
  const rabbitTransfer = page.getByTestId("transfer-card").filter({
    hasText: "尚未提供匯款資料",
  });
  await expect(rabbitTransfer).toContainText("兔子草");
  await expect(
    rabbitTransfer.getByRole("button", { name: /複製/ }),
  ).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  // New single-person event.
  await page.getByRole("button", { name: "所有活動", exact: true }).click();
  await page.getByRole("button", { name: "新增活動", exact: true }).click();
  await page.getByLabel("活動名稱").fill("一個人的咖啡");
  for (const name of ["星醬", "無語", "庫莫", "千瑾", "兔子草"])
    await page
      .getByRole("dialog")
      .getByRole("button", { name, exact: false })
      .click();
  await page.getByRole("button", { name: "建立活動", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: /一個人的咖啡/ }).click();
  await page.getByRole("button", { name: "新增消費", exact: true }).click();
  await page.getByLabel("消費金額", { exact: true }).fill("60");
  await page.getByRole("button", { name: "儲存消費", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "最後怎麼付？", exact: true }).click();
  await expect(page.getByText("本次活動已全部結清！")).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
  await second.close();
});
