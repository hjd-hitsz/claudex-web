import { createProjectModels } from "../project-models.mjs";
import { createFileOperations } from "./file-operations.mjs";
import { prepareProjectlessDirectory } from "../thread-projects.mjs";
import type { RpcMessage } from "../rpc-message.d.mts";

type FileDependencies = Parameters<typeof createFileOperations>[0];
type ProductDependencies = Pick<
  FileDependencies,
  "call" | "activeTurns" | "activeThreads"
> & {
  config: { projectlessRoot: string };
  projectModelsDirectory: string;
  legacyProjectModelsDirectory?: string;
  checkCompaction: (threadId: string) => Promise<unknown>;
  readAgentMessages: (threadId: string) => Promise<unknown>;
  broadcast: (message: RpcMessage) => void;
};

type ProductParams = Record<string, unknown> & {
  threadId?: string;
  turnId?: string;
  path?: string;
};

type ProductHandler = (params: ProductParams) => unknown;

function threadTarget({ threadId }: ProductParams) {
  if (!threadId) throw new Error("请求缺少对话标识。");
  return threadId;
}

// 网页操作在所属后端的执行边界内组合；运行状态与原生历史由调用方提供。
export function createProductMethods({
  config,
  projectModelsDirectory,
  legacyProjectModelsDirectory,
  call,
  activeTurns,
  activeThreads,
  checkCompaction,
  readAgentMessages,
  broadcast,
}: ProductDependencies) {
  const projectModels = createProjectModels(
    projectModelsDirectory,
    legacyProjectModelsDirectory,
  );
  const files = createFileOperations({
    call,
    activeTurns,
    activeThreads,
    broadcast,
  });
  const offline = new Map<string, ProductHandler>([
    [
      "lan/projectModels/read",
      async () => ({ projects: await projectModels.read() }),
    ],
    [
      "lan/projectModels/set",
      async ({ cwd, model, effort, ifAbsent }) => {
        const projects = await projectModels.set({
          cwd,
          model,
          effort,
          ifAbsent: ifAbsent === true,
        });
        broadcast({
          method: "lan/projectModels/updated",
          params: { projects },
        });
        return { projects };
      },
    ],
  ]);
  const online = new Map<string, ProductHandler>([
    [
      "lan/agents/messages",
      (params) => readAgentMessages(threadTarget(params)),
    ],
    [
      "lan/compaction/check",
      async (params) => ({
        compaction: await checkCompaction(threadTarget(params)),
      }),
    ],
    [
      "lan/projectless/prepare",
      async () => {
        try {
          return {
            cwd: await prepareProjectlessDirectory(config.projectlessRoot),
            root: config.projectlessRoot,
          };
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          throw new Error("创建对话工作目录失败：" + detail);
        }
      },
    ],
    [
      "lan/files/undo",
      ({ threadId, turnId, path }) => {
        if (!threadId || !turnId || !path)
          throw new Error("请求缺少对话、轮次或文件路径。");
        return files.undo({ threadId, turnId, path });
      },
    ],
  ]);
  return { offline, online, files };
}
