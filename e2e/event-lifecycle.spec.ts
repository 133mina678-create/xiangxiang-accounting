import { test, expect } from "@playwright/test";
test("奶油 UI 響應式與管理刪除還原", async ({ page, request }) => {
  const { path } = await (
    await request.get("http://127.0.0.1:54329/test/book")
  ).json();
  await page.goto(path);
  await page.getByRole("dialog").getByRole("button", { name: "厚諾" }).click();
  for (const width of [320, 375, 390, 430, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }
  await page.setViewportSize({ width: 375, height: 844 });
  await page.screenshot({
    path: "test-results/cream-home.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "新增活動", exact: true }).click();
  await page.getByLabel("活動名稱").fill("安全刪除測試");
  await page.getByRole("button", { name: "建立活動", exact: true }).click();
  await page.getByRole("button", { name: /安全刪除測試/ }).click();
  await page.getByRole("button", { name: "帳本設定", exact: true }).click();
  await page.getByRole("button", { name: "刪除活動", exact: true }).click();
  await page
    .getByLabel("活動管理密碼", { exact: true })
    .fill("incorrect-password");
  await page.getByRole("button", { name: "移至最近刪除", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText(
    "不正確",
  );
  await page
    .getByLabel("活動管理密碼", { exact: true })
    .fill("local-test-admin-secret");
  await page.getByRole("button", { name: "移至最近刪除", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /安全刪除測試/ })).toHaveCount(
    0,
  );
  await page.getByRole("button", { name: /最近刪除/ }).click();
  await expect(page.getByRole("dialog")).toContainText("安全刪除測試");
  await page.getByRole("button", { name: "還原活動", exact: true }).click();
  await page
    .getByLabel("活動管理密碼", { exact: true })
    .fill("local-test-admin-secret");
  await page.getByRole("button", { name: "還原活動", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: /安全刪除測試/ }),
  ).toBeVisible();
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(
    await page
      .locator(".event-card")
      .first()
      .evaluate((e) => getComputedStyle(e).animationName),
  ).toBe("none");
  await page.getByRole("button", { name: /台北三天兩夜/ }).click();
  for (const tab of ["帳目", "統計", "最後怎麼付？"]) {
    await page.getByRole("button", { name: tab, exact: true }).click();
    for (const width of [320, 375, 390, 430, 768, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        tab + " " + width,
      ).toBe(true);
    }
  }
  await page.setViewportSize({ width: 375, height: 844 });
  await page.screenshot({
    path: "test-results/cream-settlement.png",
    fullPage: true,
  });
});
