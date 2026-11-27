import assert from "node:assert/strict";
import { test } from "node:test";
import {
  elicitationContent,
  elicitationFields,
  elicitationUrl,
} from "../src/domain/elicitation.js";

test("MCP form serializes native field types and omits unanswered optional values", () => {
  const fields = elicitationFields({
    type: "object",
    required: ["name", "confirm"],
    properties: {
      name: { type: "string", minLength: 2 },
      confirm: { type: "boolean" },
      limit: { type: "integer", minimum: 0 },
      mode: { type: "string", oneOf: [{ const: "safe", title: "安全" }] },
      filters: { type: "array", items: { type: "string", enum: ["a", "b"] } },
      comment: { type: "string" },
    },
  });
  assert.deepEqual(fields[3].choices, [{ value: "safe", label: "安全" }]);
  assert.deepEqual(
    fields[4].choices.map(({ value }) => value),
    ["a", "b"],
  );
  const values = new Map(
    Object.entries({
      name: "测试",
      confirm: false,
      limit: "0",
      mode: "safe",
      filters: ["a"],
    }),
  );
  const { content, errors } = elicitationContent(fields, values);
  assert.deepEqual(content, {
    name: "测试",
    confirm: false,
    limit: 0,
    mode: "safe",
    filters: ["a"],
  });
  assert.equal(errors.size, 0);
  values.set("name", "短");
  values.set("limit", "1.5");
  assert.deepEqual(
    [...elicitationContent(fields, values).errors.keys()],
    ["name", "limit"],
  );
  assert.equal(
    elicitationFields({
      type: "object",
      properties: { nested: { type: "object" } },
    }),
    null,
  );
});

test("external authorization accepts only absolute HTTPS URLs without credentials", () => {
  assert.equal(
    elicitationUrl("https://example.test/connect")?.host,
    "example.test",
  );
  for (const url of [
    "javascript:alert(1)",
    "http://example.test",
    "//example.test",
    "https://user:secret@example.test",
  ]) {
    assert.equal(elicitationUrl(url), null);
  }
});
