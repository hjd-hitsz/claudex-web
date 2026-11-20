import {
  decodeTextFile,
  filePresentation,
} from "../../../shared/file-types.mjs";
import { b64encode } from "../domain/format.js";
import { readWorkspaceFile } from "../infrastructure/workspace-files.js";

const emptyView = { buffer: null, change: null };
const dirty = (buffer) => buffer != null && buffer.text !== buffer.original;

/** @typedef {{ kind: "file" | "directory", path: string } | { kind: "diff" | "full", path: string, oldPath?: string, diff: string, patches?: string[] }} WorkspaceIntent */

export function createWorkspaceBuffers({
  get,
  rpc,
  confirmDiscard,
  report,
  notice,
}) {
  const listeners = new Set();
  const writes = new Map();
  let snapshot = {
    views: new Map(),
    directory: { path: get().cwd, entries: [], loading: false },
    dirty: false,
  };
  let fileRevision = 0;
  let directoryRevision = 0;
  let mounted = true;

  function publish(patch) {
    snapshot = { ...snapshot, ...patch };
    for (const listener of listeners) listener();
  }
  function view(owner) {
    return snapshot.views.get(owner) ?? emptyView;
  }
  function updateView(owner, patch) {
    const previous = view(owner);
    const next = { ...previous, ...patch };
    const views = new Map(snapshot.views);
    if (patch.buffer && patch.buffer.token !== previous.buffer?.token) {
      for (const [id, other] of views) {
        if (id !== owner && !dirty(other.buffer)) views.delete(id);
      }
    }
    if (next.buffer || next.change) views.set(owner, next);
    else views.delete(owner);
    publish({
      views,
      dirty: [...views.values()].some(({ buffer }) => dirty(buffer)),
    });
  }
  function updateBuffer(owner, token, patch) {
    const { buffer } = view(owner);
    if (buffer && buffer.token === token)
      updateView(owner, { buffer: { ...buffer, ...patch } });
  }
  function context() {
    const { current, cwd, backendId, providerId, connected } = get();
    return {
      owner: current?.id ?? null,
      cwd,
      backendId,
      providerId,
      connected,
    };
  }
  function matches(target) {
    const current = context();
    return (
      current.owner === target.owner &&
      current.cwd === target.cwd &&
      current.backendId === target.backendId &&
      current.providerId === target.providerId &&
      current.connected === target.connected
    );
  }
  function invalidateReads() {
    fileRevision++;
    directoryRevision++;
  }
  function canReplace(owner, approved, message) {
    const { buffer } = view(owner);
    return (
      !dirty(buffer) ||
      (buffer.token === approved?.token && buffer.text === approved?.text) ||
      confirmDiscard(message)
    );
  }
  function leaveFile() {
    const { owner } = context();
    if (dirty(view(owner).buffer) && !confirmDiscard("放弃未保存的修改？"))
      return;
    fileRevision++;
    updateView(owner, { buffer: null, change: null });
  }
  function showDiff(change) {
    fileRevision++;
    updateView(context().owner, { change });
  }
  async function loadDirectory(path, { navigate = false } = {}) {
    const target = context();
    const message = "当前文件有未保存的修改。放弃修改并打开其他目录？";
    const { buffer } = view(target.owner);
    if (navigate && !canReplace(target.owner, null, message)) return false;
    const request = ++directoryRevision;
    const fileRequest = navigate ? ++fileRevision : null;
    const current = () =>
      request === directoryRevision &&
      matches(target) &&
      (fileRequest === null || fileRequest === fileRevision);
    publish({ directory: { ...snapshot.directory, loading: true } });
    try {
      const { entries } = await rpc("fs/readDirectory", { path });
      if (!current()) return false;
      if (navigate && !canReplace(target.owner, buffer, message)) return false;
      if (navigate) updateView(target.owner, { buffer: null, change: null });
      publish({
        directory: {
          path,
          entries: [...entries].sort(
            (a, b) =>
              Number(b.isDirectory) - Number(a.isDirectory) ||
              a.fileName.localeCompare(b.fileName),
          ),
          loading: false,
        },
      });
      return true;
    } catch (error) {
      if (current()) report(error);
      return false;
    } finally {
      if (
        request === directoryRevision &&
        matches(target) &&
        snapshot.directory.loading
      )
        publish({ directory: { ...snapshot.directory, loading: false } });
    }
  }
  async function openFile(path, change = null) {
    const target = context();
    const { buffer } = view(target.owner);
    const message = "当前文件有未保存的修改。放弃修改并打开其他文件？";
    if (buffer?.path === path && dirty(buffer)) {
      fileRevision++;
      updateView(target.owner, {
        buffer: { ...buffer, change, preview: change ? false : buffer.preview },
        change: null,
      });
      return;
    }
    if (!canReplace(target.owner, null, message)) return;
    const request = ++fileRevision;
    const current = () => request === fileRevision && matches(target);
    const presentation = filePresentation(path);
    try {
      const body = presentation
        ? null
        : decodeTextFile(
            await readWorkspaceFile({
              path,
              backendId: target.backendId,
              cwd: target.cwd,
              providerId: target.providerId,
              threadId: target.owner,
              rpc,
            }),
          );
      if (!current()) return;
      if (!canReplace(target.owner, buffer, message)) return;
      updateView(target.owner, {
        buffer: {
          token: {},
          path,
          kind: presentation?.kind ?? (body === null ? "download" : null),
          text: body ?? "",
          original: body ?? "",
          preview: !change,
          change: body === null ? null : change,
        },
        change: null,
      });
    } catch (error) {
      if (current()) report(error);
    }
  }
  async function save() {
    const { owner } = context();
    const { buffer } = view(owner);
    if (!dirty(buffer)) return;
    const { path, text, token } = buffer;
    const previous = writes.get(path);
    const write = (async () => {
      if (previous) await previous;
      if (!mounted) return;
      try {
        await rpc("fs/writeFile", { path, dataBase64: b64encode(text) });
        if (!mounted || view(owner).buffer?.token !== token) return;
        updateBuffer(owner, token, { original: text });
        if (context().owner === owner) notice("文件已保存");
      } catch (error) {
        if (
          mounted &&
          context().owner === owner &&
          view(owner).buffer?.token === token
        )
          report(error);
      }
    })();
    writes.set(path, write);
    await write;
    if (writes.get(path) === write) writes.delete(path);
  }
  /** @param {WorkspaceIntent} intent */
  async function navigate(intent) {
    switch (intent.kind) {
      case "file":
        return openFile(intent.path);
      case "directory":
        return loadDirectory(intent.path, { navigate: true });
      case "full":
        return openFile(intent.path, intent);
      case "diff":
        return showDiff(intent);
    }
  }
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => snapshot,
    syncDirectory() {
      mounted = true;
      invalidateReads();
      const { connected, cwd } = context();
      if (connected) void loadDirectory(cwd);
      else if (snapshot.directory.loading)
        publish({ directory: { ...snapshot.directory, loading: false } });
    },
    dispose() {
      mounted = false;
      invalidateReads();
    },
    updateBuffer,
    leaveFile,
    navigate,
    loadDirectory,
    openFile,
    showDiff,
    save,
  };
}
