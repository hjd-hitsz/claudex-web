const flatten = (options) =>
  (options || []).flatMap((entry) => entry.options || [entry]);

export function acpConfiguration(response) {
  const options = response.configOptions || [];
  const model = options.find(({ category }) => category === "model");
  const effort = options.find(({ category }) => category === "thought_level");
  const choices = flatten(model?.options);
  const efforts = new Map(
    flatten(effort?.options).map((item) => [item.value, item]),
  );
  const available = response.models?.availableModels;
  const variants = new Map();
  for (const { modelId } of available || []) {
    const family =
      choices.find(({ value }) => value === modelId) ||
      choices
        .filter(({ value }) => modelId.startsWith(value + "-"))
        .sort((a, b) => b.value.length - a.value.length)[0];
    if (!family) continue;
    if (!variants.has(family.value)) variants.set(family.value, []);
    if (family.value !== modelId)
      variants.get(family.value).push(modelId.slice(family.value.length + 1));
  }
  return {
    model: model?.currentValue,
    effort: effort?.currentValue,
    modelOptionId: model?.id,
    effortOptionId: effort?.id,
    mode: options.find(({ category }) => category === "mode"),
    models: choices
      .filter(({ value }) => !Array.isArray(available) || variants.has(value))
      .map(({ value, name, description }) => {
        const current = model.currentValue === value;
        const supported =
          variants.get(value) || (current ? [...efforts.keys()] : []);
        const ordered = [
          ...[...efforts.keys()].filter((id) => supported.includes(id)),
          ...supported.filter((id) => !efforts.has(id)),
        ];
        return {
          id: value,
          model: value,
          displayName: name,
          description,
          isDefault: current,
          supportedReasoningEfforts: ordered.map((id) => ({
            reasoningEffort: id,
            description: efforts.get(id)?.description,
          })),
          defaultReasoningEffort:
            current && supported.includes(effort?.currentValue)
              ? effort.currentValue
              : undefined,
        };
      }),
  };
}
