import React, { useEffect, useState } from "react";
import {
  DelegationPromptEditor,
  DelegationPromptSelect,
} from "./delegation-prompt-editor.jsx";
import { saveBackend, useStoreSelector } from "../../store.js";
import { isModelHidden, modelChoiceLabel } from "../../domain/backends.js";
import { BackendBadge } from "../backends/backend-badge.jsx";
import { reasoningEffortLabels } from "../composer/reasoning-effort.jsx";

const key = ({ providerId = "", model }) => JSON.stringify([providerId, model]);
const executors = [
  ["codex", "Codex"],
  ["claude", "Claude Code"],
];

const sources = [...executors, ["agy", "Antigravity"]];

export function DelegationSettings({ active }) {
  const backends = useStoreSelector((state) => state.backends);
  const models = useStoreSelector((state) => state.modelChoices || []);
  const agy = backends.find(({ id }) => id === "agy");
  const stored = JSON.stringify({
    delegates: agy?.delegates || {},
    delegationPrompts: agy?.delegationPrompts || [],
    delegationSourcePrompts: agy?.delegationSourcePrompts || {},
  });
  const [draft, setDraft] = useState(() => JSON.parse(stored));
  const [selectedId, select] = useState("");
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState(null);
  const {
    delegates,
    delegationPrompts: prompts,
    delegationSourcePrompts,
  } = draft;
  const selected = prompts.find(({ id }) => id === selectedId);
  useEffect(() => setDraft(JSON.parse(stored)), [stored]);

  const modified = JSON.stringify(draft) !== stored;
  const invalid = prompts.some(
    ({ name, content }, index) =>
      !name.trim() ||
      !content.trim() ||
      prompts
        .slice(0, index)
        .some((other) => other.name.trim() === name.trim()),
  );
  function update(value) {
    setFeedback(null);
    setDraft(value);
  }
  function change(id, patch) {
    update({
      ...draft,
      delegates: { ...delegates, [id]: { ...delegates[id], ...patch } },
    });
  }
  function updatePrompt(patch) {
    update({
      ...draft,
      delegationPrompts: prompts.map((prompt) =>
        prompt === selected ? { ...prompt, ...patch } : prompt,
      ),
    });
  }
  function addPrompt(content) {
    const id = crypto.randomUUID();
    let number = prompts.length + 1;
    while (prompts.some(({ name }) => name === "提示词 " + number)) number++;
    update({
      ...draft,
      delegationPrompts: [
        ...prompts,
        { id, name: "提示词 " + number, content },
      ],
    });
    select(id);
  }
  function removePrompt() {
    update({
      ...draft,
      delegationSourcePrompts: Object.fromEntries(
        Object.entries(delegationSourcePrompts).map(([id, promptId]) => [
          id,
          promptId === selectedId ? "" : promptId,
        ]),
      ),
      delegationPrompts: prompts.filter(({ id }) => id !== selectedId),
    });
    select("");
  }
  async function save(event) {
    event.preventDefault();
    if (!modified || invalid || saving) return;
    setSaving(true);
    setFeedback(null);
    try {
      await saveBackend({ id: "agy", type: "agy", ...draft });
      setFeedback({ message: "委派设置已保存" });
    } catch (error) {
      setFeedback({ error: true, message: error.message });
    } finally {
      setSaving(false);
    }
  }
  return (
    <form
      className="delegation-settings"
      aria-labelledby="settings-delegation-title"
      onSubmit={save}
    >
      <fieldset className="delegation-fields" disabled={saving}>
        <section
          className="delegation-section"
          aria-labelledby="delegation-targets-title"
        >
          <h3 id="delegation-targets-title">接收委派</h3>
          <div className="delegation-routes">
            {executors.map(([id, name]) => {
              const route = delegates[id] || {};
              const backend = backends.find((entry) => entry.id === id);
              const choices = models.filter(
                (entry) =>
                  entry.backendId === id &&
                  !isModelHidden(backend, entry.model, entry.providerId),
              );
              return (
                <DelegationRoute
                  key={id}
                  name={name}
                  id={id}
                  route={route}
                  choices={choices}
                  change={(patch) => change(id, patch)}
                />
              );
            })}
          </div>
        </section>
        <section
          className="delegation-section"
          aria-labelledby="delegation-sources-title"
        >
          <h3 id="delegation-sources-title">发起委派</h3>
          <div className="delegation-sources">
            {sources.map(([id, name]) => (
              <label key={id}>
                <span>
                  <BackendBadge backendId={id} /> {name}
                </span>
                <DelegationPromptSelect
                  label={name + " 发起提示词"}
                  value={delegationSourcePrompts[id] || ""}
                  prompts={prompts}
                  onChange={(promptId) =>
                    update({
                      ...draft,
                      delegationSourcePrompts: {
                        ...delegationSourcePrompts,
                        [id]: promptId,
                      },
                    })
                  }
                />
              </label>
            ))}
          </div>
        </section>
        <DelegationPromptEditor
          active={active}
          selected={selected}
          select={select}
          prompts={prompts}
          add={addPrompt}
          update={updatePrompt}
          remove={removePrompt}
        />
      </fieldset>
      <div className="delegation-save">
        {feedback && (
          <span role={feedback.error ? "alert" : "status"}>
            {feedback.message}
          </span>
        )}
        <button
          type="submit"
          className="primary"
          disabled={saving || !modified || invalid}
        >
          {saving ? "正在保存…" : "保存委派设置"}
        </button>
      </div>
    </form>
  );
}

function DelegationRoute({ id, name, route, choices, change }) {
  const selected = choices.find((choice) => key(choice) === key(route));
  const efforts = selected?.supportedReasoningEfforts || [];
  return (
    <section className="delegation-route" aria-label={name}>
      <label className="delegation-receive">
        <span>
          <BackendBadge backendId={id} /> {name}
        </span>
        <input
          className="settings-switch"
          type="checkbox"
          aria-label={name + " 接收委派"}
          checked={route.enabled === true}
          onChange={(event) => change({ enabled: event.target.checked })}
        />
      </label>
      <div className="delegation-model">
        <label>
          模型
          <select
            aria-label={name + " 执行模型"}
            value={route.model ? key(route) : ""}
            onChange={(event) => {
              const [providerId, model] = event.target.value
                ? JSON.parse(event.target.value)
                : ["", ""];
              change({
                providerId,
                model,
                effort: "",
              });
            }}
          >
            <option value="">后端默认</option>
            {route.model && !selected && (
              <option value={key(route)}>{route.model}</option>
            )}
            {choices.map((choice) => (
              <option key={key(choice)} value={key(choice)}>
                {modelChoiceLabel(choice)}
              </option>
            ))}
          </select>
        </label>
        <label>
          思考强度
          <select
            aria-label={name + " 执行思考强度"}
            value={route.effort || ""}
            disabled={!route.model}
            onChange={(event) => change({ effort: event.target.value })}
          >
            <option value="">默认</option>
            {route.effort &&
              !efforts.some(
                ({ reasoningEffort }) => reasoningEffort === route.effort,
              ) && (
                <option value={route.effort}>
                  {reasoningEffortLabels[route.effort] || route.effort}
                </option>
              )}
            {efforts.map(({ reasoningEffort }) => (
              <option key={reasoningEffort} value={reasoningEffort}>
                {reasoningEffortLabels[reasoningEffort] || reasoningEffort}
              </option>
            ))}
          </select>
        </label>
      </div>
    </section>
  );
}
