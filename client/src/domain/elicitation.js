function options(schema) {
  const titled = schema?.oneOf ?? schema?.anyOf;
  return titled
    ? titled.map((item) => ({ value: item.const, label: item.title }))
    : schema?.enum?.map((value, index) => ({
        value,
        label: schema.enumNames?.[index] ?? value,
      }));
}

export function elicitationFields(schema) {
  if (schema?.type !== "object" || !schema.properties) return null;
  const fields = Object.entries(schema.properties).map(([name, field]) => ({
    ...field,
    name,
    label: field.title || name,
    required: schema.required?.includes(name) ?? false,
    choices: options(field.type === "array" ? field.items : field),
  }));
  return fields.every(
    ({ type, choices }) =>
      ["string", "boolean", "number", "integer"].includes(type) ||
      (type === "array" && Array.isArray(choices)),
  )
    ? fields
    : null;
}

function fieldError(field, value) {
  if (value == null || value === "")
    return field.required ? "请填写此项。" : "";
  if (field.type === "array") {
    if (value.length < (field.minItems ?? 0))
      return `至少选择 ${field.minItems} 项。`;
    if (value.length > (field.maxItems ?? Infinity))
      return `最多选择 ${field.maxItems} 项。`;
  }
  if (field.type === "string") {
    const length = [...value].length;
    if (length < (field.minLength ?? 0))
      return `至少输入 ${field.minLength} 个字符。`;
    if (length > (field.maxLength ?? Infinity))
      return `最多输入 ${field.maxLength} 个字符。`;
    if (
      field.format === "date-time" &&
      (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/i.test(
        value,
      ) ||
        !Number.isFinite(Date.parse(value)))
    )
      return "请输入包含时区的日期和时间，例如 2026-01-01T09:00:00+08:00。";
  }
  if (field.type === "number" || field.type === "integer") {
    const number = Number(value);
    if (
      !Number.isFinite(number) ||
      (field.type === "integer" && !Number.isInteger(number))
    )
      return field.type === "integer" ? "请输入整数。" : "请输入数字。";
    if (number < (field.minimum ?? -Infinity))
      return `最小值为 ${field.minimum}。`;
    if (number > (field.maximum ?? Infinity))
      return `最大值为 ${field.maximum}。`;
  }
  return "";
}

export function elicitationContent(fields, values) {
  const entries = [];
  const errors = new Map();
  for (const field of fields) {
    const value = values.get(field.name);
    const error = fieldError(field, value);
    if (error) errors.set(field.name, error);
    else if (value != null && value !== "")
      entries.push([
        field.name,
        ["number", "integer"].includes(field.type) ? Number(value) : value,
      ]);
  }
  return { content: Object.fromEntries(entries), errors };
}

export function elicitationUrl(value) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password
      ? url
      : null;
  } catch {
    return null;
  }
}
