import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const cache = root + ".cache/component-tests";
const fixtures = [
  [
    /^(?:.*\/)?file-markdown-editor(?:\.jsx)?$/,
    `import React from 'react'; import {RichText} from ${JSON.stringify(root + "client/src/features/markdown/rich-text.jsx")}; export function FileMarkdownEditor({path,text,onChange}) {return React.createElement('div', null, React.createElement(RichText, {text,cwd:path.slice(0,path.lastIndexOf('/'))}), React.createElement('textarea', {'aria-label':'Markdown 文件预览', value:text, onChange:e=>onChange(e.target.value)}))}`,
  ],
  [
    /^(?:.*\/)?markdown-editor(?:\.jsx)?$/,
    `import React from 'react'; export function MarkdownEditor({inputRef,theme,expanded,activeId,...props}) {return React.createElement('textarea', {...props, 'aria-label': props['aria-label'] || '消息', 'aria-expanded': expanded, 'aria-activedescendant': activeId, ref: inputRef})}`,
  ],
  [
    /^(?:.*\/)?code-editor(?:\.jsx)?$/,
    `import React from 'react'; export function CodeEditor({path,text,onChange,diff,patches}) {return React.createElement('textarea', {'aria-label': '文件源码', 'data-change-diff': diff, 'data-change-patches': patches, value: text, onChange: e => onChange(e.target.value)})}`,
  ],
  [/^react-dom$/, "export const createPortal = (children) => children;"],
  [
    /^mermaid$/,
    `let config; export default {initialize(options){config=options}, render(id, source){return new Promise((resolve,reject)=>globalThis.testMermaidCalls.push({id,source,config,resolve,reject}))}}`,
  ],
  [
    /^@xterm\/xterm$/,
    `export class Terminal {constructor(options){this.options=options;this.cols=80;this.rows=24;globalThis.testTerminals.push(this)} loadAddon(){} open(){} write(){} reset(){} dispose(){} focus(){} onData(fn){this.input=fn}}`,
  ],
  [/^@xterm\/addon-fit$/, `export class FitAddon {fit(){}}`],
];
await mkdir(cache, { recursive: true });
try {
  await build({
    entryPoints: [root + "tests/components/entry.jsx"],
    banner: {
      js: "import {createRequire} from 'node:module'; const require=createRequire(import.meta.url);",
    },
    bundle: true,
    define: {
      __CLAUDEX_WEB_BUILD__: JSON.stringify({
        version: "1.2.3",
        displayVersion: "1.2.3+dev.gabc1234.dirty",
        revision: "abc123456789",
        dirty: true,
        channel: "development",
        builtAt: "2026-10-26T00:00:00Z",
      }),
    },
    platform: "node",
    format: "esm",
    outfile: cache + "/client.mjs",
    external: ["react", "react-dom/client"],
    loader: { ".css": "empty", ".svg": "dataurl" },
    plugins: [
      {
        name: "component-fixtures",
        setup(builder) {
          for (const [index, [filter]] of fixtures.entries()) {
            builder.onResolve({ filter }, () => ({
              path: String(index),
              namespace: "component-fixtures",
            }));
          }
          builder.onLoad(
            { filter: /.*/, namespace: "component-fixtures" },
            ({ path }) => ({
              contents: fixtures[Number(path)][1],
              resolveDir: root,
            }),
          );
        },
      },
    ],
  });
  const result = spawnSync(
    process.execPath,
    [root + "tests/components/client.mjs"],
    {
      stdio: "inherit",
      env: { ...process.env, CODEX_COMPONENT_BUNDLE: cache + "/client.mjs" },
    },
  );
  process.exitCode = result.status ?? 1;
} finally {
  await rm(cache, { recursive: true, force: true });
}
