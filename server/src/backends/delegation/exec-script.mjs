import { parse } from "acorn";

const commandFields = new Map([
  ["exec_command", "cmd"],
  ["mcp__claudex_background__background_start", "command"],
]);

function value(node, bindings) {
  if (!node) return;
  switch (node.type) {
    case "Literal":
      return node.value;
    case "Identifier":
      return bindings.get(node.name);
    case "ArrayExpression":
      return node.elements.map((element) => value(element, bindings));
    case "TemplateLiteral": {
      const parts = node.expressions.map((part) => value(part, bindings));
      if (parts.every((part) => ["string", "number"].includes(typeof part)))
        return node.quasis
          .map(({ value: { cooked } }, index) => cooked + (parts[index] ?? ""))
          .join("");
      break;
    }
    case "BinaryExpression": {
      const left = value(node.left, bindings);
      const right = value(node.right, bindings);
      if (
        node.operator === "+" &&
        typeof left === "string" &&
        typeof right === "string"
      )
        return left + right;
      break;
    }
  }
}

// Rollout records the JavaScript submitted to exec. Read static arguments
// without running the script or claiming a value for computed arguments.
export function execScript(input) {
  let program;
  try {
    program = parse(input, { ecmaVersion: "latest", sourceType: "module" });
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return { script: input };
  }

  const commands = [];
  let computed = false;
  function visit(node, bindings) {
    if (!node?.type) return;
    if (node.type === "BlockStatement") bindings = new Map(bindings);
    if (node.type === "VariableDeclaration") {
      for (const { id, init } of node.declarations) {
        visit(init, bindings);
        if (id.type === "Identifier")
          bindings.set(
            id.name,
            node.kind === "const" ? value(init, bindings) : undefined,
          );
      }
      return;
    }
    if (
      node.type === "CallExpression" &&
      node.callee.type === "MemberExpression"
    ) {
      const { object, property, computed: bracket } = node.callee;
      const method = bracket ? value(property, bindings) : property.name;
      const [arg] = node.arguments;
      const field = object.name === "tools" && commandFields.get(method);
      if (field) {
        const cmd = arg?.properties?.findLast(
          ({ key, computed }) =>
            !key || computed || (key.name ?? key.value) === field,
        );
        const command = cmd?.key && !cmd.computed && value(cmd.value, bindings);
        if (typeof command === "string" && command.trim())
          commands.push(command);
        else computed = true;
      }
      if (method === "map" && arg?.type === "ArrowFunctionExpression") {
        const values = value(object, bindings);
        const [param] = arg.params;
        if (Array.isArray(values) && param?.type === "Identifier") {
          for (const entry of values)
            visit(arg.body, new Map(bindings).set(param.name, entry));
          return;
        }
      }
    }
    if (node.params) {
      bindings = new Map(bindings);
      for (const param of node.params)
        if (param.type === "Identifier") bindings.delete(param.name);
    }
    for (const child of Object.values(node)) {
      if (Array.isArray(child)) {
        for (const element of child) visit(element, bindings);
      } else visit(child, bindings);
    }
  }
  visit(program, new Map());
  return {
    ...(commands.length && { action: commands.join("\n") }),
    ...((computed || !commands.length) && { script: input }),
  };
}
