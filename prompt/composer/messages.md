# 输入区消息

旧版段落用于识别已保存的计划批准消息，保留原始措辞。

## 用 /init 建立 AGENTS.md <!-- prompt: initProject -->

请为当前工作目录中的项目生成 AGENTS.md，作为今后参与此项目的代理和贡献者的指南。
写入前检查当前目录是否已有 AGENTS.md；已有时保留其全部内容并告知位置。
阅读实际源码结构、配置、构建脚本、测试和近期 Git 提交约定，再编写简洁、独立可读的 Markdown 文档。
按项目实际情况涵盖：项目结构与入口、构建及开发命令、代码风格、测试与验证要求、提交和合并请求约定，以及必要的配置注意事项。
提供可执行的命令和准确的目录示例，省略不适用的章节，遵循项目现有语言与规范。
在生成的 AGENTS.md 中写明提示词维护规则。项目维护的所有提示词必须按主题集中在项目根目录 `prompt/` 的 Markdown 文件中，禁止在业务源码中硬编码提示词，禁止创建仅含一句提示词的独立文件。增改提示词时同步维护主题文件和加载引用。

## 回复批注说明 <!-- prompt: responseAnnotations -->

以下各项是用户选自较早回复的原文及批注，按数组顺序编号为 1、2 等。请结合原文处理每条批注，并在回复中对应位置加入行内标记 :codex-annotation{index="N"}，其中 N 为该项从 1 开始的编号。

## 批注缺省请求 <!-- prompt: annotationRequest -->

请根据这些注释继续处理。

## 批准后执行计划 <!-- prompt: approvePlan -->

Implement the following plan:

## 旧版计划批准标记 <!-- prompt: legacyApprovePlan -->

Implement the following plan:
