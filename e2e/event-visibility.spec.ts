import { test, expect } from "@playwright/test";

test("活動只顯示給參加該活動的目前身份", async ({ page, request }) => {
  const { path } = await (
    await request.get("http://127.0.0.1:54329/test/book")
  ).json();
  await page.goto(path);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "厚諾", exact: false })
    .click();

  await page.getByRole("button", { name: "新增活動", exact: true }).click();
  await page.getByLabel("活動名稱", { exact: true }).fill("厚諾限定活動");
  for (const name of ["星醬", "無語", "庫莫", "千瑾", "兔子草"])
    await page
      .getByRole("dialog")
      .getByRole("button", { name, exact: false })
      .click();
  await page.getByRole("button", { name: "建立活動", exact: true }).click();

  const privateEvent = page.getByRole("button", { name: /厚諾限定活動/ });
  await expect(privateEvent).toBeVisible();
  await privateEvent.click();
  await expect(page.getByRole("heading", { name: "厚諾限定活動" })).toBeVisible();

  await page.getByRole("button", { name: "切換我是誰" }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "星醬", exact: false })
    .click();
  await expect(page.getByRole("heading", { name: "奶蛋香香的" })).toBeVisible();
  await expect(privateEvent).toHaveCount(0);

  await page.getByRole("button", { name: "切換我是誰" }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "厚諾", exact: false })
    .click();
  await expect(page.getByRole("heading", { name: "厚諾限定活動" })).toBeVisible();
  await page.getByRole("button", { name: "所有活動", exact: true }).click();
  await expect(privateEvent).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

