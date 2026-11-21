export function settingsPage(page, title) {
  return page
    .getByRole("navigation", { name: "设置分类", exact: true })
    .getByRole("button", { name: title, exact: true });
}
