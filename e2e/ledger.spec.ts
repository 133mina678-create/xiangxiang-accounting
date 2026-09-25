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
  await page.getByRole("dialog").getByRole("button", { name: "厚諾" }).click();
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
  // Finish all transfers; status survives a reload.
  await page.getByRole("button", { name: "最後怎麼付？", exact: true }).click();
  for (let i = 0; i < 6; i++) {
    const button = page.getByRole("button", { name: "✓ 已付款", exact: true });
    if ((await button.count()) === 0) break;
    await button.first().click();
    await page.getByRole("button", { name: "確認", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
  }
  await expect(page.getByText("本次活動已全部結清！")).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: /台北三天兩夜/ }).click();
  await page.getByRole("button", { name: "最後怎麼付？", exact: true }).click();
  await expect(page.getByText("本次活動已全部結清！")).toBeVisible();
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
