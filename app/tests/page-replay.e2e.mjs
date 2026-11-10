import { chromium } from "playwright";
import path from "node:path";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { zipSync, strToU8 } from "fflate";

const url = "https://example.test/recorded";
const page = (opened) => `<!doctype html><html><head><style>body{font:16px sans-serif}</style></head><body>
  <button id="open">打开</button><div id="other">其他位置</div><p id="status">${opened ? "已打开" : "未打开"}</p>
  <input id="customer" type="text" value="初始客户"><input id="check" type="checkbox">
  <select id="choice"><option data-logic-node="101" value="a" selected>甲</option><option data-logic-node="102" value="b">乙</option></select>
  <div id="component"><template shadowrootmode="open" data-logic-shadow-root><button id="shadow-action">组件执行</button></template></div>
  <button id="duplicate">重复一</button><button id="duplicate">重复二</button>
  <a id="external" href="https://example.test/probe">外部链接</a><img src="https://example.test/probe"><script>fetch('https://example.test/probe')</script>
  </body></html>`;
const context = { tabId: 1, frameId: 0, documentId: "doc-1" };
const events = [
  { ...context, id: "snapshot-initial", seq: 1, time: 100, kind: "page.snapshot", payload: { url, status: "captured", html: page(false) } },
  { ...context, id: "click-open", seq: 2, time: 110, kind: "interaction.click", payload: { url, target: { tag: "button", selector: "#open", text: "打开" } } },
  { ...context, id: "snapshot-opened", seq: 3, time: 115, kind: "page.snapshot", payload: { url, status: "captured", html: page(true) } },
  { ...context, id: "input-customer", seq: 4, time: 120, kind: "interaction.input", payload: { url, target: { tag: "input", type: "text", selector: "#customer" }, beforeValue: "初始客户", value: "新客户" } },
  { ...context, id: "change-check", seq: 5, time: 130, kind: "interaction.change", payload: { url, target: { tag: "input", type: "checkbox", selector: "#check" }, beforeFormState: { checked: false }, formState: { checked: true } } },
  { ...context, id: "change-choice", seq: 6, time: 140, kind: "interaction.change", payload: { url, target: { tag: "select", selector: "#choice" }, beforeFormState: { multiple: false, selectedIndices: [0], options: [{ id: "101", label: "甲", value: "a" }, { id: "102", label: "乙", value: "b" }] }, formState: { multiple: false, selectedIndices: [1], options: [{ id: "101", label: "甲", value: "a" }, { id: "102", label: "乙", value: "b" }] } } },
  { ...context, id: "shadow-click", seq: 7, time: 150, kind: "interaction.click", payload: { url, target: { tag: "button", selector: null, shadowPath: ["#component", "#shadow-action"], text: "组件执行" } } },
  { ...context, id: "duplicate", seq: 8, time: 160, kind: "interaction.click", payload: { url, target: { tag: "button", selector: "#duplicate", text: "重复" } } },
  { ...context, id: "missing", seq: 9, time: 170, kind: "interaction.click", payload: { url, target: { tag: "button", selector: "#missing", text: "缺失" } } },
  { ...context, documentId: "doc-2", id: "reloaded", seq: 10, time: 180, kind: "interaction.click", payload: { url, target: { tag: "button", selector: "#open", text: "刷新后" } } },
  { ...context, documentId: "doc-3", id: "final-snapshot", seq: 11, time: 190, kind: "page.snapshot", payload: { url: "https://example.test/finished", reason: "stop", status: "captured", html: '<!doctype html><html><body><div id="ending">保存成功</div></body></html>' } },
];
function archiveFor(records, title) {
  const manifest = { format: "logic-recorder", version: 2, session: { id: "page-replay", title, startedAt: 1 }, eventCount: records.length, eventChunks: ["timeline/events-00001.jsonl"] };
  const files = {
    "manifest.json": strToU8(JSON.stringify(manifest)),
    "timeline/events-00001.jsonl": strToU8(records.map((event) => JSON.stringify(event)).join("\n")),
  };
  files["integrity.json"] = strToU8(JSON.stringify(Object.entries(files).map(([entryPath, bytes]) => ({ path: entryPath, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }))));
  return Buffer.from(zipSync(files));
}
const profile = await fs.mkdtemp(path.resolve("test-page-replay-profile-"));
const extension = path.resolve("dist");
let browser;
try {
  browser = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.CHROME_BIN || chromium.executablePath(),
    headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  const worker = browser.serviceWorkers()[0] || await browser.waitForEvent("serviceworker", { timeout: 15000 });
  const panel = await browser.newPage();
  await panel.setViewportSize({ width: 360, height: 800 });
  let probes = 0;
  await browser.route("**/probe", (route) => { probes++; return route.abort(); });
  await panel.goto(`chrome-extension://${new URL(worker.url()).host}/sidepanel.html`);
  await panel.getByRole("button", { name: "导入记录包" }).click();
  await panel.locator('input[type="file"]').first().setInputFiles({ name: "replay.zip", mimeType: "application/zip", buffer: archiveFor(events, "页面复现测试") });
  await panel.getByRole("heading", { name: "页面复现测试" }).waitFor();
  await panel.getByRole("button", { name: "复现", exact: true }).click();
  await panel.getByRole("button", { name: "页面", exact: true }).click();
  const frame = panel.frameLocator('iframe[title="逐步复现页面"]');
  await frame.locator("#status").getByText("未打开").waitFor();
  await fs.mkdir(path.resolve("test-artifacts"), { recursive: true });
  await panel.screenshot({ path: path.resolve("test-artifacts/page-replay.png") });
  await frame.locator("#other").click();
  await panel.getByText("步骤 1 / 8").waitFor();
  await frame.locator("#open").click();
  await panel.getByText("步骤 2 / 8").waitFor();
  await frame.locator("#status").getByText("已打开").waitFor();
  if ((await frame.locator("#customer").inputValue()) !== "初始客户") throw new Error("页面中未显示输入前原值");
  await frame.locator("#customer").fill("新客户");
  await panel.getByText("步骤 3 / 8").waitFor();
  if ((await frame.locator("#customer").inputValue()) !== "新客户") throw new Error("前一步输入未保留在页面状态中");
  await frame.locator("#check").check();
  await panel.getByText("步骤 4 / 8").waitFor();
  if (!(await frame.locator("#check").isChecked())) throw new Error("前一步选择未保留在页面状态中");
  await frame.locator("#choice").selectOption("b", { timeout: 5000 }).catch(async (error) => {
    if (!(await panel.getByText("步骤 5 / 8").count())) throw error;
  });
  await panel.getByText("步骤 5 / 8").waitFor();
  await frame.locator("#shadow-action").click();
  await panel.getByText("步骤 6 / 8").waitFor();
  await panel.getByText("当前操作的页面元素无法唯一定位").waitFor();
  await panel.getByRole("button", { name: "下一步" }).click();
  await panel.getByText("步骤 7 / 8").waitFor();
  await panel.getByText("当前操作的页面元素无法唯一定位").waitFor();
  await panel.getByRole("button", { name: "下一步" }).click();
  await panel.getByText("步骤 8 / 8").waitFor();
  await panel.getByText("此操作之前没有可用的页面快照").waitFor();
  if (await panel.locator('iframe[title="逐步复现页面"]').count()) throw new Error("刷新后错误使用了上一页面实例的快照");
  await panel.getByRole("button", { name: "完成" }).click();
  await panel.getByRole("status").getByText("已到达记录末尾").waitFor();
  await panel.getByText("录制停止时的页面状态").waitFor();
  await frame.locator("#ending").getByText("保存成功").waitFor();
  await panel.getByRole("button", { name: "上一步" }).click();
  if (await panel.getByRole("status").count()) throw new Error("返回上一步后仍显示流程已结束");
  async function openScenario(records, title) {
    await panel.locator('.viewer-top input[type="file"]').setInputFiles({ name: "scenario.zip", mimeType: "application/zip", buffer: archiveFor(records, title) });
    await panel.getByRole("heading", { name: title }).waitFor();
    await panel.getByRole("button", { name: "复现", exact: true }).click();
    await panel.getByRole("button", { name: "页面", exact: true }).click();
  }
  const initial = { ...context, id: "single-snapshot", seq: 1, time: 1, kind: "page.snapshot", payload: { url, status: "captured", html: '<!doctype html><html><body><button id="apply">提交</button><p data-logic-node="1"><!--logic-text:2-->旧状态</p></body></html>' } };
  const lastClick = { ...context, id: "last-click", seq: 2, time: 2, kind: "interaction.click", payload: { url, target: { tag: "button", selector: "#apply", text: "提交" } } };
  const mutation = { ...context, id: "last-mutation", seq: 3, time: 3, kind: "page.mutation", payload: { url, status: "captured", changes: [{ type: "text", id: "2", value: "已更新" }] } };
  await openScenario([initial, lastClick, mutation], "末尾变化测试");
  await frame.locator("#apply").click();
  await panel.getByText("后续记录的页面变化").waitFor();
  await frame.getByText("已更新").waitFor();
  if (!(await frame.locator("#apply").isDisabled())) throw new Error("结束状态仍可触发页面操作");
  const navigation = { id: "unobserved-navigation", seq: 3, time: 3, tabId: 1, frameId: 0, kind: "navigation.committed", payload: { url: "https://example.test/unobserved" } };
  await openScenario([initial, lastClick, navigation], "末尾跳转测试");
  await frame.locator("#apply").click();
  await panel.getByText("未取得最后操作后的页面状态").waitFor();
  if (await panel.locator('iframe[title="逐步复现页面"]').count()) throw new Error("跳转后错误显示了跳转前的页面");
  const closeTab = { kind: "tab.closed", id: "closed-tab", seq: 4, time: 4, payload: { tabId: 1 } };
  const beforeClose = { ...initial, id: "before-close", seq: 3, time: 3 };
  await openScenario([initial, lastClick, beforeClose, closeTab], "末尾关闭标签测试");
  await frame.locator("#apply").click();
  await panel.getByText("未取得最后操作后的页面状态").waitFor();
  if (await panel.locator('iframe[title="逐步复现页面"]').count()) throw new Error("关闭标签后错误显示了关闭前的页面");
  const created = { kind: "tab.created", id: "tab-created", seq: 3, time: 3, payload: { tabId: 2, openerTabId: 1 } };
  const activated = { kind: "tab.activated", id: "tab-activated", seq: 4, time: 4, payload: { tabId: 2 } };
  const childSnapshot = { id: "child-final", seq: 5, time: 5, tabId: 2, frameId: 0, documentId: "child", kind: "page.snapshot", payload: { url: "https://example.test/new-tab", status: "captured", html: '<!doctype html><html><body><div id="new-tab">新标签内容</div></body></html>' } };
  const originalSnapshot = { ...initial, id: "original-final", seq: 6, time: 6, payload: { ...initial.payload, reason: "stop" } };
  await openScenario([initial, lastClick, created, activated, childSnapshot, originalSnapshot], "末尾新标签测试");
  await frame.locator("#apply").click();
  await panel.getByText("后续激活的新标签页状态（按时间关联）").waitFor();
  await frame.locator("#new-tab").getByText("新标签内容").waitFor();
  await openScenario([initial, lastClick, activated, childSnapshot, originalSnapshot], "末尾切换标签测试");
  await frame.locator("#apply").click();
  await panel.getByText("后续激活的标签页状态", { exact: true }).waitFor();
  await frame.locator("#new-tab").getByText("新标签内容").waitFor();
  await panel.waitForTimeout(200);
  if (probes) throw new Error("页面复现访问了原站点");
  console.log("侧边栏页面交互复现、状态顺序和离线隔离通过");
} finally {
  if (browser) await browser.close();
  await fs.rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}
