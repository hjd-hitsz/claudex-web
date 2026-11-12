import test from "node:test";
import assert from "node:assert/strict";
import { flowchartDirection, orientFlowchart } from "../src/domain/mermaid.js";

test("流程图切换主方向，保留节点、边、注释和子图方向", () => {
  const source =
    "%% 流程说明\nflowchart TD\nsubgraph 输入\ndirection TB\nA[点云] --> B[地图]\nend";
  assert.equal(flowchartDirection(source), "TD");
  assert.equal(
    orientFlowchart(source, "LR"),
    source.replace("flowchart TD", "flowchart LR"),
  );
  assert.equal(orientFlowchart(source, ""), source);
  assert.equal(orientFlowchart("graph RL; A-->B", "TB"), "graph TB; A-->B");
  assert.equal(orientFlowchart("graph\nA-->B", "LR"), "graph LR\nA-->B");
  assert.equal(flowchartDirection("graph\nA-->B"), "TB");
});

test("其他图表类型保持原文，不提供流程图方向选择", () => {
  const source = "sequenceDiagram\n用户->>服务: 请求";
  assert.equal(flowchartDirection(source), null);
  assert.equal(orientFlowchart(source, "LR"), source);
});
