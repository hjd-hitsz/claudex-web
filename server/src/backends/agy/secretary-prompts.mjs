import { readPromptSections } from "../../prompts.mjs";

const secretary = readPromptSections("secretary/secretary.md");
const agent = /^(`{3,})markdown\n([\s\S]+)\n\1$/.exec(secretary("agent"));
if (!agent) throw new Error("秘书原生代理定义须保存在 Markdown 代码围栏中");

export const defaultSecretaryRole = secretary("role") + "\n";
export const secretaryAgent = agent[2] + "\n";
