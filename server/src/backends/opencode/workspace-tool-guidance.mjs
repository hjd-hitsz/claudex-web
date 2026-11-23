const toolGuidance = {
  glob: "Use `glob` when the task is to find paths by a file name or pattern.",
  claudex_grep:
    "Use `claudex_grep` for a direct text search. Select the `files`, `count`, or `content` mode according to the result you need.",
  claudex_read:
    "Use `claudex_read` to read files, directories, or supported media. Put related paths and known line ranges in one request. Paths may be inside or outside the project according to OpenCode's permissions.",
  claudex_patch:
    "Use `claudex_patch` to create, edit, move, or delete files. Group related changes in one patch and keep unrelated content intact.",
  claudex_shell:
    "Use `claudex_shell` for commands and for searches that combine operations such as Git selection, filtering, and reading matching excerpts. Return the relevant output. For long builds, tests, or downloads, set `background: true` and let the finished job resume the session.",
  claudex_webfetch:
    "Use `claudex_webfetch` to open an HTTP or HTTPS URL. Omit terms for a short preview and links, or supply terms to find focused excerpts. Follow relevant links or continue at the reported line when needed.",
  claudex_web_search:
    "Use `claudex_web_search` to discover sources by query. Open an individual result with `claudex_webfetch` when more evidence is needed.",
  claudex_skill:
    "Use `claudex_skill` with the IDs from the available skills list. Load known related skills and prerequisites together in workflow order. Instructions already supplied in a skill content block are ready to use.",
};

const replacedTools = [
  "read",
  "write",
  "edit",
  "patch",
  "grep",
  "webfetch",
  "websearch",
  "skill",
  "shell",
];
const skillSourceKey = "core/skill-guidance";
const skillCatalog = /<available_skills>[\s\S]*?<\/available_skills>/;

function withoutNativeToolBlocks(text, missing) {
  const names = `(?:${missing.join("|")})`;
  const references = new RegExp(
    [
      `\`${names}\``,
      `\\b${names} tools?\\b`,
      `\\b(?:uses?|using|calls?|calling|invokes?|invoking)\\s+(?:the\\s+)?${names}\\b(?![-_])`,
    ].join("|"),
    "i",
  );
  if (!references.test(text)) return text;
  return text
    .split(/(<example>[\s\S]*?<\/example>)/)
    .flatMap((section) => {
      if (section.startsWith("<example>"))
        return references.test(section) ? [] : [section];
      return section
        .trim()
        .split(/\n\n+/)
        .map((block) => {
          if (!references.test(block)) return block;
          const kept = block
            .split(/\n(?=[*+-] |\d+\. )/)
            .filter((paragraph) => !references.test(paragraph));
          return kept.length === 1 && /^#+ [^\n]+$/.test(kept[0])
            ? ""
            : kept.join("\n");
        })
        .filter(Boolean);
    })
    .join("\n\n");
}

function keepSkillCatalog(system, messages, enabled) {
  for (const [index, part] of system.entries()) {
    const metadata = part.metadata;
    const instructions = metadata?.experimental?.instructions;
    const skill = instructions?.find(({ key }) => key === skillSourceKey);
    if (!skill) continue;
    const catalog = skillCatalog.exec(skill.text)?.[0];
    if (!catalog) continue;
    const replacement = enabled ? catalog : "";
    system[index] = {
      ...part,
      text: part.text.replace(skill.text, () => replacement),
      metadata: {
        ...metadata,
        experimental: {
          ...metadata.experimental,
          instructions: instructions.map((entry) =>
            entry === skill ? { ...entry, text: replacement } : entry,
          ),
        },
      },
    };
  }
  for (const [index, message] of messages.entries()) {
    const sources = message.metadata?.instructionSources;
    if (message.role !== "system" || !sources?.includes(skillSourceKey))
      continue;
    messages[index] = {
      ...message,
      content: message.content.map((part) => {
        const catalog = part.type === "text" && skillCatalog.exec(part.text);
        if (!catalog) return part;
        // OpenCode joins separate instruction sources with a blank line.
        const precedingBreak = part.text.lastIndexOf("\n\n", catalog.index);
        const start = precedingBreak === -1 ? 0 : precedingBreak + 2;
        return {
          ...part,
          text:
            part.text.slice(0, start) +
            (enabled ? catalog[0] : "") +
            part.text.slice(catalog.index + catalog[0].length),
        };
      }),
    };
  }
}

export async function applyWorkspaceToolGuidance(
  { agent, tools, system, messages },
  agentInfo,
) {
  const available = Object.entries(toolGuidance).filter(([name]) =>
    Object.hasOwn(tools, name),
  );

  const base = system[0];
  const missing = replacedTools.filter((name) => !Object.hasOwn(tools, name));
  if (base && missing.length) {
    const retained = withoutNativeToolBlocks(base.text, missing);
    if (retained !== base.text && !(await agentInfo(agent)).system)
      system[0] = { ...base, text: retained };
  }
  if (!tools.skill)
    keepSkillCatalog(system, messages, Boolean(tools.claudex_skill));

  if (available.length)
    system.splice(base ? 1 : 0, 0, {
      type: "text",
      text: ["# Workspace tools", ...available.map(([, text]) => text)].join(
        "\n\n",
      ),
    });
}
