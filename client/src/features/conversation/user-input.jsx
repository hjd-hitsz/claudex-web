import { ResizableTextarea } from "../../ui/resizable-textarea.jsx";
import React, { useId, useState } from "react";
import { Check, ChevronLeft, ChevronRight, MessageSquare } from "lucide-react";

// 异步提问收纳时表单会重新挂载，页面内按对话和消息保留未提交的填写内容。
const drafts = new Map();

export function QuestionRecord({ questions, answers, children, replyForm }) {
  const [replying, setReplying] = useState(false);
  const hasAnswers = questions.some(
    (question) => answers?.[question.id]?.answers.length,
  );
  return (
    <details className="activity historical-questions">
      <summary className="activity-summary question-record-summary">
        <MessageSquare size={15} />
        <span>提问</span>
        <small className="request-hint">
          {hasAnswers ? "回答已发送" : answers ? "已拒答" : "提问已结束"}
        </small>
        <ChevronRight className="question-record-chevron" size={14} />
      </summary>
      <div className="question-record-content">
        {children}
        {replying && replyForm
          ? replyForm
          : questions.map((question) => {
              const values = answers?.[question.id]?.answers;
              return (
                <section className="question" key={question.id}>
                  <p>{question.question}</p>
                  {question.options?.map((option, index) => {
                    const selected = values?.includes(option.label);
                    return (
                      <div
                        className={
                          "answer-option recorded-option " +
                          (selected ? "selected" : "")
                        }
                        key={index}
                      >
                        {selected && <Check size={15} aria-label="已选择" />}
                        <span>
                          <b>{option.label}</b>
                          {option.description && (
                            <small>{option.description}</small>
                          )}
                        </span>
                      </div>
                    );
                  })}
                  {values?.length > 0 && (
                    <p className="recorded-answer">
                      <b>你的回答：</b>
                      {question.isSecret ? "已提交私密回答" : values.join("\n")}
                    </p>
                  )}
                  {values?.length === 0 && (
                    <p className="request-hint">已拒答</p>
                  )}
                </section>
              );
            })}
        {replyForm && !replying && (
          <div className="request-actions">
            <button className="secondary" onClick={() => setReplying(true)}>
              补充回答
            </button>
          </div>
        )}
      </div>
    </details>
  );
}

export function UserInputForm({
  questions,
  isCompleted = false,
  draftKey,
  disabled = false,
  onSubmit,
}) {
  const prefix = useId();
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState(() => drafts.get(draftKey) || {});
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState("");
  const result = Object.fromEntries(
    questions.map((question) => {
      const { choice, text = "", declined } = answers[question.id] || {};
      const value =
        typeof choice === "number"
          ? question.options?.[choice]?.label
          : question.isSecret
            ? text
            : text.trim();
      return [question.id, { answers: declined ? [] : [value || ""] }];
    }),
  );
  const incomplete =
    !questions.length ||
    Object.values(result).some(
      ({ answers }) => answers.length && !answers[0].trim(),
    );
  const allDeclined = questions.every(
    (question) => answers[question.id]?.declined,
  );
  const locked = disabled || submitting || submitted;
  const currentIndex = Math.min(index, questions.length - 1);
  const question = questions[currentIndex];
  if (!question) return null;
  const answer = answers[question.id] || {};
  const hasOptions = !!question.options?.length;
  const allowOther = question.isOther !== false || !hasOptions;
  const textInput = {
    id: `${prefix}-${question.id}-text`,
    className: "free-answer",
    "aria-label": question.question,
    placeholder: question.isSecret ? "输入私密回答" : "输入你的回答",
    value: answer.text || "",
    onChange: (event) => update(question.id, { text: event.target.value }),
  };
  function move(step) {
    const next = currentIndex + step;
    if (next >= 0 && next < questions.length) setIndex(next);
  }
  function update(id, patch) {
    setAnswers((current) => {
      const next = { ...current, [id]: { ...current[id], ...patch } };
      if (draftKey) drafts.set(draftKey, next);
      return next;
    });
    setError("");
  }
  function submit(event) {
    event.preventDefault();
    if (!incomplete) return sendAnswers(result);
  }
  function toggleDeclined() {
    const declined = !answer.declined;
    update(question.id, { declined });
    if (!declined) return;
    const next = { ...result, [question.id]: { answers: [] } };
    if (Object.values(next).every(({ answers }) => answers.length === 0))
      return sendAnswers(next);
  }
  async function sendAnswers(result) {
    if (locked) return;
    setSubmitting(true);
    setError("");
    try {
      if ((await onSubmit(result)) === false)
        setError("回答发送失败，请检查连接后重试。");
      else {
        drafts.delete(draftKey);
        setSubmitted(true);
      }
    } catch (error) {
      setError(error.message || "回答发送失败，请重试。");
    } finally {
      setSubmitting(false);
    }
  }
  return (
    <form
      className="request-card user-input-card"
      onSubmit={submit}
      onKeyDown={(event) => {
        if (
          event.key !== "Enter" ||
          event.nativeEvent.isComposing ||
          event.keyCode === 229 ||
          event.target.tagName === "BUTTON"
        )
          return;
        if (event.shiftKey && event.target.tagName === "TEXTAREA") return;
        return submit(event);
      }}
    >
      <div className="request-title">
        <MessageSquare size={18} />
        {isCompleted ? "补充回答" : "提问"}
        {questions.length > 1 && (
          <div
            className="question-navigation"
            role="group"
            aria-label="切换问题"
          >
            <button
              type="button"
              className="secondary"
              aria-label="上一题"
              aria-disabled={currentIndex === 0 || undefined}
              onClick={() => move(-1)}
            >
              <ChevronLeft size={16} />
            </button>
            <span aria-live="polite">
              {currentIndex + 1} / {questions.length}
            </span>
            <button
              type="button"
              className="secondary"
              aria-label="下一题"
              aria-disabled={currentIndex === questions.length - 1 || undefined}
              onClick={() => move(1)}
            >
              <ChevronRight size={16} />
            </button>
          </div>
        )}
      </div>
      <fieldset
        className="question"
        key={question.id}
        disabled={locked}
        aria-label={question.question}
      >
        <p>{question.question}</p>
        {answer.declined ? (
          <p className="request-hint" role="status">
            已拒答
          </p>
        ) : (
          <>
            {question.options?.map((option, index) => (
              <label
                className={
                  "answer-option " + (answer.choice === index ? "selected" : "")
                }
                key={index}
              >
                <input
                  type="radio"
                  name={`${prefix}-${question.id}`}
                  checked={answer.choice === index}
                  onChange={() => update(question.id, { choice: index })}
                />
                <span>
                  <b>{option.label}</b>
                  {option.description && <small>{option.description}</small>}
                </span>
              </label>
            ))}
            {hasOptions && allowOther && (
              <label
                className={
                  "answer-option " +
                  (answer.choice === "other" ? "selected" : "")
                }
              >
                <input
                  type="radio"
                  name={`${prefix}-${question.id}`}
                  checked={answer.choice === "other"}
                  onChange={() => update(question.id, { choice: "other" })}
                />
                <span>其他回答</span>
              </label>
            )}
            {allowOther && (!hasOptions || answer.choice === "other") && (
              <>
                {question.isSecret ? (
                  <input {...textInput} type="password" autoComplete="off" />
                ) : (
                  <ResizableTextarea
                    {...textInput}
                    rows={1}
                    disabled={locked}
                  />
                )}
              </>
            )}
          </>
        )}
      </fieldset>
      <div className="request-actions">
        <button
          type="button"
          className="secondary"
          disabled={locked}
          onClick={toggleDeclined}
        >
          {answer.declined ? "恢复作答" : "拒答此题"}
        </button>
        <button
          type="submit"
          className="primary"
          disabled={locked || incomplete}
          title={error || undefined}
        >
          {submitting ? (
            "正在提交…"
          ) : submitted ? (
            allDeclined ? (
              "已拒答"
            ) : (
              "已提交回答"
            )
          ) : error ? (
            <span role="alert">重试</span>
          ) : (
            "提交回答"
          )}
        </button>
      </div>
    </form>
  );
}
