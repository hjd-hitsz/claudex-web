import { useStoreSelector } from "../../store.js";

export function useMarkdownDirectory(baseDirectory) {
  return useStoreSelector(
    (state) =>
      baseDirectory ?? (state.current?.cwd || state.cwd || state.defaultCwd),
  );
}
