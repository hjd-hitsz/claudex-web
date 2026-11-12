const flowchartHeader =
  /(^|\n)([ \t]*)(flowchart|graph)(?:[ \t]+(TB|TD|BT|RL|LR)\b)?(?=[ \t;\r\n]|$)/;

export function flowchartDirection(source) {
  const header = source.match(flowchartHeader);
  return header ? header[4] || "TB" : null;
}

export function orientFlowchart(source, direction) {
  if (!direction) return source;
  return source.replace(
    flowchartHeader,
    (_, newline, indent, type) => `${newline}${indent}${type} ${direction}`,
  );
}
