export function settingsPage(page, title) {
  return page
    .getByRole("navigation", { name: "设置分类", exact: true })
    .getByRole("button", { name: title, exact: true });
}

export function settingsBackend(page, name) {
  return {
    async click() {
      const compact = page.getByRole("combobox", { name: "选择要配置的后端" });
      if (await compact.isVisible())
        await compact.selectOption({ label: name });
      else
        await page
          .getByRole("group", { name: "选择要配置的后端" })
          .getByRole("button", { name, exact: true })
          .click();
    },
  };
}

export async function openSettingsPage(page, title) {
  const compact = page.getByRole("combobox", { name: "设置分类", exact: true });
  if (await compact.isVisible()) await compact.selectOption({ label: title });
  else await settingsPage(page, title).click();
}

export async function switchComposerBackend(page, name) {
  await page.getByRole("button", { name: /^切换后端，当前为 / }).click();
  await page
    .getByRole("group", { name: "切换后端", exact: true })
    .getByRole("button", { name, exact: true })
    .click();
  await page
    .getByRole("button", { name: `切换后端，当前为 ${name}`, exact: true })
    .waitFor();
}
