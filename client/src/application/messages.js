import { selectedDelegate } from "../domain/delegation.js";
import { readAttachment, attachmentInputs } from "./attachments.js";
import { referenceInputs } from "./reference-input.js";
import { resourceTarget } from "../../../shared/backend-identity.mjs";
import { pendingPlan, planImplementationText } from "../domain/plans.js";
import { newDraftKey } from "../infrastructure/backend-storage.js";
import { createMessageEditing } from "./message-editing.js";
import { resolveServiceTier } from "../domain/service-tier.js";
import { inputRequestItem } from "../domain/question-state.js";
import { annotationMessage } from "../domain/annotations.js";
import { isCompacting } from "../domain/compaction.js";
import { sameDraftText } from "../domain/code-line-reference.js";
import {
  readAnnotationDrafts,
  removeSentAnnotations,
} from "../infrastructure/annotation-drafts.js";

import { uid } from "../domain/format.js";
export function createMessages({
  setThreadMode,
  get,
  set,
  rpc,
  transport,
  navigation,
  catalog,
  records,
  models,
  feedback,
}) {
  const { report } = feedback;
  const editing = createMessageEditing({ get, set, rpc, navigation });
  function put(item) {
    const index = get().items.findIndex((i) => i.id === item.id);
    const items = get().items.slice();
    if (index >= 0 && item.type === "userMessage") {
      const content = [
        ...(items[index].content || []),
        ...(item.content || []),
      ];
      item = {
        ...item,
        content: [
          ...new Map(content.map((c) => [JSON.stringify(c), c])).values(),
        ],
      };
    }
    if (index < 0) items.push(item);
    else items[index] = { ...items[index], ...item };
    set({ items });
  }
  function recordInputRequest(request, answers) {
    if (
      request.method !== "item/tool/requestUserInput" ||
      request.params.threadId !== get().current?.id
    )
      return;
    const item = inputRequestItem(request, answers);
    const previous = get().items.find((entry) => entry.id === item.id);
    put({ ...item, answers: answers || previous?.answers });
  }
  function respond(request, result, error, onFailure = report) {
    try {
      if (
        !get().connected ||
        transport.connection?.readyState !== WebSocket.OPEN
      )
        throw new Error("回答提交时连接尚未就绪，请重试。");
      if (!get().questions.some((q) => String(q.id) === String(request.id)))
        throw new Error("此请求已结束，请查看最新消息。");
      const agy = resourceTarget(request.params.threadId).backendId === "agy";
      if (agy || request.params.delegationTaskId)
        return rpc(agy ? "lan/agy/respond" : "lan/delegation/respond", {
          threadId: request.params.threadId,
          requestId: request.id,
          result,
          error,
        })
          .then(() => {
            recordInputRequest(request, error ? undefined : result?.answers);
            return true;
          })
          .catch((error) => {
            onFailure(error);
            return false;
          });
      transport.connection.send(
        JSON.stringify({ id: request.id, ...(error ? { error } : { result }) }),
      );
      recordInputRequest(request, error ? undefined : result?.answers);
      set({
        questions: get().questions.filter(
          (q) => String(q.id) !== String(request.id),
        ),
      });
      return true;
    } catch (error) {
      onFailure(error);
      return false;
    }
  }
  function setDraft(draft) {
    set({ draft });
    localStorage.setItem(
      get().current ? "cx-draft-" + get().current.id : newDraftKey,
      draft,
    );
  }
  async function sendMessage(
    text = get().draft,
    attachments = get().attachments,
    {
      clearDraft = true,
      questionId,
      questionAnswers,
      annotations = [],
      replace,
      implementation,
      delegationMode = get().delegationMode,
      nativeCommand,
      onFailure,
    } = {},
  ) {
    if (
      (!text.trim() && !attachments.length && !annotations.length) ||
      get().busy ||
      get().loading ||
      isCompacting(get().compactions[get().current?.id]) ||
      (get().threadAccess &&
        get().threadAccess.threadId === get().current?.id &&
        get().threadAccess.status !== "ready")
    )
      return false;
    const submission = get();
    const epoch = navigation.opening;
    const attachmentDraft = navigation.getAttachmentDraft();
    const attempt = feedback.start("send-message");
    set({ busy: true });
    let thread;
    try {
      if (replace && get().current?.id !== replace.threadId) return false;
      thread = await navigation.ensureThread(delegationMode && !implementation);
      if (
        implementation &&
        (epoch !== navigation.opening ||
          get().current?.id !== implementation.threadId ||
          currentPlan()?.id !== implementation.itemId)
      )
        return false;
      const { backendId } = resourceTarget(thread.id);
      const references = await referenceInputs(text, backendId, rpc);
      const input = [
        ...(text.trim() || annotations.length
          ? [
              {
                type: "text",
                text: annotations.length
                  ? annotationMessage(annotations, references.text)
                  : references.text,
                text_elements: [],
              },
            ]
          : []),
        ...(await attachmentInputs(attachments, rpc, backendId)),
        ...references.inputs,
      ];
      const agy = backendId === "agy";
      if (replace) await editing.prepare(replace);
      const running =
        agy && replace
          ? null
          : (agy && submission.active[thread.id]) || get().active[thread.id];
      if (get().current?.id === thread.id && !(agy && running))
        put({
          id: "optimistic-" + uid(),
          type: "userMessage",
          turnId: running,
          content: input,
          optimistic: true,
          ...(questionId ? { questionId } : {}),
        });
      const params = {
        threadId: thread.id,
        ...(submission.backendId === "agy" && {
          delegateTo: selectedDelegate(submission),
          nativeCommand,
        }),
        ...(agy &&
          replace && { expectedLastTurnId: replace.retainedLastTurnId }),
        input,
        model: submission.model || undefined,
        providerId: submission.providerId,
        effort: submission.effort || undefined,
        serviceTier: resolveServiceTier(
          submission.serviceTier,
          submission.models.find((m) => m.model === submission.model),
        ),
        collaborationMode: {
          mode:
            implementation || submission.backendId === "agy"
              ? "default"
              : submission.mode,
          settings: {
            model: submission.model,
            reasoning_effort: submission.effort || null,
          },
        },
      };
      if (!running) models.rememberModelSelection();
      const startedAt = Date.now() / 1000;
      if (get().compactions[thread.id]?.status === "completed") {
        const compactions = { ...get().compactions };
        delete compactions[thread.id];
        set({ compactions });
      }
      const r = await rpc(
        running ? "turn/steer" : "turn/start",
        running && submission.backendId !== "agy"
          ? { threadId: thread.id, expectedTurnId: running, input }
          : { ...params, ...(running && { expectedTurnId: running }) },
      );
      if (implementation) setThreadMode(thread.id, "default");
      const observedTurn = r.turn && get().turnTimings[thread.id]?.[r.turn.id];
      const alreadyFinished =
        observedTurn &&
        (observedTurn.completedAt != null ||
          ["completed", "failed", "interrupted"].includes(observedTurn.status));
      const alreadyStarted =
        observedTurn?.status === "inProgress" && r.turn?.status === "queued";
      if (r.turn) {
        const turn = {
          ...r.turn,
          ...((alreadyFinished || alreadyStarted) && observedTurn),
          startedAt:
            r.turn.startedAt ??
            get().turnTimings[thread.id]?.[r.turn.id]?.startedAt ??
            startedAt,
        };
        records.recordTurnTimings(thread.id, [turn]);
        records.recordThreadActivity(thread.id, turn);
      }
      if (clearDraft) {
        const draftKey = "cx-draft-" + thread.id;
        const current = get().current?.id === thread.id;
        const stored = localStorage.getItem(draftKey);
        const clearText = sameDraftText(current ? get().draft : stored, text);
        if (sameDraftText(stored, text)) localStorage.removeItem(draftKey);
        if (current && clearText) set({ draft: "" });
        navigation.updateAttachmentDraft(attachmentDraft, (entries) =>
          entries.filter(
            (entry) =>
              !attachments.includes(entry) &&
              !(clearText && entry.kind === "code-line"),
          ),
        );
      }
      if (annotations.length && !replace) {
        removeSentAnnotations(thread.id, annotations);
        if (
          get().annotationEditor?.threadId === thread.id &&
          !readAnnotationDrafts(thread.id).some(
            (entry) => entry.id === get().annotationEditor.id,
          )
        )
          set({ annotationEditor: null });
      }
      if (questionId && get().current?.id === thread.id) {
        const question = get().items.find((item) => item.id === questionId);
        if (question) put({ ...question, questionAnswers });
      }
      if (
        ["queued", "inProgress"].includes(r.turn?.status) &&
        !alreadyFinished &&
        (!get().active[thread.id] || get().active[thread.id] === r.turn.id)
      )
        set({ active: { ...get().active, [thread.id]: r.turn.id } });
      if (get().current?.id === thread.id)
        set({ threadAccess: { threadId: thread.id, status: "ready" } });
      if (replace) editing.finish(replace);
      if (!get().threads.some((entry) => entry.id === thread.id))
        catalog.loadThreads().catch(() => {});
      feedback.resolve(attempt);
      return true;
    } catch (e) {
      if (get().current?.id === thread?.id)
        set({ items: get().items.filter((i) => !i.optimistic) });
      if (/already has an active writer/i.test(e.message)) {
        if (get().current?.id === thread?.id)
          set({ threadAccess: { threadId: thread.id, status: "blocked" } });
      } else if (epoch === navigation.opening) {
        if (onFailure) onFailure(e);
        else report(e, attempt);
      }
      return false;
    } finally {
      if (replace) editing.release(replace);
      set({ busy: false });
    }
  }
  function currentPlan() {
    const s = get();
    const threadId = s.current?.id;
    const turns = [
      ...Object.entries(s.turnTimings[threadId] || {}).map(([id, turn]) => ({
        id,
        ...turn,
      })),
      ...(s.turns[threadId] || []),
    ];
    const plan = pendingPlan(s.items, turns, s.active[threadId]);
    return plan;
  }
  async function approvePlan(itemId) {
    const plan = currentPlan();
    const threadId = get().current?.id;
    if (!get().connected || !plan || plan.id !== itemId) return false;
    return sendMessage(planImplementationText(plan), [], {
      clearDraft: false,
      implementation: { threadId, itemId },
    });
  }
  async function stop() {
    const id = get().current?.id;
    if (id && get().active[id])
      await rpc("turn/interrupt", { threadId: id, turnId: get().active[id] });
  }
  async function review() {
    if (isCompacting(get().compactions[get().current?.id]))
      throw new Error("正在整理上下文，完成后可继续审查。");
    const t = await navigation.ensureThread();
    await rpc("review/start", {
      threadId: t.id,
      target: { type: "uncommittedChanges" },
    });
  }
  function addAttachment(a) {
    set({ attachments: [...get().attachments, a] });
  }
  async function attachFile(file) {
    const draft = navigation.getAttachmentDraft();
    const add = (attachment) =>
      navigation.updateAttachmentDraft(draft, (entries) => [
        ...entries,
        attachment,
      ]);
    add(await readAttachment(file));
  }

  return {
    put,
    recordInputRequest,
    respond,
    setDraft,
    sendMessage,
    approvePlan,
    stop,
    review,
    addAttachment,
    attachFile,
    handleReverted: editing.handleReverted,
    cancelMessageEdit(edit) {
      if (edit.retainedIds != null) {
        editing.finish(edit);
        if (get().current?.id === edit.threadId)
          navigation.loadHistory().catch(report);
      }
    },
  };
}
