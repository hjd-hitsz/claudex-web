import assert from "node:assert/strict";

export async function testElicitation({ page, output }) {
  const form = {
    mode: "form",
    serverName: "发布清单",
    message: "选择本次预览的发布范围。提交后会生成核对清单。",
    requestedSchema: {
      type: "object",
      required: ["label", "preview"],
      properties: {
        label: { type: "string", title: "清单名称", minLength: 2 },
        limit: { type: "integer", title: "最多条目", default: 10, minimum: 1 },
        preview: { type: "boolean", title: "只生成预览", default: true },
        audience: {
          type: "string",
          title: "发布范围",
          oneOf: [
            { const: "team", title: "项目组" },
            { const: "private", title: "仅自己" },
          ],
        },
        sections: {
          type: "array",
          title: "包含内容",
          minItems: 1,
          default: ["summary"],
          items: {
            type: "string",
            anyOf: [
              { const: "summary", title: "变更摘要" },
              { const: "validation", title: "验证结果" },
            ],
          },
        },
      },
    },
  };
  const auth = {
    mode: "url",
    serverName: "报告归档",
    message: "在归档服务完成授权，然后返回此对话继续。",
    url: "https://archive.example.test/connect",
    elicitationId: "archive-auth",
  };
  const show = (id, request) =>
    page.evaluate(
      ([id, request]) => window.showFixtureElicitation(id, request),
      [id, request],
    );
  const card = page.locator(".elicitation-card");
  const submission = (id) =>
    page.evaluate(
      (requestId) =>
        window.fixtureRequests.find(
          (entry) => entry.params.requestId === requestId,
        )?.params.result,
      id,
    );
  async function shot(name) {
    await card.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: new URL(name + ".png", output).pathname,
      animations: "disabled",
    });
  }
  await show("mcp-form-accept", form);
  await card.waitFor();
  await page.evaluate(() => {
    window.fixtureConversationActivities = [
      {
        threadId: "backend:agy:secretary",
        status: "waitingForInput",
        activities: ["waitingForInput", "delegating"],
        live: true,
      },
    ];
  });
  await page
    .locator(".running-threads")
    .getByRole("img", { name: "等待用户输入" })
    .waitFor();
  const switcher = page.getByRole("button", { name: /^切换对话，当前为/ });
  await switcher.click();
  await page
    .locator('.conversation-switcher button[aria-description="等待用户输入"]')
    .waitFor();
  await switcher.press("Escape");
  await card.getByRole("textbox", { name: "清单名称" }).fill("发");
  await card.getByRole("button", { name: "确认提交" }).click();
  await card.getByText("至少输入 2 个字符。").waitFor();
  assert.equal(await submission("mcp-form-accept"), undefined);
  assert(
    await card
      .getByRole("textbox", { name: "清单名称" })
      .evaluate((field) => field === document.activeElement),
  );
  await card.getByRole("textbox", { name: "清单名称" }).fill("十一月发布");
  await card
    .getByRole("combobox", { name: "只生成预览" })
    .selectOption({ label: "否" });
  await card
    .getByRole("combobox", { name: "发布范围" })
    .selectOption({ label: "项目组" });
  await card.getByRole("checkbox", { name: "验证结果" }).check();
  await page.emulateMedia({ colorScheme: "light" });
  await shot("elicitation-form-desktop-light");
  await page.emulateMedia({ colorScheme: "dark" });
  await shot("elicitation-form-desktop-dark");
  await page.setViewportSize({ width: 390, height: 844 });
  await shot("elicitation-form-mobile-dark");
  if (process.env.ELICITATION_BROWSER_ONLY) {
    const zoomPage = await page.context().newPage();
    await zoomPage.goto("chrome://settings/appearance");
    const zoom = zoomPage.locator("#zoomLevel");
    for (const level of [0.8, 1, 1.25, 1.5, 2]) {
      await zoom.selectOption(String(level));
      await page.waitForFunction(
        (expected) => Math.abs(devicePixelRatio - expected) < 0.02,
        level,
      );
      await card
        .getByRole("button", { name: "确认提交" })
        .scrollIntoViewIfNeeded();
      assert(
        await card
          .getByRole("button", { name: "确认提交" })
          .evaluate((button) => {
            const bounds = button.getBoundingClientRect();
            return bounds.left >= 0 && bounds.right <= innerWidth;
          }),
      );
    }
    await zoom.selectOption("1");
    await zoomPage.close();
  }
  await card.getByRole("button", { name: "确认提交" }).click();
  await card.waitFor({ state: "hidden" });
  assert.deepEqual(await submission("mcp-form-accept"), {
    action: "accept",
    content: {
      label: "十一月发布",
      limit: 10,
      preview: false,
      audience: "team",
      sections: ["summary", "validation"],
    },
  });

  await page.setViewportSize({ width: 1440, height: 980 });
  await page.emulateMedia({ colorScheme: "light" });
  await show("mcp-url-accept", auth);
  const link = card.getByRole("link", { name: "archive.example.test" });
  await link.waitFor();
  assert.equal(await link.getAttribute("href"), auth.url);
  assert.equal(await link.getAttribute("target"), "_blank");
  assert.match(await link.getAttribute("rel"), /noopener noreferrer/);
  await page
    .context()
    .route(auth.url, (route) => route.fulfill({ body: "授权页面夹具" }));
  const opened = page.waitForEvent("popup");
  await link.click();
  const authorizationPage = await opened;
  await authorizationPage.waitForURL(auth.url);
  assert.equal(await authorizationPage.evaluate(() => window.opener), null);
  await authorizationPage.close();
  await page.context().unroute(auth.url);
  await shot("elicitation-url-desktop-light");
  await page.emulateMedia({ colorScheme: "dark" });
  await page.setViewportSize({ width: 390, height: 844 });
  await shot("elicitation-url-mobile-dark");
  await card.getByRole("button", { name: "已完成授权" }).click();
  await card.waitFor({ state: "hidden" });
  assert.deepEqual(await submission("mcp-url-accept"), { action: "accept" });

  for (const [id, request] of [
    ["mcp-form-decline", form],
    ["mcp-url-decline", { ...auth, url: "javascript:alert(1)" }],
  ]) {
    await show(id, request);
    await card.waitFor();
    if (request.mode === "url") {
      assert.equal(await card.getByRole("link").count(), 0);
      assert.equal(
        await card.getByRole("button", { name: "已完成授权" }).count(),
        0,
      );
    }
    await card.getByRole("button", { name: "取消请求" }).click();
    await card.waitFor({ state: "hidden" });
    assert.deepEqual(await submission(id), { action: "decline" });
  }
  await page.setViewportSize({ width: 1440, height: 980 });
  await page.emulateMedia({ colorScheme: "light" });
  console.log(
    "PASS MCP 表单与外部授权的渲染、校验、提交、拒绝及不安全链接拦截",
  );
  await page.evaluate(() => {
    window.fixtureConversationActivities = [];
  });
  await page
    .getByRole("img", { name: "等待用户输入" })
    .waitFor({ state: "hidden" });
}
