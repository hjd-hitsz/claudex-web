export function createOpenCodeQuestions({
  sdk,
  sessions,
  active,
  notify,
  publish,
}) {
  const entries = new Map();
  async function add(value, kind) {
    const threadId = await sessions.logicalId(value.sessionID);
    const fields =
      kind === "permission"
        ? [
            {
              key: "decision",
              title: value.action,
              description: value.message || value.resources.join("\n"),
              type: "string",
              options: [
                { value: "once", label: "允许本次" },
                { value: "always", label: "始终允许" },
                { value: "reject", label: "拒绝" },
              ],
            },
          ]
        : value.fields;
    const question = {
      id: value.id,
      method: "item/tool/requestUserInput",
      params: {
        threadId,
        turnId: active.get(threadId),
        itemId: value.id,
        questions: fields
          .filter((f) => !f.hidden)
          .map((field) => ({
            id: field.key,
            header: value.title || field.title || "OpenCode",
            question: field.description || field.title || field.key,
            isOther: !field.options || field.custom === true,
            isSecret: false,
            options: field.options?.map((o) => ({
              label: o.label || o.value,
              description: o.description || "",
            })),
            multiSelect: field.type === "multiselect",
          })),
      },
    };
    entries.set(value.id, { kind, value, fields, question });
    notify(question.method, question.params, question.id);
    publish();
  }
  async function answer(message) {
    const entry = entries.get(String(message.id));
    if (!entry) return;
    const answer = {};
    for (const field of entry.fields) {
      const values = message.result?.answers?.[field.key]?.answers || [];
      const translated = values.map(
        (value) =>
          field.options?.find((o) => (o.label || o.value) === value)?.value ||
          value,
      );
      answer[field.key] =
        field.type === "multiselect"
          ? translated
          : field.type === "boolean"
            ? translated[0] === "true"
            : ["number", "integer"].includes(field.type)
              ? Number(translated[0])
              : translated.join(", ");
    }
    const sessionID = entry.value.sessionID;
    if (entry.kind === "permission")
      await sdk().permission.reply({
        sessionID,
        requestID: entry.value.id,
        decision: message.error ? "reject" : answer.decision,
      });
    else if (message.error)
      await sdk().sessions.form.cancel({ sessionID, formID: entry.value.id });
    else
      await sdk().sessions.form.reply({
        sessionID,
        formID: entry.value.id,
        answer,
      });
    remove(entry.value.id);
  }
  function remove(id) {
    if (entries.delete(id)) {
      notify("serverRequest/resolved", { requestId: id });
      publish();
    }
  }
  async function recover(sessionIDs) {
    for (const sessionID of sessionIDs) {
      const [forms, permissions] = await Promise.all([
        sdk().sessions.form.list({ sessionID }),
        sdk().permission.list({ sessionID }),
      ]);
      for (const form of forms) await add(form, "form");
      for (const permission of permissions) await add(permission, "permission");
    }
  }
  return { entries, add, answer, remove, recover };
}
