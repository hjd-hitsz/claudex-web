type CompactionStatus =
  | "starting"
  | "running"
  | "reconnecting"
  | "completed"
  | "interrupted"
  | "failed"
  | "unconfirmed";

export type Compaction = {
  status: CompactionStatus;
  startedAt: number;
  turnId?: string | null;
  completedAt?: number;
  error?: string;
};

export type CompactionTurn = {
  id: string;
  status: string;
  startedAt?: number | null;
  completedAt?: number | null;
  items?: readonly { type: string }[];
  error?: { message?: string } | null;
};

const activeStatuses: readonly CompactionStatus[] = [
  "starting",
  "running",
  "reconnecting",
];

export const isCompacting = <Entry extends Pick<Compaction, "status">>(
  entry?: Entry | null,
): entry is Entry & { status: "starting" | "running" | "reconnecting" } =>
  entry != null && activeStatuses.includes(entry.status);

export function findCompactionTurn(
  entry: Compaction,
  turns: readonly CompactionTurn[],
) {
  return turns.find(
    (turn) =>
      !turn.items?.some((item) => item.type === "userMessage") &&
      (entry.turnId
        ? turn.id === entry.turnId
        : Number(turn.startedAt) >= Math.floor(entry.startedAt) &&
          (turn.status === "inProgress" ||
            turn.items?.some((item) => item.type === "contextCompaction"))),
  );
}

export function recoverCompaction<T extends Compaction>(
  entry: T,
  thread: { status?: { type: string } | null },
  turns: readonly CompactionTurn[],
  now = Date.now() / 1000,
): Omit<T, keyof Compaction> & Compaction {
  const turn = findCompactionTurn(entry, turns);
  if (turn)
    return {
      ...entry,
      turnId: turn.id,
      status:
        turn.status === "inProgress"
          ? "running"
          : turn.status === "completed"
            ? "completed"
            : turn.status === "interrupted"
              ? "interrupted"
              : "failed",
      error: turn.error?.message,
      ...(turn.status === "inProgress"
        ? { completedAt: undefined }
        : { completedAt: turn.completedAt ?? now }),
    };
  const ordinaryTurn = turns.some(
    (candidate) =>
      candidate.status === "inProgress" &&
      candidate.items?.some((item) => item.type === "userMessage"),
  );
  if (entry.status === "starting" && !ordinaryTurn) return entry;
  return ["idle", "notLoaded"].includes(thread.status?.type ?? "") ||
    ordinaryTurn
    ? { ...entry, status: "unconfirmed", completedAt: now, error: undefined }
    : { ...entry, status: "reconnecting" };
}
