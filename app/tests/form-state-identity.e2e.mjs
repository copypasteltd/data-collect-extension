import { chromium } from "playwright";
import path from "node:path";
import fs from "node:fs/promises";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { zipSync, strToU8 } from "fflate";

const options = [
  { id: "101", label: "甲", value: "a" },
  { id: "102", label: "乙", value: "b" },
];
const select = '<select id="choice"><option data-logic-node="101" value="a" selected>甲</option><option data-logic-node="102" value="b">乙</option></select>';
const scenarios = [
  { id: "correct", html: select, value: "b", state: { selectedIndices: [1], options, multiple: false }, expected: "b" },
  { id: "changed-id", html: select, value: "b", state: { selectedIndices: [1], options: [options[0], { ...options[1], id: "999" }], multiple: false }, expected: "a", issue: "选项身份或选择状态无法确认" },
  { id: "changed-value", html: select, value: "b", state: { selectedIndices: [1], options: [options[0], { ...options[1], value: "other" }], multiple: false }, expected: "a", issue: "选项身份或选择状态无法确认" },
  { id: "uncertain", html: select, value: "b", state: { selectedIndices: [1], options: [options[0], { ...options[1], uncertain: true }], multiple: false }, expected: "a", issue: "选项身份或选择状态无法确认" },
  { id: "truncated", html: select, value: "b", state: { selectedIndices: [1], options, optionsTruncated: true }, expected: "a", issue: "部分选项状态超过采集上限" },
  { id: "legacy-unique", html: select, value: "b", expected: "b" },
  { id: "legacy-ambiguous", html: '<select id="choice"><option value="a" selected>甲</option><option value="b">乙</option><option value="b">丙</option></select>', value: "b", expected: "a", issue: "选项身份或选择状态无法确认" },
  { id: "legacy-indices", html: select, value: "b", state: { selectedIndices: [1] }, expected: "a", issue: "选项身份或选择状态无法确认" },
  { id: "duplicate-target", html: '<input id="same" type="text" value="原一"><input id="same" type="text" value="原二">', target: { tag: "input", type: "text", selector: "#same" }, value: "错误值", issue: "输入或选择的目标无法唯一确认" },
  { id: "wrong-target", html: select, target: { tag: "input", selector: "#choice" }, value: "b", expected: "a", issue: "输入或选择的目标无法唯一确认" },
  { id: "replaced-target", html: '<input id="field" data-logic-node="101" value="旧控件">', target: { tag: "input", selector: "#field", nodeId: "102" }, value: "新控件内容", issue: "输入或选择的目标无法唯一确认" },
  { id: "duplicate-shadow", html: '<div id="host"><template data-logic-shadow-root shadowrootmode="open"><input id="field" value="原一"></template></div><div id="host"><template data-logic-shadow-root shadowrootmode="open"><input id="field" value="原二"></template></div>', target: { tag: "input", shadowPath: ["#host", "#field"] }, value: "错误值", issue: "输入或选择的目标无法唯一确认" },
];
const events = [];
for (const [index, scenario] of scenarios.entries()) {
  const time = index * 10 + 1, url = `https://example.test/${scenario.id}`;
  const context = { tabId: index + 1, frameId: 0, documentId: `doc-${scenario.id}` };
  events.push({ ...context, id: `snapshot-${scenario.id}`, seq: time, time, kind: "page.snapshot",
    payload: { url, status: "captured", html: `<!doctype html><html><body>${scenario.html}</body></html>` } });
  events.push({ ...context, id: `change-${scenario.id}`, seq: time + 1, time: time + 1, kind: "interaction.change",
    payload: { url, target: scenario.target || { tag: "select", selector: "#choice" }, value: scenario.value,
      ...(scenario.state ? { formState: scenario.state } : {}) } });
}
const manifest = { format: "logic-recorder", version: 2, session: { id: "form-identity", title: "表单状态核对", startedAt: 1 },
  eventCount: events.length, eventChunks: ["timeline/events-00001.jsonl"] };
const files = { "manifest.json": strToU8(JSON.stringify(manifest)),
  "timeline/events-00001.jsonl": strToU8(events.map((event) => JSON.stringify(event)).join("\n")) };
files["integrity.json"] = strToU8(JSON.stringify(Object.entries(files).map(([entryPath, bytes]) => ({
  path: entryPath, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"),
}))));
const profile = await fs.mkdtemp(path.resolve("test-form-identity-profile-"));
const extension = path.resolve("dist");
let context;
try {
  context = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.CHROME_BIN || chromium.executablePath(), headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker", { timeout: 15000 });
  const panel = await context.newPage();
  await panel.setViewportSize({ width: 360, height: 780 });
  await panel.goto(`chrome-extension://${new URL(worker.url()).host}/sidepanel.html`);
  await panel.getByRole("button", { name: "导入记录包" }).click();
  await panel.locator('input[type="file"]').first().setInputFiles({ name: "forms.zip", mimeType: "application/zip", buffer: Buffer.from(zipSync(files)) });
  await panel.getByRole("heading", { name: "表单状态核对" }).waitFor();
  const frame = panel.frameLocator('iframe[title="页面快照"]');
  for (const scenario of scenarios) {
    await panel.getByPlaceholder("搜索记录").fill(`change-${scenario.id}`);
    await panel.locator(".timeline-item").first().click();
    if (scenario.expected != null)
      await panel.waitForFunction((expected) => document.querySelector('iframe[title="页面快照"]')?.contentDocument?.querySelector("#choice")?.value === expected, scenario.expected);
    if (scenario.issue) await panel.locator(".detail-content .notice.error").getByText(scenario.issue, { exact: false }).waitFor();
    else assert.equal(await panel.locator(".detail-content .notice.error").count(), 0, `${scenario.id} 不应提示身份不明`);
    if (scenario.id === "duplicate-target")
      assert.deepEqual(await frame.locator("#same").evaluateAll((nodes) => nodes.map((node) => node.value)), ["原一", "原二"]);
    if (scenario.id === "replaced-target") assert.equal(await frame.locator("#field").inputValue(), "旧控件");
    if (scenario.id === "duplicate-shadow")
      assert.deepEqual(await frame.locator("#host").evaluateAll((nodes) => nodes.map((node) => node.shadowRoot.querySelector("#field").value)), ["原一", "原二"]);
  }
  console.log("选项身份、截断、旧记录及重复目标的页面状态还原通过");
} finally {
  if (context) await context.close();
  await fs.rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}
