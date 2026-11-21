import assert from "node:assert/strict";
import { settingsPage } from "../helpers/settings-navigation.mjs";

async function focused(locator) {
  await locator.and(locator.page().locator(":focus")).waitFor();
}

export async function verifyShellInteractions(page, capture) {
  const settings = page.getByRole("button", { name: "设置", exact: true });
  const dialog = page.getByRole("dialog", { name: "设置", exact: true });
  const close = dialog.getByRole("button", { name: "关闭窗口" });
  const general = settingsPage(page, "通用");
  await settings.focus();
  await page.keyboard.press("Enter");
  await focused(general);
  assert.ok(await dialog.evaluate((element) => element.matches(":modal")));

  await page.keyboard.press("Shift+Tab");
  assert.ok(
    await dialog.evaluate(
      (element) =>
        element.contains(document.activeElement) ||
        document.activeElement === document.body,
    ),
  );
  await close.focus();
  await capture("settings-keyboard-focus");
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  await focused(settings);

  const contextTrigger = page.getByRole("button", { name: "展开对话详情" });
  const details = page.getByRole("region", { name: "对话功能", exact: true });
  const contextBounds = await contextTrigger.boundingBox();
  const contextPoint = {
    x: contextBounds.x + contextBounds.width / 2,
    y: contextBounds.y + contextBounds.height / 2,
  };
  await settings.click();
  const initialWidth = (await dialog.boundingBox()).width;
  const resizeHandle = dialog.getByRole("button", { name: "调整窗口大小" });
  await resizeHandle.press("ArrowLeft");
  const resizedWidth = (await dialog.boundingBox()).width;
  assert.ok(resizedWidth < initialWidth);
  await page.mouse.click(contextPoint.x, contextPoint.y);
  await dialog.waitFor({ state: "hidden" });
  assert.equal(await details.isVisible(), false);
  await focused(settings);

  await settings.click();
  await focused(general);
  assert.ok(Math.abs((await dialog.boundingBox()).width - resizedWidth) < 1);
  await resizeHandle.press("Home");
  assert.ok(Math.abs((await dialog.boundingBox()).width - initialWidth) < 1);
  await close.click();
  await focused(settings);

  const actions = page.getByRole("button", { name: "对话操作", exact: true });
  const menu = page.getByRole("menu");
  await actions.focus();
  await page.keyboard.press("Enter");
  await menu.waitFor();
  await capture("thread-actions-open");
  await page.keyboard.press("Tab");
  await focused(menu.getByRole("button", { name: "重命名" }));
  await page.keyboard.press("Escape");
  await menu.waitFor({ state: "hidden" });
  await focused(actions);

  await actions.click();
  await menu.waitFor();
  await page.mouse.click(contextPoint.x, contextPoint.y);
  await menu.waitFor({ state: "hidden" });
  await details.waitFor();
  await page.getByRole("button", { name: "折叠对话详情" }).click();

  const sidebar = page.locator("#project-sidebar");
  const show = page.getByRole("button", { name: "显示侧栏", exact: true });
  const hide = sidebar.getByRole("button", {
    name: "收起侧栏",
    exact: true,
  });
  const desktop = page.viewportSize();
  await hide.click();
  await sidebar.waitFor({ state: "hidden" });
  await focused(show);
  await show.click();
  await sidebar.waitFor();

  await page.setViewportSize({ width: 390, height: 844 });
  await sidebar.waitFor({ state: "hidden" });
  await show.click();
  await hide.waitFor();
  await capture("mobile-drawer-open");
  await settings.click();
  await focused(general);
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  await focused(settings);
  assert.ok(await hide.isVisible());
  await hide.focus();
  await page.keyboard.press("Escape");
  await sidebar.waitFor({ state: "hidden" });
  await focused(show);
  await page.setViewportSize(desktop);
  await sidebar.waitFor();
  assert.equal(await show.isVisible(), false);

  const portrait = { width: 1200, height: 1500 };
  await hide.focus();
  await page.setViewportSize(portrait);
  await sidebar.waitFor({ state: "hidden" });
  await focused(show);
  await page.reload();
  await page.locator(".user-bubble").waitFor();
  await show.waitFor();
  assert.equal(await sidebar.isVisible(), false);
  assert.equal(await sidebar.locator(":focus").count(), 0);

  for (const colorScheme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme });
    await capture(`portrait-${colorScheme}-collapsed`);
    await show.click();
    await sidebar.waitFor();
    assert.equal(
      await sidebar.evaluate((el) => getComputedStyle(el).position),
      "relative",
    );
    await capture(`portrait-${colorScheme}-expanded`);
    await hide.click();
    await sidebar.waitFor({ state: "hidden" });
    await focused(show);
  }
  await page.emulateMedia({ colorScheme: "light" });

  await show.click();
  await page.setViewportSize({ width: 390, height: 844 });
  await sidebar.waitFor({ state: "hidden" });
  await page.setViewportSize(portrait);
  await sidebar.waitFor();
  await page.setViewportSize(desktop);
  await sidebar.waitFor();
  await hide.click();
  await page.setViewportSize(portrait);
  await sidebar.waitFor();
  await page.setViewportSize(desktop);
  await sidebar.waitFor({ state: "hidden" });
  await show.click();
}

export async function verifyZoomedSearchDialog(page, capture) {
  const search = page.getByRole("dialog", { name: "搜索对话", exact: true });
  await page.keyboard.press("Control+k");
  await focused(search.getByPlaceholder("按标题或内容搜索对话"));
  const fits = await search.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return (
      bounds.left >= 0 &&
      bounds.top >= 0 &&
      bounds.right <= innerWidth &&
      bounds.bottom <= innerHeight
    );
  });
  assert.ok(fits);
  await capture?.();
  await page.keyboard.press("Escape");
  await search.waitFor({ state: "hidden" });
}
