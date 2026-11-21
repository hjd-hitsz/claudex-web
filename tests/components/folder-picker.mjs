import assert from "node:assert/strict";
import React, { act } from "react";
import { create } from "react-test-renderer";

export async function testFolderPicker(app, fixture) {
  const previous = fixture.responseFor;
  const original = app.get();
  app.set({ connected: true });
  let view;
  let chosen;
  let finishSlowRead;
  const listing = {
    entries: [
      { fileName: ".config", isDirectory: true },
      { fileName: "project", isDirectory: true },
      { fileName: "readme.txt", isDirectory: false },
    ],
  };
  fixture.responseFor = (request) => {
    if (request.method !== "fs/readDirectory") return previous(request);
    if (request.params.path === "/missing")
      return { error: { message: "目录不存在" } };
    if (request.params.path === "/fixture/project")
      return new Promise((resolve) => {
        finishSlowRead = () => resolve(listing);
      });
    return listing;
  };
  const mount = async () => {
    await act(async () => {
      view = create(
        React.createElement(app.FolderPicker, {
          initial: "/fixture",
          onChoose: (path) => {
            chosen = path;
          },
        }),
      );
    });
  };
  const rows = () =>
    view.root
      .findByProps({ className: "directory-list" })
      .findAllByType("button");
  const names = () => rows().map((row) => row.findByType("span").children[0]);
  const checkbox = () => view.root.findByProps({ type: "checkbox" });
  const crumbs = () => view.root.findByType("nav").findAllByType("button");
  const crumbPaths = () => crumbs().map((crumb) => crumb.props.title);
  const edit = () => view.root.findByProps({ "aria-label": "编辑目录路径" });
  const address = () => view.root.findByProps({ "aria-label": "目录路径" });
  const choose = () => view.root.findByProps({ className: "primary" });
  const enter = () =>
    address().props.onKeyDown({ key: "Enter", nativeEvent: {} });
  try {
    await mount();
    assert.deepEqual(names(), ["project"]);
    assert.deepEqual(crumbPaths(), ["/", "/fixture"]);
    assert.equal(crumbs()[0].findByType("span").children[0], "/");
    assert.equal(checkbox().props.checked, false);
    await act(async () =>
      checkbox().props.onChange({ target: { checked: true } }),
    );
    assert.deepEqual(names(), [".config", "project"]);
    await act(async () => rows()[0].props.onClick());
    assert.deepEqual(crumbPaths(), ["/", "/fixture", "/fixture/.config"]);
    assert.equal(crumbs().at(-1).props["aria-current"], "location");
    assert.equal(checkbox().props.checked, true);
    await act(async () =>
      checkbox().props.onChange({ target: { checked: false } }),
    );
    assert.deepEqual(names(), ["project"]);
    await act(async () => choose().props.onClick());
    assert.equal(chosen, "/fixture/.config");

    await act(async () => crumbs()[0].props.onClick());
    assert.deepEqual(crumbPaths(), ["/"]);
    await act(async () => edit().props.onClick());
    assert.equal(address().props.value, "/");
    await act(async () =>
      address().props.onChange({ target: { value: "/missing" } }),
    );
    await act(enter);
    assert.equal(
      view.root.findByProps({ role: "alert" }).children[0],
      "目录不存在",
    );
    assert.equal(address().props.value, "/missing");
    await act(async () =>
      address().props.onChange({
        target: { value: "/fixture/.config/Team Files/" },
      }),
    );
    await act(enter);
    assert.deepEqual(crumbPaths(), [
      "/",
      "/fixture",
      "/fixture/.config",
      "/fixture/.config/Team Files/",
    ]);
    await act(async () => crumbs()[1].props.onClick());
    assert.deepEqual(crumbPaths(), ["/", "/fixture"]);
    await act(async () => {
      rows()[0].props.onClick();
    });
    assert.equal(choose().props.disabled, true);
    await act(async () => crumbs()[0].props.onClick());
    await act(async () => finishSlowRead());
    assert.deepEqual(crumbPaths(), ["/"]);
    await act(async () => choose().props.onClick());
    assert.equal(chosen, "/");
    await act(async () => view.unmount());
    await mount();
    assert.equal(checkbox().props.checked, false);
    assert.deepEqual(names(), ["project"]);
  } finally {
    if (view) await act(async () => view.unmount());
    fixture.responseFor = previous;
    app.set(original);
  }
  console.log(
    "PASS 文件夹层级跳转、路径输入与失败恢复、迟到响应隔离及隐藏目录切换",
  );
}
