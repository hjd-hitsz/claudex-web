import assert from "node:assert/strict";
import { delegationNotice } from "../../server/src/backends/agy/delegation-delivery.mjs";
import { saveDelegationResults } from "../../server/src/backends/delegation/delegation-results.mjs";
import { delegationSummaries } from "../../server/src/backends/delegation/delivery-summary.mjs";

const triggers = [
  "运行 Claudex 全量检查",
  "回归 Antigravity 与原生委派回投",
  "核对生产构建中的静态资源、字体文件与浏览器按需加载的模块",
  "验证发行包安装及命令入口",
  "检查后台终端任务的原生完成通知",
  "核对网页结果卡片的预览和执行记录",
  "复查深浅主题与手机窄屏排版",
].map((title, index) => ({
  kind: "completion",
  title,
  id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
}));
const heading = "后台终端完成 · 7 项";
const details = triggers.map(({ title, id }) => `${title}（ID ${id}）`);

export function delegationResultFixture() {
  const dispatch = "已核对两份原生文件，证据可在执行记录中查阅。";
  const followUp = "后台检查通过，构建产物齐全。";
  const step = {
    id: "step-one",
    taskSummary: "核对报告的技术依据",
    stopRequested: true,
  };
  const task = { id: "demo", target: "codex", steps: [step] };
  const data = { notices: {} };
  saveDelegationResults(data, task, {
    pending: false,
    stages: [dispatch, followUp].map((answer, index) => ({
      turnId: index === 0 ? "native-turn" : "native-follow-up",
      status: "completed",
      triggers: index === 0 ? [] : triggers,
      answer,
      conclusion: answer,
      evidence: [],
      artifacts: [],
    })),
    context: { usedTokens: 120, totalTokens: 200, compactCount: 1 },
  });
  const notice = data.notices["step-one:result"];
  const { items, prompt } = delegationNotice(notice, task);
  return {
    dispatch,
    followUp,
    item: items[0],
    summaries: delegationSummaries(task.steps),
    payload: JSON.parse(prompt[0].text.split("\n").at(-1)),
  };
}

export async function testDelegationResult({
  page,
  context,
  output,
  delivery,
}) {
  const { dispatch, followUp, payload } = delivery;
  assert.equal(
    payload.answer,
    `## 派单轮答复\n\n${dispatch}\n\n## ${heading}\n\n${details.map((detail) => `- ${detail}`).join("\n")}\n\n${followUp}`,
  );
  const card = page.locator(".delegation-result");
  const entry = card.getByRole("button", { name: "查看执行记录" });
  const execution = page.getByRole("region", { name: "Codex 委派对话" });
  const back = page.getByRole("button", { name: "返回概览", exact: true });
  const take = (name) =>
    page.screenshot({
      path: new URL(`delegation-return-${name}.png`, output).pathname,
      animations: "disabled",
    });
  async function checkPreview() {
    const preview = card.locator(".delivery-summary-preview");
    await preview.waitFor();
    assert.equal(await preview.textContent(), payload.preview);
    assert.equal(payload.preview, dispatch);
    await entry.focus();
    assert.equal(
      await entry.evaluate((el) => el === document.activeElement),
      true,
    );
  }
  async function openRenderedResult() {
    await entry.press("Enter");
    await execution.getByText(dispatch, { exact: true }).waitFor();
    await execution.getByText(followUp, { exact: true }).waitFor();
    await execution.locator("summary").filter({ hasText: "工作过程" }).click();
    await execution
      .getByRole("button", { name: "工具结果 · 委派回投正文" })
      .click();
    const title = execution.getByRole("heading", {
      name: heading,
      exact: true,
    });
    await title.waitFor();
    const markdown = title.locator("..");
    const result = await markdown.evaluate((el) => {
      const children = [...el.children];
      const list = children[3];
      return {
        structure: children.map(({ tagName }) => tagName),
        dispatch: children[1].textContent,
        followUp: children[4].textContent,
        details: [...list.children].map(({ textContent }) => textContent),
        overflow: [el, ...children, ...list.children]
          .filter((node) => node.scrollWidth > node.clientWidth + 1)
          .map(({ tagName, clientWidth, scrollWidth }) => ({
            tagName,
            clientWidth,
            scrollWidth,
          })),
        wrapped: [...list.children].some((node) => {
          const range = document.createRange();
          range.selectNodeContents(node);
          return range.getClientRects().length > 1;
        }),
      };
    });
    assert.deepEqual(result.structure, ["H2", "P", "H2", "UL", "P"]);
    assert.equal(result.dispatch, dispatch);
    assert.equal(result.followUp, followUp);
    assert.deepEqual(result.details, details);
    assert.deepEqual(result.overflow, []);
    return { markdown, wrapped: result.wrapped };
  }
  for (const theme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: theme });
    await page.reload();
    await checkPreview();
    await take("card-" + theme);
    await entry.press("Enter");
    await execution.getByText(dispatch, { exact: true }).waitFor();
    await execution.getByText(followUp, { exact: true }).waitFor();
    await take("details-" + theme);
    await back.click();
  }

  const appearance = await context.newPage();
  await appearance.goto("chrome://settings/appearance");
  const zoom = appearance.locator("#zoomLevel");
  await zoom.waitFor();
  try {
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 980 });
      for (const theme of ["light", "dark"]) {
        await page.emulateMedia({ colorScheme: theme });
        for (const scale of [0.8, 1, 1.25, 1.5, 2]) {
          await zoom.selectOption(String(scale));
          await page.reload();
          await checkPreview();
          const {
            dpr,
            width: viewport,
            button,
          } = await entry.evaluate((el) => ({
            dpr: devicePixelRatio,
            width: innerWidth,
            button: el.getBoundingClientRect().toJSON(),
          }));
          assert.ok(Math.abs(dpr - scale) < 0.02);
          assert.ok(Math.abs(viewport - width / scale) <= 1);
          assert.ok(button.left >= 0 && button.right <= viewport + 1);
          if (width === 390 && scale === 1) await take("mobile-" + theme);
          const { markdown, wrapped } = await openRenderedResult();
          if (width === 390) assert.ok(wrapped);
          if (scale === 1) {
            await markdown.evaluate((el) =>
              el.scrollIntoView({ block: "center" }),
            );
            await take(`markdown-${width}-${theme}`);
          }
          await back.click();
        }
      }
    }
  } finally {
    await zoom.selectOption("1");
    await appearance.close();
    await page.setViewportSize({ width: 1440, height: 980 });
    await page.emulateMedia({ colorScheme: "light" });
    await page.reload();
  }
  console.log(
    "PASS 回投卡片预览与执行记录通过，工具结果的标题、7 条明细、正文与换行通过 20 组主题和实际缩放检查",
  );
}
