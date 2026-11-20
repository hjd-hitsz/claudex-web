import { testThreadFolderDrag } from "./thread-folder-drag.mjs";
import { testInputQueue } from "./input-queue.mjs";
import { testFolderPicker } from "./folder-picker.mjs";
import { testPlans } from "./plans.mjs";
import { testServiceTierControls } from "./service-tier-controls.mjs";
import { testReasoningControls } from "./reasoning-controls.mjs";
import { testProjectFolders } from "./project-folders.mjs";
import { testProjectlessCreation } from "./projectless-creation.mjs";
import { testDraftSubmission } from "./draft-submission.mjs";
import { testAttachmentDrafts } from "./attachment-drafts.mjs";
import { testVersionDetails } from "./version-details.mjs";
import { testProcessDisplay } from "./process-display.mjs";
import { testProcessSteering } from "./process-steering.mjs";
import { testProcessCommands } from "./process-commands.mjs";
import { testTranslationLifecycle } from "./translation-lifecycle.mjs";
import { testComposerKeyboard } from "./composer-keyboard.mjs";
import { testTerminalLifecycle } from "./terminal-lifecycle.mjs";
import { testThreadSorting } from "./thread-sorting.mjs";
import { testTokenUsage } from "./token-usage.mjs";
import { testProjectSnapshot } from "./project-snapshot.mjs";
import { testQuestionInteraction } from "./question-interaction.mjs";
import { testAuthentication } from "./auth.mjs";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

import { testMermaid } from "./mermaid.mjs";
import { testMessageImages } from "./message-image.mjs";
import { testMarkdownHtml } from "./markdown-html.mjs";
import { testToolActivities } from "./tool-activities.mjs";
import { testThreadAccess } from "./thread-access.mjs";
import { testThreadArchive } from "./thread-archive.mjs";
import { testThreadUnread } from "./thread-unread.mjs";
import { testThreadNames } from "./thread-names.mjs";
import { testForkTitles } from "./fork-titles.mjs";
import { testAnnotations } from "./annotations.mjs";
import { testUserMessage } from "./user-message.mjs";
import { testFilePanel } from "./file-panel.mjs";
import { testFileChanges } from "./file-changes.mjs";
import { testProcessTiming } from "./process-timing.mjs";
import { testQuestions } from "./questions.mjs";
import { testConnectionLifecycle } from "./connection-lifecycle.mjs";
import { testConnectionRecovery } from "./connection-recovery.mjs";
import { testProjectModels } from "./project-models.mjs";
import { testAccountUsage } from "./account-usage.mjs";
import { testHistory } from "./history.mjs";
import { testProgressiveHistory } from "./progressive-history.mjs";
import { testHistoryTranslations } from "./history-translations.mjs";
import { testConversationScroll } from "./conversation-scroll.mjs";
import { testComposerPerformance } from "./composer-performance.mjs";
import { testMessageNavigation } from "./message-navigation.mjs";
import { testContextPanel } from "./context-panel.mjs";
import { testCommands } from "./commands.mjs";
import { testCompaction } from "./compaction.mjs";
import { testCompactionDisplay } from "./compaction-display.mjs";
import { testCompactionRecovery } from "./compaction-recovery.mjs";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const storage = new Map();
globalThis.localStorage = {
  getItem: (k) => storage.get(k) ?? null,
  setItem: (k, v) => storage.set(k, v),
  removeItem: (k) => storage.delete(k),
};
globalThis.location = { protocol: "http:", host: "component-test" };
globalThis.ResizeObserver = class {
  observe() {}
  disconnect() {}
};
globalThis.testTerminals = [];
const fixture = {
  requests: [],
  socket: null,
  responseFor: (m) =>
    m.method === "thread/list" ? { data: [], nextCursor: null } : {},
};
const { requests } = fixture;
const setResponse = (respond) => (fixture.responseFor = respond);
const emit = (method, params) => fixture.socket.emit(method, params);
const getSocket = () => fixture.socket;
globalThis.WebSocket = class {
  static OPEN = 1;
  readyState = 1;
  constructor() {
    fixture.socket = this;
  }
  send(raw) {
    const m = JSON.parse(raw);
    requests.push(m);
    if (!m.method || m.method === "command/exec") return;
    Promise.resolve(fixture.responseFor(m)).then((result) =>
      this.onmessage({
        data: JSON.stringify({
          id: m.id,
          ...(result.error ? { error: result.error } : { result }),
        }),
      }),
    );
  }
  emit(method, params, id) {
    return this.onmessage({ data: JSON.stringify({ method, params, id }) });
  }
};
localStorage.setItem(
  "cx-summary-zh-v1",
  JSON.stringify([["Reviewing local configuration", "历史缓存不应展示"]]),
);
const app = await import(
  pathToFileURL(process.env.CODEX_COMPONENT_BUNDLE).href
);
app.applySession({
  authenticated: true,
  username: "fixture",
  expiresAt: Date.now() + 86400000,
});
assert.equal(storage.has("cx-summary-zh-v1"), false);
await testMermaid(app);
await testInputQueue(app, fixture);
await testFolderPicker(app, fixture);
{
  const previousResponse = fixture.responseFor;
  try {
    await testAccountUsage(app, requests, setResponse, emit);
    await testCommands(app, requests, setResponse, emit);
    await testCompactionDisplay(app);
    await testCompaction(app, requests, setResponse, emit);
    await testCompactionRecovery(app, requests, setResponse, emit, getSocket);
    await testHistory(app, requests, setResponse, emit);
    await testProgressiveHistory(app, requests, setResponse, emit);
    await testConversationScroll(app);
    await testComposerPerformance(app);
    await testHistoryTranslations(app);
    await testMessageNavigation(app);
    await testContextPanel(app, requests, setResponse, emit);
    await testThreadAccess(app, requests, setResponse, emit);
    await testTokenUsage(app, fixture);
    await testThreadArchive(app, requests, setResponse, emit);
    await testForkTitles(app, requests, setResponse);
    await testThreadUnread(app, setResponse, emit);
    await testThreadNames(app, setResponse, emit);
    await testMessageImages(app, requests, setResponse);
    await testMarkdownHtml(app, requests, setResponse);
    await testToolActivities(app, requests, setResponse, emit);
    await testAnnotations(app, requests, setResponse);
    await testUserMessage(app, requests, setResponse);
    await testFilePanel(app, requests, setResponse);
    await testFileChanges(app, requests, setResponse, emit);
    await testPlans(app, fixture);
    await testProcessTiming(app, requests, setResponse, emit);
    await testQuestions(app, requests, setResponse, emit);
    await testConnectionLifecycle(app, requests, setResponse, emit, getSocket);
    await testAuthentication(app, setResponse, getSocket);
    await testConnectionRecovery(app, requests, setResponse, emit);
    await testProjectModels(app, requests, setResponse, emit);
  } finally {
    fixture.responseFor = previousResponse;
  }
}
await testServiceTierControls(app, fixture);
await testReasoningControls(app, fixture);
await testProjectFolders(app, fixture);
await testThreadFolderDrag(app, fixture);
await testProjectlessCreation(app, fixture);
await testDraftSubmission(app, fixture);
await testAttachmentDrafts(app, fixture);
await testVersionDetails(app, fixture);
await testProcessDisplay(app, fixture);
await testProcessSteering(app, fixture);
await testProcessCommands(app, fixture);
await testTranslationLifecycle(app, fixture);
await testComposerKeyboard(app, fixture);
await testTerminalLifecycle(app, fixture);
await testThreadSorting(app, fixture);
await testProjectSnapshot(app, fixture);
await testQuestionInteraction(app, fixture);
