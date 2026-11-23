export function speedVariant(effort, tier) {
  return tier
    ? `${effort || "default"}@${tier === "fast" ? "priority" : tier}`
    : effort;
}

export function subscriptionVariants(model) {
  const efforts = (model.supportedReasoningEfforts || []).map(
    (entry) => entry.reasoningEffort,
  );
  const speeds =
    model.serviceTiers ||
    (model.additionalSpeedTiers || []).map((id) => ({
      id: id === "fast" ? "priority" : id,
    }));
  return [null, ...speeds.map((entry) => entry.id)].flatMap((tier) =>
    ["", ...efforts].flatMap((effort) => {
      if (!effort && !tier) return [];
      return [
        {
          id: speedVariant(effort, tier),
          body: {
            ...(effort && { reasoning: { effort } }),
            ...(tier && { service_tier: tier }),
          },
        },
      ];
    }),
  );
}

export function sessionModelSettings(ref, catalogue) {
  if (!ref) return { model: "", reasoningEffort: "", serviceTier: null };
  const model = catalogue.find(
    (entry) => entry.providerID === ref.providerID && entry.id === ref.id,
  );
  const variant = model?.variants.find((entry) => entry.id === ref.variant);
  const body = { ...model?.body, ...variant?.body };
  const settings = { ...model?.settings, ...variant?.settings };
  return {
    model: `${ref.providerID}/${ref.providerID === "openai" ? model?.modelID || ref.id : ref.id}`,
    reasoningEffort:
      ref.providerID === "openai"
        ? body.reasoning?.effort || settings.reasoningEffort || ""
        : ref.variant || "",
    serviceTier: body.service_tier || settings.serviceTier || null,
  };
}
