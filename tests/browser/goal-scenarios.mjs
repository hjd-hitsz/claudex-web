import assert from "node:assert/strict";

export async function runGoalScenarios({
  submit,
  type,
  click,
  clickText,
  waitFor,
  evaluate,
  screenshot,
}) {
  await type("/goal");
  await waitFor(`!!document.querySelector('[role="option"]')`);
  await click('[role="option"]');
  await waitFor(`document.querySelector('.composer [title="退出目标输入"]')`);
  await screenshot("goal-input");
  const count = await evaluate(
    `commandFixture.requests.filter(r=>r.method==='thread/goal/set').length`,
  );
  await submit("替换目标的可衡量完成条件");
  await waitFor(
    `document.querySelector('[role="dialog"]')?.textContent.includes('替换当前目标')`,
  );
  assert.equal(
    await evaluate(
      `commandFixture.requests.filter(r=>r.method==='thread/goal/set').length`,
    ),
    count,
  );
  await screenshot("goal-replace-confirmation");
  await clickText("取消");
  await waitFor(`!document.querySelector('[role="dialog"]')`);
  assert.equal(
    await evaluate(
      `document.querySelector('.composer [aria-label="消息"]').innerText.trim()`,
    ),
    "替换目标的可衡量完成条件",
  );
  await click('button[aria-label="发送消息"]');
  await waitFor(`!!document.querySelector('[role="dialog"]')`);
  await clickText("替换目标");
  await waitFor(
    `!document.querySelector('[role="dialog"]') && document.querySelector('.goal-summary')?.textContent.includes('替换目标的可衡量完成条件')`,
  );
  await evaluate(`commandFixture.updateGoal({status:'complete'})`);
  await waitFor(
    `document.querySelector('.goal-summary')?.textContent.includes('目标已完成')`,
  );
  await screenshot("goal-complete");
  await evaluate(`commandFixture.updateGoal({status:'blocked'})`);
  await waitFor(
    `document.querySelector('.goal-summary')?.textContent.includes('目标遇到阻塞')`,
  );
  await screenshot("goal-blocked");
  await click('button[title="恢复目标"]');
  await waitFor(
    `document.querySelector('.goal-summary')?.textContent.includes('正在追踪目标')`,
  );
  await click('button[title="清除目标"]');
  await waitFor(`!document.querySelector('.goal-summary')`);
  await submit("/goal");
  await type("新目标完成条件");
  await evaluate(`commandFixture.failGoal(true)`);
  await click('button[aria-label="发送消息"]');
  await waitFor(
    `document.querySelector('.error-banner')?.textContent.includes('目标保存失败')`,
  );
  assert.equal(
    await evaluate(
      `document.querySelector('.composer [aria-label="消息"]').innerText.trim()`,
    ),
    "新目标完成条件",
  );
  await screenshot("goal-save-failure");
  await evaluate(`commandFixture.failGoal(false)`);
  await click('button[title="关闭错误提示"]');
  await click('button[aria-label="发送消息"]');
  await waitFor(
    `document.querySelector('.goal-summary')?.textContent.includes('新目标完成条件')`,
  );
  await screenshot("goal-created");
}

export async function runGoalZoom({
  targetId: conversationTargetId,
  call,
  page,
  evaluate,
  waitFor,
  submit,
  click,
  screenshot,
  pause,
}) {
  const { targetId } = await call("Target.createTarget", {
    url: "chrome://settings/appearance",
  });
  const { sessionId } = await call("Target.attachToTarget", {
    targetId,
    flatten: true,
  });
  const settings = (expression) =>
    call("Runtime.evaluate", { expression, returnByValue: true }, sessionId);
  const locate = `(()=>{function find(root){const direct=root.querySelector('#zoomLevel');if(direct)return direct;for(const node of root.querySelectorAll('*'))if(node.shadowRoot){const result=find(node.shadowRoot);if(result)return result;}return null;}return find(document);})()`;
  try {
    for (let i = 0; i < 100; i++) {
      if ((await settings(`Boolean(${locate})`)).result.value) break;
      await pause(50);
    }
    for (const width of [1440, 390]) {
      await page("Emulation.clearDeviceMetricsOverride");
      await call("Browser.setWindowBounds", {
        windowId: (
          await call("Browser.getWindowForTarget", {
            targetId: conversationTargetId,
          })
        ).windowId,
        bounds: { width, height: 1000 },
      });
      for (const theme of ["light", "dark"]) {
        for (const zoom of [0.8, 1, 1.25, 1.5, 2]) {
          await settings(
            `(()=>{const select=${locate};select.value='${zoom}';select.dispatchEvent(new Event('input',{bubbles:true,composed:true}));select.dispatchEvent(new Event('change',{bubbles:true,composed:true}));})()`,
          );
          await pause(250);
          await call("Target.activateTarget", {
            targetId: conversationTargetId,
          });
          await page("Page.reload");
          await waitFor(
            `!!document.querySelector('.composer .ProseMirror[aria-label="消息"]')`,
          );
          await submit(
            "/goal 完成项目发布前的回归检查，核对主要用户流程、修复问题并记录验证结果。",
          );
          await evaluate(`document.documentElement.dataset.theme='${theme}'`);
          const metrics = await evaluate(
            `({dpr:devicePixelRatio,width:innerWidth,scroll:document.documentElement.scrollWidth})`,
          );
          assert(
            Math.abs(metrics.dpr - zoom) < 0.03,
            JSON.stringify({ zoom, metrics }),
          );
          await submit("/goal edit");
          await waitFor(`!!document.querySelector('.goal-editor')`);
          const bounds = await evaluate(
            `(()=>{const r=document.querySelector('button[title="收起对话详情"]').getBoundingClientRect();return {left:r.left,right:r.right,bottom:r.bottom,width:innerWidth,height:innerHeight,scroll:document.documentElement.scrollWidth}})()`,
          );
          assert(
            bounds.left >= 0 &&
              bounds.right <= bounds.width + 1 &&
              bounds.bottom <= bounds.height &&
              bounds.scroll <= bounds.width + 1,
            JSON.stringify(bounds),
          );
          await screenshot(`goal-zoom-${theme}-${width}-${zoom}`);
          await click('button[title="收起对话详情"]');
        }
      }
    }
  } finally {
    await settings(
      `(()=>{const select=${locate};select.value='1';select.dispatchEvent(new Event('change',{bubbles:true,composed:true}));})()`,
    );
    await call("Target.closeTarget", { targetId });
  }
}
