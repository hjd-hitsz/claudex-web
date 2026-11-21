import assert from "node:assert/strict";
import React, { act } from "react";
import { create } from "react-test-renderer";

import { projectGroups } from "../../client/src/domain/thread-order.js";
export async function testProjectSnapshot(app, fixture) {
  const { requests } = fixture;
  {
    const original = app.get();
    const previousResponse = fixture.responseFor;
    const threads = [
      { id: "stable-a-new", cwd: "/stable-a", completedAt: 100 },
      { id: "stable-b", cwd: "/stable-b", completedAt: 90 },
      { id: "stable-a-old", cwd: "/stable-a", completedAt: 10 },
    ].map((thread) => ({ ...thread, createdAt: 1, updatedAt: 1 }));
    const archived = new Set();
    const archiveOnly = {
      id: "archive-only-fixture",
      cwd: "/archive-only",
      createdAt: 2,
      updatedAt: 2,
    };
    const withArchiveState = (thread) => ({
      ...thread,
      path: archived.has(thread.id) ? "/fixture/archived_sessions/" : "",
    });
    fixture.responseFor = ({ method, params }) => {
      if (method === "lan/projectless/read") return { directories: {} };
      if (method === "thread/archive") archived.add(params.threadId);
      if (method === "thread/unarchive") archived.delete(params.threadId);
      if (method === "thread/list")
        return {
          data: [...threads, archiveOnly]
            .filter((thread) => archived.has(thread.id) === params.archived)
            .map(withArchiveState),
        };
      if (method === "thread/turns/list")
        return {
          data: [
            {
              status: "completed",
              completedAt: threads.find(
                (thread) => thread.id === params.threadId,
              ).completedAt,
            },
          ],
        };
      if (method === "thread/resume" || method === "thread/read")
        return {
          thread: withArchiveState(
            threads.find((thread) => thread.id === params.threadId),
          ),
        };
      if (method === "thread/items/list") return { data: [] };
      return {};
    };
    const paths = () => {
      const s = app.get();
      return projectGroups(
        s.threads,
        s.projects,
        s.pins,
        s.projectlessDirectories,
        s.projectlessRoot,
        s.projectOrder,
      ).map(([path]) => path);
    };
    try {
      archived.add(archiveOnly.id);
      app.set({
        current: null,
        threads: [],
        projects: [],
        projectOrder: null,
        pins: [],
        archived: false,
        search: "",
      });
      await app.loadThreads();
      const initial = ["/stable-a", "/stable-b", ""];
      assert.deepEqual(paths(), initial);
      await app.archive(threads[0]);
      assert.deepEqual(paths(), initial);
      await app.archive(threads[2]);
      assert.deepEqual(paths(), initial);
      assert(!app.get().threads.some((thread) => thread.cwd === "/stable-a"));
      await app.loadThreads({ archived: true });
      assert(paths().includes(archiveOnly.cwd));
      assert.deepEqual(app.get().projectOrder, initial);
      await app.loadThreads({ archived: false });
      assert.deepEqual(paths(), initial);
      let emptyProject;
      await act(async () => {
        emptyProject = create(
          React.createElement(app.ProjectGroup, { path: "/stable-a" }),
        );
      });
      await act(async () =>
        emptyProject.root
          .findByProps({ title: "在 stable-a 中新建对话" })
          .props.onClick(),
      );
      assert.equal(app.get().cwd, "/stable-a");
      assert.equal(app.get().current, null);
      await act(async () => emptyProject.unmount());
      await app.loadThreads({ archived: true });
      assert(paths().includes(archiveOnly.cwd));
      await app.archive(
        app.get().threads.find((thread) => thread.id === threads[0].id),
      );
      assert.equal(app.get().archived, false);
      assert.deepEqual(paths(), initial);
      app.addProject("/aaa-new");
      await app.loadThreads();
      assert.deepEqual(paths(), ["/aaa-new", ...initial]);
      threads[1].completedAt = 200;
      threads[1].updatedAt++;
      await act(async () =>
        fixture.socket.emit("turn/completed", {
          threadId: threads[1].id,
          turn: { id: "stable-turn", status: "completed", completedAt: 200 },
        }),
      );
      assert.equal(app.get().threads[0].id, "stable-b");
      assert.deepEqual(paths(), ["/aaa-new", ...initial]);
      threads.push({
        id: "stable-external",
        cwd: "/external-new",
        createdAt: 1,
        updatedAt: 1,
        completedAt: 5,
      });
      await app.loadThreads();
      assert.deepEqual(paths(), ["/aaa-new", "/external-new", ...initial]);
      app.set({ projectOrder: null });
      await app.loadThreads();
      assert.deepEqual(paths(), [
        "/aaa-new",
        "/stable-b",
        "/stable-a",
        "/external-new",
        "",
      ]);
      const beforeArchive = paths();
      for (const thread of threads.filter((thread) => !archived.has(thread.id)))
        await app.archive(thread);
      assert.equal(app.get().threads.length, 0);
      assert.deepEqual(paths(), beforeArchive);
      await app.loadThreads();
      assert.deepEqual(paths(), beforeArchive);
      app.set({ projectOrder: null });
      await app.loadThreads();
      assert.deepEqual(paths(), ["/aaa-new", ""]);
    } finally {
      app.set(original);
      fixture.responseFor = previousResponse;
    }
    console.log(
      "PASS 项目初始快照、全部归档保留空项目与新建入口、恢复保序、新增项目置前、重载重算",
    );
  }
}
