import React, { useId, useRef, useState } from "react";
import { ExternalLink, ListChecks } from "lucide-react";
import { respond } from "../../store.js";
import {
  elicitationContent,
  elicitationFields,
  elicitationUrl,
} from "../../domain/elicitation.js";

const formats = { email: "email", uri: "url", date: "date" };

function Field({ field, value, update, error }) {
  const id = useId();
  const description = id + "-help";
  const described =
    [field.description && description, error && id + "-error"]
      .filter(Boolean)
      .join(" ") || undefined;
  const attributes = {
    "data-elicitation-field": field.name,
    "aria-describedby": described,
    "aria-invalid": error ? true : undefined,
  };
  const choices =
    field.type === "boolean"
      ? [
          { value: true, label: "是" },
          { value: false, label: "否" },
        ]
      : field.choices;
  const options = (
    <>
      {field.description && <small id={description}>{field.description}</small>}
      {error && (
        <small role="alert" id={id + "-error"}>
          {error}
        </small>
      )}
    </>
  );
  const title = (
    <>
      {field.label}
      {field.required && <span aria-hidden="true"> *</span>}
    </>
  );
  if (field.type === "array")
    return (
      <fieldset className="elicitation-field" {...attributes}>
        <legend>{title}</legend>
        {options}
        <div className="elicitation-choices">
          {choices.map(({ value: option, label }) => (
            <label key={option}>
              <input
                type="checkbox"
                checked={value?.includes(option) ?? false}
                onChange={(event) =>
                  update(
                    event.target.checked
                      ? [...(value ?? []), option]
                      : (value ?? []).filter((item) => item !== option),
                  )
                }
              />
              {label}
            </label>
          ))}
        </div>
      </fieldset>
    );
  return (
    <div className="elicitation-field">
      <label htmlFor={id}>{title}</label>
      {options}
      {choices ? (
        <select
          id={id}
          {...attributes}
          required={field.required}
          value={
            value === undefined
              ? ""
              : choices.findIndex((option) => option.value === value)
          }
          onChange={(event) =>
            update(
              event.target.value === ""
                ? undefined
                : choices[Number(event.target.value)].value,
            )
          }
        >
          <option value="">请选择</option>
          {choices.map(({ value: option, label }, index) => (
            <option key={String(option)} value={index}>
              {label}
            </option>
          ))}
        </select>
      ) : (
        <input
          id={id}
          {...attributes}
          required={field.required}
          type={
            field.type === "string" ? formats[field.format] || "text" : "number"
          }
          step={field.type === "integer" ? 1 : "any"}
          value={value ?? ""}
          onChange={(event) => update(event.target.value)}
        />
      )}
    </div>
  );
}

export function Elicitation({ request, connected }) {
  const { executorName, serverName, mode, message, url, requestedSchema } =
    request.params;
  const fields = mode === "url" ? null : elicitationFields(requestedSchema);
  const destination = mode === "url" ? elicitationUrl(url) : null;
  const [values, setValues] = useState(
    () =>
      new Map((fields ?? []).map(({ name, default: value }) => [name, value])),
  );
  const [errors, setErrors] = useState(new Map());
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const sending = useRef(false);
  const form = useRef(null);

  async function send(result) {
    if (sending.current) return;
    sending.current = true;
    setPending(true);
    setError("");
    if (
      await respond(request, result, undefined, (failure) =>
        setError(failure.message),
      )
    )
      return;
    sending.current = false;
    setPending(false);
  }

  function submit(event) {
    event.preventDefault();
    if (destination) return send({ action: "accept" });
    if (!fields) return;
    const { content, errors: invalid } = elicitationContent(fields, values);
    setErrors(invalid);
    if (!invalid.size) return send({ action: "accept", content });
    const first = invalid.keys().next().value;
    const element = [
      ...form.current.querySelectorAll("[data-elicitation-field]"),
    ].find((field) => field.dataset.elicitationField === first);
    (element?.querySelector("input") ?? element)?.focus();
  }

  return (
    <form
      ref={form}
      className="request-card elicitation-card"
      onSubmit={submit}
    >
      <div className="request-title">
        {mode === "url" ? <ExternalLink size={17} /> : <ListChecks size={17} />}
        <span>
          {[executorName, serverName, mode === "url" ? "外部授权" : "信息请求"]
            .filter(Boolean)
            .join(" · ")}
        </span>
      </div>
      {message && <p className="elicitation-message">{message}</p>}
      {destination && (
        <a
          className="elicitation-destination"
          href={destination.href}
          target="_blank"
          rel="noopener noreferrer"
        >
          <span>{destination.host}</span>
          <ExternalLink size={15} aria-hidden="true" />
        </a>
      )}
      {fields && (
        <fieldset
          className="elicitation-fields"
          disabled={!connected || pending}
        >
          {fields.map((field) => (
            <Field
              key={field.name}
              field={field}
              value={values.get(field.name)}
              error={errors.get(field.name)}
              update={(value) => {
                setValues((previous) =>
                  new Map(previous).set(field.name, value),
                );
                setErrors((previous) => {
                  const updated = new Map(previous);
                  updated.delete(field.name);
                  return updated;
                });
              }}
            />
          ))}
        </fieldset>
      )}
      {!fields && !destination && (
        <p className="inline-error" role="alert">
          {mode === "url"
            ? "授权链接须使用 HTTPS，且不包含登录凭据。"
            : "此请求包含不受支持的表单字段。"}
        </p>
      )}
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      <div className="request-actions">
        <button
          type="button"
          className="secondary"
          disabled={!connected || pending}
          onClick={() => send({ action: "decline" })}
        >
          取消请求
        </button>
        {(fields || destination) && (
          <button
            type="submit"
            className="primary"
            disabled={!connected || pending}
          >
            {mode === "url" ? "已完成授权" : "确认提交"}
          </button>
        )}
      </div>
    </form>
  );
}
