const answerPrefix = "回答：";
const declined = "已拒答";

export function questionReply(questions, answers) {
  return questions
    .map(
      ({ title }, index) =>
        `${title}\n${answers[index] === null ? declined : answerPrefix + answers[index]}`,
    )
    .join("\n\n");
}

export function questionRecordAnswers(answers) {
  return (
    answers &&
    Object.fromEntries(
      answers.map((text, index) => [
        String(index),
        { answers: text === null ? [] : [text] },
      ]),
    )
  );
}

export function questionAnswers(questions, text) {
  const answers = [];
  let remaining = text.trim();
  for (const [index, question] of questions.entries()) {
    const prefix = `${question.title}\n`;
    if (!remaining.startsWith(prefix)) return null;
    remaining = remaining.slice(prefix.length);
    const next = questions[index + 1];
    const end = next
      ? Math.min(
          ...[answerPrefix, declined]
            .map((marker) => remaining.indexOf(`\n\n${next.title}\n${marker}`))
            .filter((index) => index >= 0),
        )
      : remaining.length;
    if (!Number.isFinite(end)) return null;
    const reply = remaining.slice(0, end);
    if (reply === declined) answers.push(null);
    else if (
      reply.startsWith(answerPrefix) &&
      reply.slice(answerPrefix.length).trim()
    )
      answers.push(reply.slice(answerPrefix.length));
    else return null;
    remaining = remaining.slice(end).trimStart();
  }
  return answers;
}

// 按发送顺序匹配整批问题，一条回答只归属最近一张匹配的卡片。
export function asyncQuestionState(items) {
  const answered = new Map();
  const responses = new Set();
  const pending = [];
  const questions = new Set(
    items.filter((item) => item.questions?.length).map((item) => item.id),
  );
  for (const item of items) {
    if (item.type === "agentMessage" && item.questions?.length) {
      pending.push(item);
      if (item.questionAnswers) answered.set(item.id, item.questionAnswers);
    }
    if (questions.has(item.questionId)) responses.add(item.id);
    if (item.type !== "userMessage" || item.optimistic) continue;
    const text = (item.content || [])
      .filter((content) => content.type === "text")
      .map((content) => content.text)
      .join("\n");
    const indexes = [...pending.keys()].reverse();
    const associated = pending.findIndex(
      (question) =>
        question.id === item.questionId ||
        (question.questionAnswers &&
          JSON.stringify(questionAnswers(question.questions, text)) ===
            JSON.stringify(question.questionAnswers)),
    );
    if (associated >= 0) indexes.unshift(associated);
    for (const index of indexes) {
      const question = pending[index];
      const answers = questionAnswers(question.questions, text);
      if (!answers) continue;
      answered.set(question.id, answers);
      responses.add(item.id);
      pending.splice(index, 1);
      break;
    }
  }
  return { answered, responses };
}

export function inputRequestItem(request, answers) {
  return {
    id: `user-input-${request.id}`,
    type: "userInputRequest",
    turnId: request.params.turnId,
    request,
    answers,
  };
}
