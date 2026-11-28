import assert from "node:assert/strict";

export async function testDelegationList({ page, context, output }) {
  const list = page.locator(".context-agent-list");
  const region = page.getByRole("region", { name: "Codex 委派对话" });
  const button = (name) => page.getByRole("button", { name, exact: true });
  const back = button("返回概览");
  const open = button("展开对话详情");
  const close = button("折叠对话详情");
  const take = (name) =>
    page.screenshot({
      path: new URL("delegation-list-" + name + ".png", output).pathname,
      animations: "disabled",
    });
  async function overview() {
    if (await back.isVisible()) await back.click();
    if (await open.isVisible()) await open.click();
    await list.getByText("核对报告的技术依据", { exact: true }).waitFor();
  }
  async function checkLayout() {
    const widths = await list.evaluate((element) => {
      const long = [...element.querySelectorAll("b")].find((entry) =>
        entry.textContent.startsWith("检查生产构建"),
      );
      const status = long.closest("button").querySelector("[data-status]");
      return {
        clipped: long.scrollWidth > long.clientWidth,
        ellipsis: getComputedStyle(long).textOverflow,
        singleLine: getComputedStyle(long).whiteSpace,
        contained:
          status.getBoundingClientRect().right <=
            long.closest("button").getBoundingClientRect().right &&
          element.scrollWidth === element.clientWidth &&
          document.documentElement.scrollWidth <= innerWidth + 1,
      };
    });
    assert.deepEqual(widths, {
      clipped: true,
      ellipsis: "ellipsis",
      singleLine: "nowrap",
      contained: true,
    });
  }
  await overview();
  assert.equal(await list.getByRole("button").count(), 5);
  assert.equal(
    await list.getByRole("button").first().locator("b").textContent(),
    "复核网页空闲重启流程",
  );
  await list.getByText("运行中", { exact: true }).waitFor();
  await list.getByText("执行失败", { exact: true }).waitFor();
  await checkLayout();
  for (const [id, answer] of [
    ["249f3dc0", "发行包甲的依赖已核对"],
    ["616ed4bf", "发行包乙缺少依赖"],
  ]) {
    await list
      .getByRole("button", { name: new RegExp("检查发行包依赖.*" + id) })
      .click();
    await region.getByText(answer, { exact: true }).waitFor();
    await overview();
  }
  for (const theme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: theme });
    await take("desktop-" + theme);
  }

  const zoomPage = await context.newPage();
  await zoomPage.goto("chrome://settings/appearance");
  const zoom = zoomPage.locator("#zoomLevel");
  await zoom.waitFor();
  try {
    for (const scale of [0.8, 1, 1.25, 1.5, 2]) {
      await zoom.selectOption(String(scale));
      await page.reload();
      await overview();
      const metrics = await page.evaluate(() => ({
        dpr: devicePixelRatio,
        width: innerWidth,
      }));
      assert.ok(Math.abs(metrics.dpr - scale) < 0.02, JSON.stringify(metrics));
      assert.ok(
        Math.abs(metrics.width - 1440 / scale) <= 1,
        JSON.stringify(metrics),
      );
      await checkLayout();
      if (scale >= 1.5) await take("zoom-" + scale * 100);
    }
  } finally {
    await zoom.selectOption("1");
    await zoomPage.close();
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  const showSidebar = button("显示侧栏");
  await showSidebar.click();
  await page.waitForFunction(
    () =>
      Math.abs(
        document.querySelector(".sidebar").getBoundingClientRect().left,
      ) < 1,
  );
  await take("mobile-sidebar-open");
  await button("收起侧栏").click();
  await page.waitForFunction(
    () => !document.activeElement?.closest(".sidebar"),
  );
  await overview();
  await checkLayout();
  await take("mobile-details-open");
  await close.click();
  await list.waitFor({ state: "hidden" });
  assert.equal(await open.getAttribute("aria-expanded"), "false");
  await take("mobile-details-closed");
  await page.setViewportSize({ width: 1440, height: 980 });
  await page.emulateMedia({ colorScheme: "light" });
  await overview();
  console.log(
    "PASS 委派列表标题、旧记录、同名任务跳转、状态、刷新、主题、窄屏和真实页面缩放",
  );
}
