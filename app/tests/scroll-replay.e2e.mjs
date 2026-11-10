import { chromium } from "playwright";
import path from "node:path";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { zipSync, strToU8 } from "fflate";

const events = [
  {
    id: "initial-scroll", seq: 1, time: 1, tabId: 1, frameId: 0,
    documentId: "doc", kind: "page.snapshot",
    payload: {
      url: "https://example.test/", status: "captured",
      html: `<!doctype html><html><body style="height:1500px"><div id="first" data-logic-node="1" style="height:40px;overflow:auto"><div style="height:300px">First</div></div><div id="second" data-logic-node="2" style="height:40px;overflow:auto"><div style="height:300px">Second</div></div><div id="untrusted-shadow"><template shadowrootmode="open" data-logic-shadow-root data-logic-node="10"><p>组件内容</p><div data-logic-node="20"><template shadowrootmode="open" data-logic-shadow-root data-logic-node="21"><span data-logic-node="23"><!--logic-text:22-->嵌套旧值</span></template></div><img src="https://example.test/shadow-probe" onerror="parent.document.body.dataset.executed='yes'"><script>parent.document.body.dataset.executed='yes'</script></template></div><script>document.body.setAttribute('data-executed', 'yes')</script></body></html>`,
      viewport: { scrollX: 0, scrollY: 90 },
      scroll: { positions: [{ nodeId: "1", left: 0, top: 30 }, { nodeId: "2", left: 0, top: 75 }], truncated: false },
      shadow: { roots: 1, captured: 1, stylesTruncated: true },
    },
  },
  {
    id: "element-scroll", seq: 2, time: 2, tabId: 1, frameId: 0,
    documentId: "doc", kind: "interaction.scroll",
    payload: { url: "https://example.test/", targetScope: "element", targetNodeId: "1", target: { selector: "#first" }, scrollLeft: 0, scrollTop: 90, x: 0, y: 90 },
  },
  {
    id: "document-scroll", seq: 3, time: 3, tabId: 1, frameId: 0,
    documentId: "doc", kind: "interaction.scroll",
    payload: { url: "https://example.test/", targetScope: "document", scrollLeft: 0, scrollTop: 150, x: 0, y: 150 },
  },
  {
    id: "first-click", seq: 4, time: 4, tabId: 1, frameId: 0,
    documentId: "doc", kind: "interaction.click",
    payload: { url: "https://example.test/", target: { tag: "button", text: "刷新前" } },
  },
  {
    id: "second-click", seq: 5, time: 5, tabId: 1, frameId: 0,
    documentId: "doc-2", kind: "interaction.click",
    payload: { url: "https://example.test/", target: { tag: "button", text: "刷新后" } },
  },
  {
    id: "shadow-added", seq: 6, time: 6, tabId: 1, frameId: 0, documentId: "doc", kind: "page.mutation",
    payload: { url: "https://example.test/", status: "captured", changes: [{ type: "children", id: "10", removed: [], next: null, added: [{ id: "11", type: "element", tag: "div", attrs: {}, children: [{ id: "12", type: "text", text: "短暂提示" }] }, { id: "13", type: "element", tag: "img", attrs: { src: "https://example.test/shadow-probe", onerror: "parent.document.body.dataset.executed='yes'", style: "background:url(https://example.test/shadow-probe)" }, children: [] }] }] },
  },
  {
    id: "shadow-changed", seq: 7, time: 7, tabId: 1, frameId: 0, documentId: "doc", kind: "page.mutation",
    payload: { url: "https://example.test/", status: "captured", changes: [{ type: "text", id: "12", value: "更新提示" }, { type: "attribute", id: "11", name: "class", value: "success" }, { type: "text", id: "22", value: "嵌套更新" }] },
  },
  {
    id: "shadow-removed", seq: 8, time: 8, tabId: 1, frameId: 0, documentId: "doc", kind: "page.mutation",
    payload: { url: "https://example.test/", status: "captured", changes: [{ type: "children", id: "10", removed: ["11"], next: null, added: [] }] },
  },
  {
    id: "future-snapshot", seq: 9, time: 8, tabId: 1, frameId: 0, documentId: "doc", kind: "page.snapshot",
    payload: { url: "https://example.test/", status: "captured", html: "<!doctype html><html><body>较晚的页面</body></html>" },
  },
  {
    id: "plain-start", seq: 10, time: 20, tabId: 2, frameId: 0, documentId: "plain-doc", kind: "page.snapshot",
    payload: { url: "https://example.test/plain", status: "captured", html: '<!doctype html><html><body><div data-logic-node="100"><input id="reused" data-logic-node="101" value=""></div></body></html>' },
  },
  {
    id: "plain-old-input", seq: 11, time: 21, tabId: 2, frameId: 0, documentId: "plain-doc", kind: "interaction.input",
    payload: { url: "https://example.test/plain", target: { tag: "input", selector: "#reused" }, value: "旧输入" },
  },
  {
    id: "plain-replaced", seq: 12, time: 22, tabId: 2, frameId: 0, documentId: "plain-doc", kind: "page.mutation",
    payload: { url: "https://example.test/plain", status: "captured", changes: [{ type: "children", id: "100", removed: ["101"], next: null, added: [{ id: "102", type: "element", tag: "input", attrs: { id: "reused", value: "新控件" }, children: [] }] }] },
  },
  {
    id: "plain-new-input", seq: 13, time: 23, tabId: 2, frameId: 0, documentId: "plain-doc", kind: "interaction.input",
    payload: { url: "https://example.test/plain", target: { tag: "input", selector: "#reused" }, value: "新输入" },
  },
  {
    id: "component-start", seq: 14, time: 30, tabId: 3, frameId: 0, documentId: "component-doc", kind: "page.snapshot",
    payload: { url: "https://example.test/component", status: "captured", html: '<!doctype html><html><body><div id="host"><template shadowrootmode="open" data-logic-shadow-root data-logic-node="200"><input id="reused" data-logic-node="201" value=""></template></div></body></html>' },
  },
  {
    id: "component-old-input", seq: 15, time: 31, tabId: 3, frameId: 0, documentId: "component-doc", kind: "interaction.input",
    payload: { url: "https://example.test/component", target: { tag: "input", shadowPath: ["#host", "#reused"] }, value: "组件旧输入" },
  },
  {
    id: "component-replaced", seq: 16, time: 32, tabId: 3, frameId: 0, documentId: "component-doc", kind: "page.mutation",
    payload: { url: "https://example.test/component", status: "captured", changes: [{ type: "children", id: "200", removed: ["201"], next: null, added: [{ id: "202", type: "element", tag: "input", attrs: { id: "reused", value: "组件新控件" }, children: [] }] }] },
  },
  {
    id: "component-new-input", seq: 17, time: 33, tabId: 3, frameId: 0, documentId: "component-doc", kind: "interaction.input",
    payload: { url: "https://example.test/component", target: { tag: "input", shadowPath: ["#host", "#reused"] }, value: "组件新输入" },
  },
  {
    id: "editor-start", seq: 18, time: 40, tabId: 4, frameId: 0, documentId: "editor-doc", kind: "page.snapshot",
    payload: { url: "https://example.test/editor", status: "captured", html: '<!doctype html><html><body><div id="editor" contenteditable="true" data-logic-node="300"><!--logic-text:301-->原文</div><div id="complex" contenteditable="true"><span>第一段</span><strong>第二段</strong></div></body></html>' },
  },
  {
    id: "editor-input", seq: 19, time: 41, tabId: 4, frameId: 0, documentId: "editor-doc", kind: "interaction.input",
    payload: { url: "https://example.test/editor", target: { tag: "div", selector: "#editor", editable: true }, value: "输入文字" },
  },
  {
    id: "editor-changed", seq: 20, time: 42, tabId: 4, frameId: 0, documentId: "editor-doc", kind: "page.mutation",
    payload: { url: "https://example.test/editor", status: "captured", changes: [{ type: "text", id: "301", value: "后续更新" }] },
  },
  {
    id: "complex-input", seq: 21, time: 43, tabId: 4, frameId: 0, documentId: "editor-doc", kind: "interaction.input",
    payload: { url: "https://example.test/editor", target: { tag: "div", selector: "#complex", editable: true }, value: "新文本" },
  },
  {
    id: "complex-unrelated", seq: 22, time: 43.1, tabId: 4, frameId: 0, documentId: "editor-doc", kind: "page.mutation",
    payload: { url: "https://example.test/editor", status: "captured", changes: [{ type: "text", id: "301", value: "无关更新" }] },
  },
  {
    id: "rich-start", seq: 23, time: 50, tabId: 5, frameId: 0, documentId: "rich-doc", kind: "page.snapshot",
    payload: { url: "https://example.test/rich", status: "captured", html: '<!doctype html><html><body><div id="rich" contenteditable="true" data-logic-node="400"><span data-logic-node="402"><!--logic-text:401-->甲</span><strong data-logic-node="404"><!--logic-text:403-->乙</strong></div><div id="rich-mismatch" contenteditable="true" data-logic-node="410"><span data-logic-node="412"><!--logic-text:411-->甲</span><strong data-logic-node="414"><!--logic-text:413-->乙</strong></div></body></html>' },
  },
  {
    id: "rich-input", seq: 24, time: 51, tabId: 5, frameId: 0, documentId: "rich-doc", kind: "interaction.input",
    payload: { url: "https://example.test/rich", target: { tag: "div", selector: "#rich", editable: true }, value: "甲新乙" },
  },
  {
    id: "rich-mutation", seq: 25, time: 52, tabId: 5, frameId: 0, documentId: "rich-doc", kind: "page.mutation",
    payload: { url: "https://example.test/rich", status: "captured", changes: [{ type: "text", id: "401", value: "甲新" }] },
  },
  {
    id: "structural-input", seq: 26, time: 52.1, tabId: 5, frameId: 0, documentId: "rich-doc", kind: "interaction.input",
    payload: { url: "https://example.test/rich", target: { tag: "div", selector: "#rich", editable: true }, value: "甲新乙", inputType: "formatItalic" },
  },
  {
    id: "structural-mutation", seq: 27, time: 52.2, tabId: 5, frameId: 0, documentId: "rich-doc", kind: "page.mutation",
    payload: { url: "https://example.test/rich", status: "captured", changes: [{ type: "children", id: "404", removed: ["403"], next: null, added: [{ id: "405", type: "element", tag: "em", attrs: {}, children: [{ id: "406", type: "text", text: "乙" }] }] }] },
  },
  {
    id: "mismatch-input", seq: 28, time: 53, tabId: 5, frameId: 0, documentId: "rich-doc", kind: "interaction.input",
    payload: { url: "https://example.test/rich", target: { tag: "div", selector: "#rich-mismatch", editable: true }, value: "不同文本" },
  },
  {
    id: "mismatch-mutation", seq: 29, time: 53.1, tabId: 5, frameId: 0, documentId: "rich-doc", kind: "page.mutation",
    payload: { url: "https://example.test/rich", status: "captured", changes: [{ type: "children", id: "414", removed: ["413"], next: null, added: [{ id: "415", type: "element", tag: "em", attrs: {}, children: [{ id: "416", type: "text", text: "乙" }] }] }] },
  },
  {
    id: "font-request", seq: 30, time: 58.1, tabId: 6, kind: "network.request",
    payload: { requestId: "font-request-1", type: "Font", url: "https://example.test/test-font.woff2" },
  },
  {
    id: "font-finished", seq: 31, time: 58.2, tabId: 6, kind: "network.finished",
    payload: { requestId: "font-request-1", assetId: "test-font", body: { status: "captured_asset" } },
  },
  {
    id: "css-initial", seq: 32, time: 59, tabId: 6, kind: "resource.initial",
    payload: { url: "https://example.test/site.css", mime: "text/css", assetId: "style-css" },
  },
  {
    id: "css-snapshot", seq: 33, time: 60, tabId: 6, frameId: 0, documentId: "css-doc", kind: "page.snapshot",
    payload: { url: "https://example.test/css", status: "captured", html: '<!doctype html><html><head><style>#css-probe{color:rgb(1,2,3)}</style><style data-logic-stylesheet="https://example.test/site.css"></style><style data-logic-stylesheet="https://example.test/missing.css"></style><style>#css-probe{background-color:rgb(4,5,6)}</style></head><body><div id="css-probe">样式测试</div></body></html>' },
  },
  {
    id: "css-request", seq: 34, time: 61, tabId: 6, kind: "network.request",
    payload: { requestId: "css-request-1", type: "Stylesheet", url: "https://example.test/site.css" },
  },
  {
    id: "css-finished", seq: 35, time: 62, tabId: 6, kind: "network.finished",
    payload: { requestId: "css-request-1", body: { status: "captured_redacted_best_effort", value: '@font-face{font-family:LogicTest;src:url("/test-font.woff2")} #css-probe{color:rgb(55,66,77);font-family:LogicTest} :root{--x:"</style><img id=escaped src=https://example.test/shadow-probe>"} .x{background:url(https://example.test/shadow-probe)}' } },
  },
  { id: "old-image-request", seq: 36, time: 69, tabId: 7, kind: "network.request", payload: { requestId: "old-image", url: "https://example.test/avatar.png", sourceFrame: "main" } },
  { id: "main-image", seq: 37, time: 70, tabId: 7, frameId: 0, documentId: "old-main", kind: "resource.initial", payload: { url: "https://example.test/avatar.png", assetId: "main-image", frameId: 0, documentId: "old-main" } },
  { id: "child-image", seq: 38, time: 71, tabId: 7, frameId: 4, documentId: "child-doc", kind: "resource.initial", payload: { url: "https://example.test/avatar.png", assetId: "child-image", frameId: 4, documentId: "child-doc" } },
  { id: "main-image-snapshot", seq: 39, time: 72, tabId: 7, frameId: 0, documentId: "old-main", kind: "page.snapshot", payload: { url: "https://example.test/main", status: "captured", html: '<!doctype html><html><body><img id="avatar" data-logic-src="https://example.test/avatar.png"></body></html>' } },
  { id: "child-image-snapshot", seq: 40, time: 73, tabId: 7, frameId: 4, documentId: "child-doc", kind: "page.snapshot", payload: { url: "https://example.test/frame", status: "captured", html: '<!doctype html><html><body><img id="avatar" data-logic-src="https://example.test/avatar.png"></body></html>' } },
  { id: "new-main-navigation", seq: 41, time: 74, tabId: 7, frameId: 0, kind: "navigation.committed", payload: { documentId: "new-main" } },
  { id: "new-main-snapshot", seq: 42, time: 75, tabId: 7, frameId: 0, documentId: "new-main", kind: "page.snapshot", payload: { url: "https://example.test/main", status: "captured", html: '<!doctype html><html><body><img id="avatar" data-logic-src="https://example.test/avatar.png"></body></html>' } },
  { id: "old-image-finished", seq: 43, time: 76, tabId: 7, kind: "network.finished", payload: { requestId: "old-image", assetId: "main-image" } },
  { id: "new-image-request", seq: 44, time: 77, tabId: 7, kind: "network.request", payload: { requestId: "new-image", url: "https://example.test/avatar.png", sourceFrame: "main" } },
  { id: "new-image-finished", seq: 45, time: 78, tabId: 7, kind: "network.finished", payload: { requestId: "new-image", assetId: "new-image" } },
];
const manifest = {
  format: "logic-recorder", version: 2,
  session: { id: "scroll-test", title: "滚动回看测试", startedAt: 1 },
  eventCount: events.length, eventChunks: ["timeline/events-00001.jsonl"],
};
const files = {
  "manifest.json": strToU8(JSON.stringify(manifest)),
  "timeline/events-00001.jsonl": strToU8(events.map((event) => JSON.stringify(event)).join("\n")),
  "resources/index.json": strToU8(JSON.stringify([{ id: "style-css", type: "resource", mime: "text/css" }, { id: "test-font", type: "resource", mime: "font/woff2" }, ...["main-image", "child-image", "new-image"].map((id) => ({ id, type: "resource", mime: "image/png" }))])),
  "resources/style-css.bin": strToU8("#css-probe{color:rgb(12,34,56)}"),
  "resources/test-font.bin": new Uint8Array(Buffer.from("d09GMgABAAAAAAEoAAoAAAAAAnwAAADfAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAABmAANAocOAE2AiQDBgsGAAQgBWkHJhvaAQAuDszzms60hZtiY5R08Sme/+8w75s/W3pKtQ4azVnweBeLBiGCK5wOEt5vKtflev0uxydJSim2LMi7b5ADHsj5D4yjk+OIEoz9WxJpHBDGcV6AEeY8fHsiIrF3ZhdV/eXowAHdjsEal23UmQ0A4Aw0FA6U4EB3hq4L1ltsswBooCMojAEdkJq99nJaUAeC8K6L+9X+x6k/+D3+g7kXUG8FpYEwhfzDpkgAuhYJmhLQAADQ3QiIKQKakamSPhEHdr03S9ebN1yo6d+oHxAjFUfuhPOokL5mFhJk7AoAAAA=", "base64")),
  ...Object.fromEntries(["main-image", "child-image", "new-image"].map((id, index) => [`resources/${id}.bin`, new Uint8Array(Buffer.concat([Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64"), Buffer.from([index])]))])),
};
files["integrity.json"] = strToU8(JSON.stringify(
  Object.entries(files).map(([entryPath, bytes]) => ({
    path: entryPath, size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  })),
));
const profile = await fs.mkdtemp(path.resolve("test-scroll-profile-"));
const extension = path.resolve("dist");
let context;
try {
  context = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.CHROME_BIN || chromium.executablePath(),
    headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker", { timeout: 15000 });
  const panel = await context.newPage();
  let probeCount = 0;
  await context.route("**/shadow-probe", (route) => { probeCount++; return route.abort(); });
  await panel.setViewportSize({ width: 360, height: 780 });
  await panel.goto(`chrome-extension://${new URL(worker.url()).host}/sidepanel.html`);
  await panel.getByRole("button", { name: "导入记录包" }).click();
  await panel.locator("input[type=file]").first().setInputFiles({
    name: "scroll.zip", mimeType: "application/zip", buffer: Buffer.from(zipSync(files)),
  });
  await panel.getByRole("heading", { name: "滚动回看测试" }).waitFor();
  for (const [eventId, first, second, y] of [
    ["initial-scroll", 30, 75, 90],
    ["element-scroll", 90, 75, 90],
    ["document-scroll", 90, 75, 150],
  ]) {
    await panel.getByPlaceholder("搜索记录").fill(eventId);
    await panel.locator(".timeline-item").first().click();
    try {
      await panel.waitForFunction(({ first, second, y }) => {
        const frame = document.querySelector('iframe[title="页面快照"]');
        const doc = frame?.contentDocument;
        return doc?.querySelector("#first")?.scrollTop === first &&
          doc?.querySelector("#second")?.scrollTop === second &&
          frame.contentWindow.scrollY === y;
      }, { first, second, y }, { timeout: 5000 });
    } catch {
      const actual = await panel.evaluate(() => {
        const frame = document.querySelector('iframe[title="页面快照"]');
        return { first: frame?.contentDocument?.querySelector("#first")?.scrollTop, second: frame?.contentDocument?.querySelector("#second")?.scrollTop, y: frame?.contentWindow?.scrollY, notice: document.querySelector(".notice.error")?.textContent };
      });
      throw new Error(`${eventId}: 滚动还原错误 ${JSON.stringify(actual)}`);
    }
    const executed = await panel.frameLocator('iframe[title="页面快照"]').locator("body").getAttribute("data-executed");
    if (executed !== null) throw new Error("页面快照中的脚本被执行");
    await panel.frameLocator('iframe[title="页面快照"]').getByText("组件内容").waitFor({ state: "attached" });
    if (probeCount) throw new Error("组件快照尝试访问外部资源");
  }
  for (const [eventId, text] of [["shadow-added", "短暂提示"], ["shadow-changed", "更新提示"]]) {
    await panel.getByPlaceholder("搜索记录").fill(eventId);
    await panel.locator(".timeline-item").first().click();
    await panel.frameLocator('iframe[title="页面快照"]').getByText(text, { exact: true }).waitFor({ state: "attached" });
  }
  await panel.frameLocator('iframe[title="页面快照"]').getByText("嵌套更新", { exact: true }).waitFor({ state: "attached" });
  await panel.getByPlaceholder("搜索记录").fill("shadow-removed");
  await panel.locator(".timeline-item").first().click();
  await panel.frameLocator('iframe[title="页面快照"]').getByText("嵌套更新", { exact: true }).waitFor({ state: "attached" });
  if (await panel.frameLocator('iframe[title="页面快照"]').getByText("更新提示", { exact: true }).count())
    throw new Error("组件中已移除的提示仍然显示");
  await panel.waitForTimeout(200);
  if (probeCount || await panel.frameLocator('iframe[title="页面快照"]').locator("body").getAttribute("data-executed"))
    throw new Error("组件变化突破了页面隔离");
  for (const [eventId, expected] of [
    ["plain-replaced", "新控件"], ["plain-new-input", "新输入"],
    ["component-replaced", "组件新控件"], ["component-new-input", "组件新输入"],
  ]) {
    await panel.getByPlaceholder("搜索记录").fill(eventId);
    await panel.locator(".timeline-item").first().click();
    await panel.waitForFunction((value) => {
      const doc = document.querySelector('iframe[title="页面快照"]')?.contentDocument;
      const input = doc?.querySelector("#reused") || doc?.querySelector("#host")?.shadowRoot?.querySelector("#reused");
      return input?.value === value;
    }, expected, { timeout: 5000 });
  }
  for (const [eventId, expected] of [["editor-input", "输入文字"], ["editor-changed", "后续更新"]]) {
    await panel.getByPlaceholder("搜索记录").fill(eventId);
    await panel.locator(".timeline-item").first().click();
    await panel.waitForFunction((value) => document.querySelector('iframe[title="页面快照"]')?.contentDocument?.querySelector("#editor")?.textContent === value, expected, { timeout: 5000 });
  }
  if (await panel.locator(".detail-content .notice.error").count())
    throw new Error("富文本后续变化未能定位");
  await panel.getByPlaceholder("搜索记录").fill("complex-input");
  await panel.locator(".timeline-item").first().click();
  await panel.getByText("复杂富文本仅按文本还原").waitFor();
  await panel.getByPlaceholder("搜索记录").fill("complex-unrelated");
  await panel.locator(".timeline-item").first().click();
  await panel.getByText("复杂富文本仅按文本还原").waitFor();
  await panel.getByPlaceholder("搜索记录").fill("rich-mutation");
  await panel.locator(".timeline-item").first().click();
  const rich = panel.frameLocator('iframe[title="页面快照"]').locator("#rich");
  await rich.locator("strong").waitFor({ state: "attached" });
  if ((await rich.locator("span").textContent()) !== "甲新" || (await rich.locator("strong").textContent()) !== "乙")
    throw new Error("富文本变化未保留原有格式");
  if (await panel.locator(".detail-content .notice.error").count())
    throw new Error("已记录的富文本变化不应退化为纯文本");
  await panel.getByPlaceholder("搜索记录").fill("structural-mutation");
  await panel.locator(".timeline-item").first().click();
  await panel.frameLocator('iframe[title="页面快照"]').locator("#rich strong em").waitFor({ state: "attached" });
  if (await panel.locator(".detail-content .notice.error").count())
    throw new Error("已记录的结构性编辑未正确还原");
  await panel.getByPlaceholder("搜索记录").fill("mismatch-mutation");
  await panel.locator(".timeline-item").first().click();
  await panel.getByText(/复杂富文本仅按文本还原/).waitFor();
  for (const [eventId, expected] of [["css-snapshot", "rgb(12, 34, 56)"], ["css-finished", "rgb(55, 66, 77)"]]) {
    await panel.getByPlaceholder("搜索记录").fill(eventId);
    await panel.locator(".timeline-item").first().click();
    await panel.waitForFunction((color) => {
      const frame = document.querySelector('iframe[title="页面快照"]');
      const element = frame?.contentDocument?.querySelector("#css-probe");
      return element && frame.contentWindow.getComputedStyle(element).color === color;
    }, expected, { timeout: 5000 });
    await panel.getByText(/外部样式未取得：1 个/).waitFor();
    if ((await panel.frameLocator('iframe[title="页面快照"]').locator("#css-probe").evaluate((element) => getComputedStyle(element).backgroundColor)) !== "rgb(4, 5, 6)")
      throw new Error("页面原有样式顺序未保留");
    if (await panel.frameLocator('iframe[title="页面快照"]').locator("#escaped").count())
      throw new Error("样式内容突破了快照结构");
    if (eventId === "css-finished") await panel.waitForFunction(() => {
      const fonts = document.querySelector('iframe[title="页面快照"]')?.contentDocument?.fonts;
      return fonts && [...fonts].some((font) => font.family === "LogicTest" && font.status === "loaded");
    }, null, { timeout: 5000 });
  }
  await panel.waitForTimeout(200);
  if (probeCount) throw new Error("样式尝试访问外部资源");
  for (const [eventId, assetId] of [["main-image-snapshot", "main-image"], ["child-image-snapshot", "child-image"], ["new-image-finished", "new-image"]]) {
    await panel.getByPlaceholder("搜索记录").fill(eventId);
    await panel.locator(".timeline-item").first().click();
    const avatar = panel.frameLocator('iframe[title="页面快照"]').locator("#avatar");
    const expected = `data:image/png;base64,${Buffer.from(files[`resources/${assetId}.bin`]).toString("base64")}`;
    await avatar.waitFor({ state: "attached" });
    if ((await avatar.getAttribute("src")) !== expected) throw new Error(`${eventId} 关联了错误的页面图片`);
  }
  await panel.getByPlaceholder("搜索记录").fill("old-image-finished");
  await panel.locator(".timeline-item").first().click();
  await panel.getByText("图片资源未取得：1 个").waitFor();
  if (await panel.frameLocator('iframe[title="页面快照"]').locator("#avatar").getAttribute("src")) throw new Error("刷新后错误显示了旧页面图片");
  await panel.getByRole("button", { name: /^流程 \d+$/ }).click();
  const flows = panel.locator(".flow");
  if ((await flows.count()) !== 6 || !(await flows.nth(1).textContent()).includes("刷新后"))
    throw new Error("刷新前后的流程没有在侧边栏分别显示");
  if (!(await flows.nth(1).locator(".flow-context").textContent()).includes("标签页 1"))
    throw new Error("流程未显示所属页面上下文");
  await flows.nth(1).getByRole("button", { name: /刷新后/ }).click();
  await panel.getByText("事件详情 · #5").waitFor();
  await panel.getByRole("button", { name: "报告", exact: true }).click();
  await panel.getByText(/组件样式超过采集上限/).waitFor();
  console.log("侧边栏滚动还原、脚本隔离和页面实例流程验证通过");
} finally {
  if (context) await context.close();
  await fs.rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}
