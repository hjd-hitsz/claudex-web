# 本地翻译引擎

`@claudex-web/translation-engine` 提供独立的英译中 CPU 推理与模型管理，可供网页服务或命令行程序使用。实现包含 Microsoft Edge 翻译组件的下载、ONNX 图解包、原生分词及自有编码器与解码器推理循环。运行环境为 Linux x64（glibc 2.34+）、Node.js 24.5+、npm 和 tar。

## 构建与命令行

在仓库根目录安装依赖并构建分词器，需要 C 编译器。

```bash
npm install
npm run build --workspace @claudex-web/translation-engine
node packages/translation-engine/bin/translate.mjs download
node packages/translation-engine/bin/translate.mjs translate "Read the complete message before translating."
```

独立命令默认将模型保存在当前用户的 `~/.local/share/claudex-translation/models`，可通过 `CLAUDEX_TRANSLATION_MODEL_DIR` 指定其他目录。Claudex Web 固定使用服务账户的 `~/.local/share/claudex-web/models`。

## JavaScript 接口

调用者明确传入持久数据目录，首次 `prepare()` 下载组件，后续调用校验并复用本地版本。

```javascript
import { createTranslationEngine } from "@claudex-web/translation-engine";

const engine = createTranslationEngine({
  directory: process.env.MODEL_DIRECTORY,
  onProgress(progress) {
    console.log(progress.stage, progress.received, progress.total);
  },
});
try {
  const model = await engine.prepare();
  console.log(model.id, model.version);
  const translations = await engine.translate([
    "Read the complete message before translating.",
  ]);
  console.log(translations);
} finally {
  await engine.close();
}
```

输入为已完成的普通文字，输出数组与输入顺序一致。调用方负责 Markdown 解析和展示。较长文字在引擎内部按句子拆分，以满足模型上下文限制。推理使用 ONNX Runtime CPU 单线程，分词通过随包构建的辅助进程调用下载组件中的原生分词库。

## 下载与存储

首次下载从 Microsoft 组件目录取得模型与分词运行库，并通过 npm 获取固定版本的 ONNX Runtime CPU 文件，合计约 300 MB。HTTPS 目录响应提供版本、文件大小与 SHA-256，组件文件沿用其官方地址。安装前校验完整下载，解包后只保留英译中所需文件，当前安装约 147 MiB。完整模型准备后可离线使用。

```text
模型目录/
  edge-en-zh/
    installed.json
    模型版本-分词版本/
      ready.json
      model/
      runtime/
```

跨进程安装锁合并并发下载。下载中断会清理本次临时目录，进程异常留下的锁通过进程存活与租约检查恢复。版本索引在校验后原子写入，文件损坏或缺失会触发重新安装。`close()` 取消下载并释放推理及分词进程，模型文件可在升级后复用。

## 验证与许可证

```bash
npm test --workspace @claudex-web/translation-engine
```

自动测试使用临时目录和本地组件夹具，覆盖并发安装、完整性校验、取消、损坏恢复及离线复用。真实模型测试可使用命令行与调用方提供的普通文本进行。

子项目源码采用 [GNU GPL v3.0](LICENSE)，SPDX 标识为 `GPL-3.0-only`。下载的 Microsoft 组件和 npm 依赖分别沿用其提供方的条款。发行包交付引擎源码与分词辅助程序，模型、Microsoft 分词库和 ONNX Runtime 通过首次启用下载。
