import React, { useState } from "react";
import { Shield } from "lucide-react";
import { useStore, sendMessage, respond } from "../../store.js";
import {
  questionRecordAnswers,
  questionReply,
} from "../../domain/question-state.js";
import { QuestionRecord, UserInputForm } from "./user-input.jsx";
import { Elicitation } from "./elicitation.jsx";

function raiseFailure(error) {
  throw error;
}

export function AsyncQuestion({ item, context }) {
  const s = useStore();
  const questions = item.questions.map((question, index) => ({
    id: String(index),
    header: `问题 ${index + 1}`,
    question: question.title,
    options: question.options?.map((label) => ({ label })),
  }));
  if (item.questionAnswers)
    return (
      <QuestionRecord
        questions={questions}
        answers={questionRecordAnswers(item.questionAnswers)}
      >
        {context}
      </QuestionRecord>
    );
  const form = (
    <UserInputForm
      questions={questions}
      isCompleted={!!item.questionClosed}
      draftKey={JSON.stringify([s.current?.id, item.id])}
      disabled={!s.connected || s.busy}
      onSubmit={(answers) => {
        const questionAnswers = item.questions.map(
          (_, index) => answers[index].answers[0] ?? null,
        );
        return sendMessage(questionReply(item.questions, questionAnswers), [], {
          clearDraft: false,
          questionId: item.id,
          onFailure: raiseFailure,
          questionAnswers,
        });
      }}
    />
  );
  return item.questionClosed ? (
    <QuestionRecord questions={questions} replyForm={form}>
      {context}
    </QuestionRecord>
  ) : (
    form
  );
}
export function Question({ request }) {
  const s = useStore(),
    p = request.params;
  const [error, setError] = useState("");
  const input = request.method === "item/tool/requestUserInput";
  const executor = p.executorName;
  if (request.method === "mcpServer/elicitation/request")
    return (
      <Elicitation key={request.id} request={request} connected={s.connected} />
    );
  if (input)
    return (
      <div>
        {executor && <p>{executor} · 等待你的回答</p>}
        <UserInputForm
          questions={p.questions}
          disabled={!s.connected}
          onSubmit={(answers) =>
            respond(request, { answers }, undefined, raiseFailure)
          }
        />
      </div>
    );
  if (request.method === "lan/agy/permission")
    return (
      <div className="request-card">
        <div className="request-title">
          <Shield size={18} />
          {executor || "Antigravity"} · 等待你的确认
        </div>
        <p>{p.reason}</p>
        {p.scope && <pre>{JSON.stringify(p.scope, null, 2)}</pre>}
        <div className="request-actions">
          {p.options?.map(({ optionId, name, kind }) => (
            <button
              key={optionId}
              className={kind === "allow_once" ? "primary" : "secondary"}
              disabled={!s.connected}
              onClick={() => answer({ optionId })}
            >
              {name}
            </button>
          ))}
        </div>
        {error && <p role="alert">{error}</p>}
      </div>
    );
  const permission = request.method === "item/permissions/requestApproval";
  const standard = [
    "item/commandExecution/requestApproval",
    "item/fileChange/requestApproval",
  ].includes(request.method);
  function answer(result, failure) {
    setError("");
    respond(request, result, failure, (error) => setError(error.message));
  }
  return (
    <div className="request-card">
      <div className="request-title">
        <Shield size={18} />
        {executor && executor + " · "}
        {permission ? "权限请求" : standard ? "等待你的确认" : "工具请求"}
      </div>
      <p>{p.reason || p.command || "此操作需要你的确认。"}</p>
      {permission && <pre>{JSON.stringify(p.permissions, null, 2)}</pre>}
      {standard || permission ? (
        <div className="request-actions">
          <button
            className="secondary"
            disabled={!s.connected}
            onClick={() =>
              answer(permission ? { permissions: {} } : { decision: "decline" })
            }
          >
            拒绝
          </button>
          <button
            className="secondary"
            disabled={!s.connected}
            onClick={() =>
              answer(
                permission
                  ? { permissions: p.permissions, scope: "session" }
                  : { decision: "acceptForSession" },
              )
            }
          >
            本次会话允许
          </button>
          <button
            className="primary"
            disabled={!s.connected}
            onClick={() =>
              answer(
                permission
                  ? { permissions: p.permissions, scope: "turn" }
                  : { decision: "accept" },
              )
            }
          >
            允许一次
          </button>
        </div>
      ) : (
        <>
          <p className="muted">此工具暂时无法使用，可以取消请求后继续对话。</p>
          <button
            className="secondary"
            disabled={!s.connected}
            onClick={() =>
              answer(null, {
                code: -32601,
                message: "此工具暂时无法使用。",
              })
            }
          >
            取消此请求
          </button>
        </>
      )}
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
