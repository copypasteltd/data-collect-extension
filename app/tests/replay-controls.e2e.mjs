import { chromium } from "playwright";
import path from "node:path";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { zipSync, strToU8 } from "fflate";

const events = [
  {
    id: "check",
    seq: 1,
    time: 1,
    kind: "interaction.change",
    tabId: 1,
    frameId: 0,
    payload: {
      url: "https://example.test/",
      target: {
        tag: "input",
        type: "checkbox",
        name: "确认",
        selector: "#check",
        rect: { x: 10, y: 10, width: 20, height: 20 },
      },
      viewport: { width: 100, height: 100, scrollX: 0, scrollY: 0 },
      value: "on",
      formState: { checked: true },
      beforeFormState: { checked: false },
    },
  },
  {
    id: "radio",
    seq: 2,
    time: 2,
    kind: "interaction.change",
    tabId: 1,
    frameId: 0,
    payload: {
      url: "https://example.test/",
      target: { tag: "input", type: "radio", name: "方案", selector: "#radio", rect: { x: 10, y: 10, width: 20, height: 20 } },
      viewport: { width: 100, height: 100, scrollX: 0, scrollY: 0 },
      value: "on",
      formState: { checked: true },
    },
  },
  {
    id: "select",
    seq: 3,
    time: 3,
    kind: "interaction.change",
    tabId: 1,
    frameId: 0,
    payload: {
      url: "https://example.test/",
      target: { tag: "select", name: "项目", selector: "#select" },
      value: "a",
      formState: {
        selectedIndices: [0, 2],
        multiple: true,
        options: [{ id: "a1", label: "A1" }, { id: "b", label: "B" }, { id: "a2", label: "A2" }],
      },
      beforeFormState: {
        selectedIndices: [1],
        multiple: true,
        options: [{ id: "a1", label: "A1" }, { id: "b", label: "B" }, { id: "a2", label: "A2" }],
      },
    },
  },
  {
    id: "finish",
    seq: 4,
    time: 4,
    kind: "interaction.click",
    tabId: 1,
    frameId: 0,
    payload: {
      url: "https://example.test/",
      target: { tag: "button", text: "完成", selector: "#finish" },
    },
  },
];
for (const [id, documentId, value, selector, beforeValue, beforeValueStatus] of [
  ["text-before-refresh", "document-1", "旧页面", "#text", "初始客户", "redacted"],
  ["text-after-refresh", "document-2", "新页面", "#text", "刷新默认值", "constructor"],
  ["text-same-document", "document-2", "新页面内容", "#text", "同步后的值", "truncated"],
  ["text-without-selector", "document-2", "其他输入", undefined],
]) {
  events.push({
    id,
    seq: events.length + 1,
    time: events.length + 1,
    kind: "interaction.input",
    tabId: 1,
    frameId: 0,
    documentId,
    payload: {
      url: "https://example.test/",
      target: { tag: "input", type: "text", selector },
      value,
      ...(beforeValue !== undefined ? { beforeValue } : {}),
      ...(beforeValueStatus ? { beforeValueStatus } : {}),
    },
  });
}
for (const [id, value] of [["shadow-input-1", "组件A"], ["shadow-input-2", "组件AB"]]) {
  events.push({
    id, seq: events.length + 1, time: events.length + 1,
    kind: "interaction.input", tabId: 1, frameId: 0, documentId: "document-2",
    payload: { url: "https://example.test/", target: { tag: "input", type: "text", selector: null, shadowPath: ["#host", "#field"] }, value },
  });
}
events.push({
  id: "changed-options", seq: 11, time: 11, kind: "interaction.change", tabId: 1, frameId: 0, documentId: "document-2",
  payload: { url: "https://example.test/", target: { tag: "select", selector: "#changed-options" },
    formState: { multiple: false, selectedIndices: [1], options: [{ id: "new-a", label: "A", value: "a" }, { id: "b", label: "B", value: "b" }] },
    beforeFormState: { multiple: false, selectedIndices: [0], options: [{ id: "old-a", label: "A", value: "a" }, { id: "b", label: "B", value: "b" }] },
  },
});
events.push(
  {
    id: "before-shot", seq: 12, time: 0.5, tabId: 1, kind: "screenshot",
    payload: { assetId: "before", capturedAt: 0.5, url: "https://example.test/", viewport: { width: 100, height: 100, scrollX: 0, scrollY: 0 } },
  },
  {
    id: "after-shot", seq: 13, time: 1.5, tabId: 1, kind: "screenshot",
    payload: { eventIds: ["check"], status: "unavailable", reason: "操作后截图测试失败" },
  },
  {
    id: "shifted-shot", seq: 14, time: 2.5, tabId: 1, kind: "screenshot",
    payload: { assetId: "shifted", eventIds: ["radio"], capturedAt: 2.5, url: "https://example.test/", viewport: { width: 100, height: 100, scrollX: 0, scrollY: 50 } },
  },
  {
    id: "api-candidate", seq: 15, time: 1.1, tabId: 1, kind: "network.request",
    payload: { requestId: "api-candidate", type: "Fetch", method: "GET", url: "https://example.test/api/customers", sourceFrame: "main", documentUrl: "https://example.test/" },
  },
  {
    id: "image-asset", seq: 16, time: 1.2, tabId: 1, kind: "network.request",
    payload: { requestId: "image-asset", type: "Image", method: "GET", url: "https://example.test/asset.png", sourceFrame: "main", documentUrl: "https://example.test/" },
  },
  {
    id: "other-frame", seq: 17, time: 1.3, tabId: 1, kind: "network.request",
    payload: { requestId: "other-frame", type: "Fetch", method: "GET", url: "https://example.test/api/other", sourceFrame: "embedded", documentUrl: "https://example.test/" },
  },
  {
    id: "main-snapshot", seq: 18, time: 0.25, tabId: 1, frameId: 0, documentId: "main-doc", kind: "page.snapshot",
    payload: { url: "https://example.test/", status: "captured", html: '<!doctype html><html><body><div id="parent-page">主页面</div></body></html>' },
  },
  {
    id: "intervening-scroll", seq: 19, time: 0.75, tabId: 1, frameId: 0, kind: "interaction.scroll",
    payload: { url: "https://example.test/", targetScope: "document", scrollLeft: 0, scrollTop: 10 },
  },
  {
    id: "final-shot", seq: 20, time: 11.5, tabId: 1, kind: "screenshot",
    payload: { assetId: "final", eventIds: ["changed-options"], capturedAt: 11.5, url: "https://example.test/", viewport: { width: 100, height: 100, scrollX: 0, scrollY: 0 } },
  },
);
const manifest = {
  format: "logic-recorder",
  version: 2,
  session: { id: "replay-test", title: "选择复现测试", startedAt: 1 },
  eventCount: events.length,
  eventChunks: ["timeline/events-00001.jsonl"],
};
const files = {
  "manifest.json": strToU8(JSON.stringify(manifest)),
  "timeline/events-00001.jsonl": strToU8(
    events.map((event) => JSON.stringify(event)).join("\n"),
  ),
  "screenshots/before.jpg": new Uint8Array(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64")),
  "screenshots/shifted.jpg": new Uint8Array(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64")),
  "screenshots/final.jpg": new Uint8Array(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64")),
};
files["integrity.json"] = strToU8(
  JSON.stringify(
    Object.entries(files).map(([entryPath, bytes]) => ({
      path: entryPath,
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    })),
  ),
);
const profile = await fs.mkdtemp(path.resolve("test-replay-profile-"));
const extension = path.resolve("dist");
let context;
try {
  context = await chromium.launchPersistentContext(profile, {
    executablePath:
      process.env.CHROME_BIN || chromium.executablePath(),
    headless: true,
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
    ],
  });
  const worker =
    context.serviceWorkers()[0] ||
    (await context.waitForEvent("serviceworker", { timeout: 15000 }));
  const panel = await context.newPage();
  await panel.setViewportSize({ width: 360, height: 780 });
  await panel.goto(
    `chrome-extension://${new URL(worker.url()).host}/sidepanel.html`,
  );
  await panel.getByRole("button", { name: "导入记录包" }).click();
  await panel
    .locator("input[type=file]")
    .first()
    .setInputFiles({
      name: "replay.zip",
      mimeType: "application/zip",
      buffer: Buffer.from(zipSync(files)),
    });
  await panel.getByRole("heading", { name: "选择复现测试" }).waitFor();
  await panel.getByRole("button", { name: "复现", exact: true }).click();
  await panel.getByAltText("该步骤关联的页面截图").waitFor();
  await panel.getByText(/截图与操作之间有其他操作或页面变化/).waitFor();
  await panel.getByText(/截图页面实例未确认/).waitFor();
  if (await panel.locator(".replay-hotspot").count()) throw new Error("截图之后发生滚动时仍标示操作位置");
  await panel.getByRole("button", { name: "操作后", exact: true }).click();
  await panel.getByText("操作后截图测试失败").waitFor();
  if (await panel.getByAltText("该步骤关联的页面截图").count())
    throw new Error("截图缺失时显示了其他步骤的旧图片");
  await panel.getByRole("button", { name: "操作前", exact: true }).click();
  await panel.getByAltText("该步骤关联的页面截图").waitFor();
  if (await panel.getByText("操作前选择状态未取得").count()) throw new Error("已记录的复选框原状态被标为未知");
  await panel.getByLabel("复现勾选").click();
  await panel.getByText("步骤 2 / 11").waitFor();
  await panel.getByText("操作前选择状态未取得").waitFor();
  await panel.getByRole("button", { name: "操作后", exact: true }).click();
  await panel.getByAltText("该步骤关联的页面截图").waitFor();
  if (await panel.locator(".replay-hotspot").count())
    throw new Error("截图滚动位置变化后仍显示操作位置");
  await panel.getByLabel("复现勾选").click();
  await panel.getByText("步骤 3 / 11").waitFor();
  if (JSON.stringify(await panel.getByLabel("复现选择").evaluate((node) => [...node.selectedOptions].map((option) => option.value))) !== '["1"]') throw new Error("多选控件未显示记录的操作前选择");
  await panel.getByLabel("复现选择").selectOption(["0", "2"]);
  await panel.getByText("步骤 4 / 11").waitFor();
  await panel.getByRole("button", { name: "下一步" }).click();
  const textInput = panel.getByLabel("输入记录值");
  if ((await textInput.inputValue()) !== "初始客户")
    throw new Error("首次输入未显示记录的操作前值");
  await panel.getByText("操作前输入值已脱敏").waitFor();
  await textInput.fill("旧页面");
  await panel.getByText("步骤 6 / 11").waitFor();
  if ((await textInput.inputValue()) !== "刷新默认值")
    throw new Error("页面刷新后的输入未使用新页面的操作前值");
  await textInput.fill("新页面");
  await panel.getByText("步骤 7 / 11").waitFor();
  if ((await textInput.inputValue()) !== "同步后的值")
    throw new Error("操作前值没有覆盖可能已经过时的上次输入");
  await panel.getByText("操作前输入值过长，已截断").waitFor();
  await textInput.fill("新页面内容");
  await panel.getByText("步骤 8 / 11").waitFor();
  if ((await textInput.inputValue()) !== "")
    throw new Error("缺少元素定位信息时错误地复用了输入值");
  await panel.getByText("操作前输入值未取得").waitFor();
  await textInput.fill("其他输入");
  await panel.getByText("步骤 9 / 11").waitFor();
  await textInput.fill("组件A");
  await panel.getByText("步骤 10 / 11").waitFor();
  if ((await textInput.inputValue()) !== "组件A")
    throw new Error("组件内连续输入没有保留前一次的值");
  await panel.getByText("显示最近一次记录值，操作前状态未确认").waitFor();
  await textInput.fill("组件AB");
  await panel.getByText("步骤 11 / 11").waitFor();
  await panel.getByText("操作前选择状态未取得").waitFor();
  if ((await panel.getByLabel("复现选择").inputValue()) !== "") throw new Error("选项节点变化后错误沿用了旧选择");
  await panel.getByLabel("复现选择").selectOption("1");
  await panel.getByRole("status").getByText("已到达记录末尾").waitFor();
  await panel.getByRole("button", { name: "操作后", exact: true, pressed: true }).waitFor();
  await panel.getByRole("button", { name: /^流程 \d+$/ }).click();
  const candidate = panel.getByRole("button", { name: /GET https:\/\/example\.test\/api\/customers/ });
  await candidate.waitFor();
  if (await panel.getByRole("button", { name: /asset\.png|api\/other/ }).count()) throw new Error("流程错误地关联了静态资源或其他页面的请求");
  await candidate.click();
  await panel.getByText("事件详情 · #15").waitFor();
  await panel.getByText("请求页面实例未确认，页面状态仅供参考").waitFor();
  await panel.getByRole("button", { name: "查看可能相关的操作" }).click();
  await panel.getByText("事件详情 · #1").waitFor();
  await panel.getByPlaceholder("搜索记录").fill("other-frame");
  await panel.locator(".timeline-item").first().click();
  await panel.getByText("事件详情 · #17").waitFor();
  await panel.getByText("请求所属页面快照无法确认").waitFor();
  if (await panel.locator('iframe[title="页面快照"]').count()) throw new Error("嵌入页面请求错误显示了主页面快照");
  console.log("侧边栏表单复现及页面刷新状态隔离通过");
} finally {
  if (context) await context.close();
  await fs.rm(profile, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 250,
  });
}
