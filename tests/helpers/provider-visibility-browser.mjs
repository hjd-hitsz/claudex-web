import assert from "node:assert/strict";
import { join } from "node:path";
import { openSettingsPage, settingsBackend } from "./settings-navigation.mjs";

async function assertWholeRows(scroll, name, requireTopRow = false) {
  const area = await scroll.elementHandle();
  try {
    await scroll.page().waitForFunction(
      ({ viewport, requireTopRow }) => {
        const { top, bottom } = viewport.getBoundingClientRect();
        const visible = [...viewport.querySelectorAll("label")]
          .filter((option) => getComputedStyle(option).opacity !== "0")
          .map((label) => label.getBoundingClientRect())
          .filter((row) => row.bottom > top + 1 && row.top < bottom - 1);
        return (
          visible.length &&
          (!requireTopRow || visible[0].top <= top + 2) &&
          visible.every((row) => row.top >= top - 1 && row.bottom <= bottom + 1)
        );
      },
      { viewport: area, requireTopRow },
      { timeout: 5000 },
    );
  } catch (error) {
    throw new Error(name, { cause: error });
  } finally {
    await area.dispose();
  }
}

async function showModelFrame(frame) {
  await frame.evaluate((element) => {
    const pane = element.closest(".settings-body");
    const box = element.getBoundingClientRect();
    const viewport = pane.getBoundingClientRect();
    if (box.top < viewport.top + 4 || box.bottom > viewport.bottom - 4)
      pane.scrollTop += box.top - viewport.top - 8;
  });
}

export async function verifyProviderVisibility({ page, setZoom, output }) {
  const edit = (name) =>
    page
      .locator(".provider-entry")
      .filter({
        has: page
          .locator(".provider-identity")
          .getByText(name, { exact: true }),
      })
      .getByRole("button", { name: "编辑", exact: true });
  const form = page.locator(".settings-body .provider-editor:visible");
  const save = form.getByRole("button", { name: "保存供应商" });
  const cancel = form.getByRole("button", { name: "取消" });
  const scroll = form.locator(".provider-model-visibility-scroll");
  const modelArea = form.getByRole("group", { name: "显示的模型" });
  const frame = form.locator(".provider-model-visibility-frame");
  const status = modelArea.getByRole("status");
  const native = page
    .locator('.backend-card[data-backend="claude"]')
    .getByRole("region", { name: "显示的原生 Claude 模型" });
  const go = "OpenCode Go";
  const flash = form.getByRole("checkbox", {
    name: "DeepSeek Flash",
    exact: true,
  });
  const refresh = form.getByRole("button", { name: "刷新模型", exact: true });
  await edit("DeepSeek").click();
  assert.ok(
    await form.evaluate((editor) =>
      editor
        .querySelector(".provider-credentials")
        .nextElementSibling?.matches(".provider-model-visibility"),
    ),
  );
  await form.getByLabel("API Key").fill("fixture-key");
  await flash.uncheck();
  await page.evaluate(() => {
    window.fixtureCatalogueDelay = 180;
    window.fixtureModelDirectories = {
      deepseek: {
        models: ["deepseek-flash", "deepseek-v4-pro", "deepseek-cloud-added"],
        aliases: { "deepseek-cloud-added": "Cloud Added" },
      },
    };
  });
  await refresh.click();
  await form.getByText("正在刷新模型…", { exact: true }).waitFor();
  assert.ok(await refresh.isDisabled());
  await status.getByText("预览，保存后生效", { exact: true }).waitFor();
  assert.ok(
    await form
      .getByRole("checkbox", { name: "Cloud Added", exact: true })
      .isChecked(),
  );
  assert.equal(await flash.isChecked(), false);
  assert.equal(
    await page.evaluate(
      () =>
        fixtureRequests.findLast(
          ({ method }) => method === "lan/providers/refresh",
        ).params.apiKey,
    ),
    "fixture-key",
  );
  await page.evaluate(() => {
    window.fixtureCatalogueError = "模型目录认证失败（HTTP 401）";
  });
  await refresh.click();
  await form
    .getByRole("alert")
    .getByText("模型目录认证失败（HTTP 401）")
    .waitFor();
  await page.screenshot({ path: join(output, "refresh-error.png") });
  assert.ok(
    await form
      .getByRole("checkbox", { name: "Cloud Added", exact: true })
      .isChecked(),
  );
  assert.equal(await flash.isChecked(), false);
  await page.evaluate(() => {
    window.fixtureCatalogueError = "";
    window.fixtureCatalogueDelay = 0;
  });
  await refresh.click();
  await status.getByText("预览，保存后生效", { exact: true }).waitFor();
  await page.screenshot({ path: join(output, "refresh-preview.png") });
  await save.click();
  await form.waitFor({ state: "hidden" });
  await edit("DeepSeek").click();
  await page.waitForFunction(() =>
    fixtureCatalogueCalls.some(
      ({ id, source }) => id === "deepseek" && source === "saved",
    ),
  );
  await status.waitFor({ state: "hidden" });
  await cancel.click();
  await edit(go).click();
  await form.getByLabel("API Key").fill("fixture-go-key");
  await form
    .getByRole("checkbox", { name: "MiniMax-M3", exact: true })
    .uncheck();
  await save.click();
  await form.waitFor({ state: "hidden" });
  await edit(go).click();
  assert.equal(
    await form
      .getByRole("checkbox", { name: "MiniMax-M3", exact: true })
      .isChecked(),
    false,
  );
  await save.click();
  await form.waitFor({ state: "hidden" });
  const modelLabels = () =>
    page
      .getByRole("combobox", { name: "模型", exact: true })
      .locator("option")
      .allTextContents();
  await page.waitForFunction(() =>
    [...document.querySelectorAll('[aria-label="模型"] option')].some(
      (option) => option.textContent.includes("OpenCode Go/Beam Free"),
    ),
  );
  const configured = await modelLabels();
  assert.ok(configured.includes("DeepSeek/DeepSeek V4 Pro"));
  assert.ok(configured.includes("DeepSeek/Cloud Added"));
  assert.ok(!configured.includes("DeepSeek/DeepSeek Flash"));
  assert.ok(!configured.includes("OpenCode Go/MiniMax-M3"));
  await page.evaluate(() => {
    window.fixtureModelDirectories.deepseek = {
      models: ["deepseek-flash", "deepseek-v4-pro"],
    };
  });

  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const theme of ["light", "dark"]) {
      await page.evaluate(
        (theme) => (document.documentElement.dataset.theme = theme),
        theme,
      );
      for (const scale of [0.8, 1, 1.25, 1.5, 2]) {
        await setZoom(scale);
        const name = `${width}-${theme}-${scale}`;
        await openSettingsPage(page, "模型服务商");
        await edit("DeepSeek").click();
        await flash.waitFor();
        await modelArea.locator(".provider-model-option").nth(2).waitFor({
          state: "detached",
        });
        await status.waitFor({ state: "hidden" });
        assert.equal(await flash.isChecked(), false);
        const short = await modelArea.evaluate((group) => {
          const box = group.getBoundingClientRect();
          const items = [
            ...group.querySelectorAll(".provider-model-selection > *"),
          ];
          const centres = items.map((item) => {
            const { top, height } = item.getBoundingClientRect();
            return top + height / 2;
          });
          return {
            items: items.length,
            fits: items.every(
              (item) => item.getBoundingClientRect().right <= box.right + 1,
            ),
            inline: Math.max(...centres) - Math.min(...centres) <= 1,
            separated:
              parseFloat(getComputedStyle(items[1]).borderTopWidth) > 0,
            compact: items
              .slice(2)
              .every((item) => item.getBoundingClientRect().height <= 52),
          };
        });
        assert.ok(
          short.items === 4 && short.fits && short.separated && short.compact,
          JSON.stringify({ name, short }),
        );
        if (width === 1440 && scale === 1)
          assert.ok(short.inline, JSON.stringify({ name, short }));
        const geometry = await form
          .locator(".provider-credentials")
          .evaluate((row) => {
            const field = row.querySelector('[name="apiKey"]');
            const input = field.getBoundingClientRect();
            const label = row
              .querySelector(".provider-credential-key span")
              .getBoundingClientRect();
            const buttons = [...row.querySelectorAll("button")].map((button) =>
              button.getBoundingClientRect(),
            );
            const area = row.getBoundingClientRect();
            const center = (box) => box.top + box.height / 2;
            const style = getComputedStyle(field);
            const context = document.createElement("canvas").getContext("2d");
            context.font = style.font;
            const available =
              field.clientWidth -
              parseFloat(style.paddingLeft) -
              parseFloat(style.paddingRight);
            return {
              labelInline: Math.abs(center(input) - center(label)) < 1,
              buttonsInline: Math.abs(center(input) - center(buttons[0])) < 1,
              fullWidth: Math.abs(input.width - area.width) < 1,
              placeholderFits:
                available >= context.measureText(field.placeholder).width,
              fits: [input, label, ...buttons].every(
                (box) =>
                  box.left >= area.left - 1 && box.right <= area.right + 1,
              ),
              buttonHeight: Math.min(...buttons.map(({ height }) => height)),
            };
          });
        assert.ok(
          geometry.placeholderFits &&
            geometry.fits &&
            geometry.buttonHeight >= 30,
          JSON.stringify({ name, geometry }),
        );
        if (width === 1440)
          assert.ok(
            geometry.labelInline && geometry.buttonsInline,
            JSON.stringify({ name, geometry }),
          );
        const extremeNarrow = width === 390 && scale === 2;
        if (extremeNarrow) {
          assert.ok(
            !geometry.labelInline && geometry.fullWidth,
            JSON.stringify({ name, geometry }),
          );
        }
        await form.scrollIntoViewIfNeeded();
        if (extremeNarrow) await showModelFrame(modelArea);
        await page.screenshot({ path: join(output, `deepseek-${name}.png`) });
        await cancel.click();
        await edit(go).click();
        await frame.waitFor();
        await status.waitFor({ state: "hidden" });
        assert.equal(await scroll.getByRole("checkbox").count(), 31);
        assert.equal(
          await modelArea.getByRole("checkbox", { name: "全选" }).count(),
          1,
        );
        const grid = await scroll.evaluate((viewport) => {
          const list = viewport.firstElementChild;
          const options = [...list.querySelectorAll("label")];
          const lineCount = options.map((option) => {
            const text = document.createRange();
            text.selectNodeContents(option.querySelector("span"));
            return text.getClientRects().length;
          });
          const heights = options.map(
            (option) => option.getBoundingClientRect().height,
          );
          return {
            columns:
              getComputedStyle(list).gridTemplateColumns.split(" ").length,
            singleLines: lineCount.every((lines) => lines === 1),
            aligned: Math.max(...heights) - Math.min(...heights) <= 1,
            fits: viewport.scrollWidth <= viewport.clientWidth + 1,
            thinScrollbar: getComputedStyle(viewport).scrollbarWidth === "thin",
            more: viewport.parentElement.hasAttribute("data-more-below"),
          };
        });
        assert.ok(
          grid.fits && grid.thinScrollbar && grid.more,
          JSON.stringify({ name, grid }),
        );
        if (width === 1440)
          assert.ok(
            grid.columns >= 2 &&
              grid.columns <= 3 &&
              grid.singleLines &&
              grid.aligned,
            JSON.stringify({ name, grid }),
          );
        if (extremeNarrow) assert.equal(grid.columns, 1);
        assert.doesNotMatch(
          await modelArea.innerText(),
          /个模型|滚动查看|\d{4}\/\d+\/\d+/,
        );
        await assertWholeRows(scroll, `初始模型列表有半行，${name}`);
        await showModelFrame(frame);
        await page.screenshot({ path: join(output, `go-${name}.png`) });
        if (extremeNarrow || (width === 1440 && scale === 1)) {
          await scroll.evaluate(
            (viewport) => (viewport.scrollTop = viewport.scrollHeight / 2),
          );
          await assertWholeRows(scroll, `模型列表中间有半行，${name}`);
        }
        const last = scroll.getByRole("checkbox", {
          name: "HungerG Free",
          exact: true,
        });
        const longcat = scroll.getByRole("checkbox", {
          name: "LongCat-2.5",
          exact: true,
        });
        await last.uncheck();
        assert.equal(await last.isChecked(), false);
        assert.equal(await longcat.isChecked(), true);
        await scroll.evaluate(
          (viewport) => (viewport.scrollTop = viewport.scrollHeight),
        );
        await assertWholeRows(
          scroll,
          `模型列表末页有半行或留白，${name}`,
          true,
        );
        await frame
          .locator("xpath=self::*[@data-more-above and not(@data-more-below)]")
          .waitFor();
        await showModelFrame(frame);
        await page.screenshot({ path: join(output, `go-last-${name}.png`) });
        await cancel.click();
        await openSettingsPage(page, "后端");
        await settingsBackend(page, "Claude Code").click();
        await native
          .getByRole("checkbox", { name: "Claude Sonnet", exact: true })
          .waitFor();
        assert.equal(await native.getByRole("checkbox").count(), 3);
        await native.scrollIntoViewIfNeeded();
        await page.screenshot({
          path: join(output, `native-claude-${name}.png`),
        });
      }
    }
  }
  await native
    .getByRole("checkbox", { name: "Claude Sonnet", exact: true })
    .uncheck();
  await page.waitForFunction(() =>
    fixtureRequests.some(
      ({ method, params }) =>
        method === "lan/backends/save" &&
        params.hiddenModels?.includes("sonnet"),
    ),
  );
  await setZoom(1);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("button", { name: "关闭窗口", exact: true }).click();
  const after = await modelLabels();
  assert.ok(after.includes("OpenCode Go/Beam Free"));
  assert.ok(!after.includes("Claude/sonnet"));
  console.log(
    "PASS DeepSeek 同行表单、按供应商勾选与凭据保留、Go 模型目录、Claude 原生勾选及菜单隔离，桌面与窄屏深浅主题各五档缩放",
  );
}
