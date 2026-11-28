const pageSize = 4000;
const firstPageSize = 1024;

export function evidencePage(detail, offset) {
  const json = JSON.stringify(detail);
  if (offset === undefined && json.length <= pageSize) return detail;
  const start = offset ?? 0;
  if (start >= json.length || /[\uDC00-\uDFFF]/.test(json[start]))
    throw new Error("委派详情分页位置无效");
  let end = Math.min(
    start + (offset === undefined ? firstPageSize : pageSize),
    json.length,
  );
  if (end < json.length && /[\uDC00-\uDFFF]/.test(json[end])) end--;
  return {
    encoding: "json",
    chunk: json.slice(start, end),
    nextOffset: end < json.length ? end : null,
  };
}
