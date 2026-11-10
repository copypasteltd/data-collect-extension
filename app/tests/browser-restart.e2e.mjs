import { chromium } from "playwright";
import http from "node:http";
import path from "node:path";
import fs from "node:fs/promises";
import { unzipSync, strFromU8 } from "fflate";
import { buildCatalog, buildResourceMap } from "../src/analysis.js";

const server = http.createServer((req, res) => {
  if (req.url === "/api/customer" || req.url === "/api/frame") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end('{"customer":"示例"}');
    return;
  }
  if (req.url === "/avatar.png") {
    res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "no-store" });
    res.end(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64"));
    return;
  }
  if (req.url === "/frame") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end('<!doctype html><title>嵌入页面</title><button id="frame-request" onclick="fetch(\'/api/frame\')">查询嵌入页面</button>');
    return;
  }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end('<!doctype html><title>中断恢复</title><input id="customer" aria-label="客户" value="初始客户"><input id="note" aria-label="备注" value="password=private-initial-value"><input type="checkbox" id="choice-check" checked><input type="checkbox" id="scripted-check"><input type="checkbox" name="password-confirmation" id="private-check"><select id="choice-select"><option value="a">甲</option><option value="b" selected>乙</option></select><select id="uncertain-select"><option value="token=private-option-value">甲</option><option value="b" selected>乙</option></select><button id="request" onclick="fetch(\'/api/customer\')">查询</button><img id="avatar" src="/avatar.png"><iframe id="frame" src="/frame"></iframe>');
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const profile = await fs.mkdtemp(path.resolve("test-browser-restart-profile-"));
const extension = await fs.mkdtemp(path.resolve("test-browser-restart-extension-"));
let context;
try {
  await fs.cp(path.resolve("dist"), extension, { recursive: true });
  const manifestPath = path.join(extension, "manifest.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  manifest.host_permissions = ["http://*/*", "https://*/*"];
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  const options = {
    executablePath: process.env.CHROME_BIN || chromium.executablePath(),
    headless: true,
    acceptDownloads: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    timeout: 30000,
  };
  context = await chromium.launchPersistentContext(profile, options);
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker", { timeout: 15000 });
  const extensionId = new URL(worker.url()).host;
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.evaluate(() => {
    const host = document.createElement("div");
    host.id = "outer-host";
    const outer = host.attachShadow({ mode: "open" });
    const innerHost = document.createElement("div");
    innerHost.id = "inner-host";
    outer.append(innerHost);
    const inner = innerHost.attachShadow({ mode: "closed" });
    const field = document.createElement("input");
    field.id = "shadow-field";
    field.value = "组件初始";
    const privateField = document.createElement("input");
    privateField.type = "password";
    privateField.id = "private-field";
    inner.append(field, privateField);
    document.body.append(host);
    const longInput = document.createElement("input");
    longInput.id = "long-input";
    longInput.value = "a".repeat(4100);
    const scripted = document.createElement("input");
    scripted.id = "scripted-input";
    const longChoice = document.createElement("select");
    longChoice.id = "long-choice";
    const longOption = document.createElement("option");
    longOption.value = "x".repeat(600);
    longOption.textContent = "长选项";
    const otherOption = document.createElement("option");
    otherOption.value = "b";
    otherOption.textContent = "其他";
    otherOption.selected = true;
    longChoice.append(longOption, otherOption);
    document.body.append(longInput, scripted, longChoice);
    globalThis.testShadow = { field, privateField };
  });
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  const [tab] = await worker.evaluate(() => chrome.tabs.query({ url: "http://127.0.0.1/*" }));
  const started = await panel.evaluate((tab) => chrome.runtime.sendMessage({
    type: "START", tab, options: { screenshots: false, scope: "site" },
  }), tab);
  if (!started.ok) throw new Error("中断录制未启动");
  await Promise.all([page.waitForResponse((response) => response.url().endsWith("/api/customer")), page.locator("#request").click()]);
  await Promise.all([page.waitForResponse((response) => response.url().endsWith("/api/frame")), page.frameLocator("#frame").locator("#frame-request").click()]);
  await page.getByLabel("客户").fill("浏览器关闭前的客户");
  await page.getByLabel("备注").fill("token=private-input-value");
  await page.locator("#choice-check").click();
  await page.locator("#private-check").click();
  await page.locator("#choice-select").focus();
  await page.keyboard.press("ArrowUp");
  await page.locator("#uncertain-select").focus();
  await page.keyboard.press("ArrowUp");
  await page.locator("#long-choice").focus();
  await page.keyboard.press("ArrowUp");
  await page.evaluate(() => document.querySelector("#scripted-check").click());
  await page.locator("#long-input").fill("缩短");
  await page.evaluate(() => {
    const input = document.querySelector("#scripted-input");
    input.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, inputType: "insertText" }));
    input.value = "脚本输入";
    input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
  });
  await page.evaluate(() => globalThis.testShadow.field.focus());
  await page.keyboard.insertText("组件输入");
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    const { field, privateField } = globalThis.testShadow;
    field.focus();
    for (const type of ["pointerdown", "pointerup", "pointermove", "pointerover", "pointercancel"])
      field.dispatchEvent(new PointerEvent(type, { bubbles: true, composed: true, clientX: 42 }));
    field.dispatchEvent(new KeyboardEvent("keyup", { key: "Escape", ctrlKey: true, bubbles: true, composed: true }));
    for (const type of ["paste", "copy", "cut", "dragstart", "drop", "compositionstart", "compositionend"])
      field.dispatchEvent(new Event(type, { bubbles: true, composed: true }));
    const focusOut = new FocusEvent("focusout", { bubbles: true, composed: false });
    field.dispatchEvent(focusOut);
    const transfer = new DataTransfer();
    transfer.items.add(new File(["test"], "private-filename.txt", { type: "text/plain" }));
    privateField.dispatchEvent(new DragEvent("drop", { bubbles: true, composed: true, dataTransfer: transfer }));
    privateField.dispatchEvent(new KeyboardEvent("keyup", { key: "x", bubbles: true, composed: true }));
  });
  await page.evaluate(() => globalThis.testShadow.privateField.focus());
  await page.keyboard.insertText("private-password-value");
  await page.waitForTimeout(1200);
  await page.reload({ waitUntil: "load" });
  await page.waitForTimeout(700);
  await Promise.all([page.waitForResponse((response) => response.url().endsWith("/api/customer")), page.locator("#request").click()]);
  await page.waitForTimeout(500);
  await context.close();
  context = null;
  context = await chromium.launchPersistentContext(profile, options);
  if (!context.serviceWorkers()[0]) await context.waitForEvent("serviceworker", { timeout: 15000 });
  const recovered = await context.newPage();
  await recovered.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await recovered.getByText("异常中断（可导出部分记录）", { exact: false }).first().waitFor({ timeout: 15000 });
  const download = recovered.waitForEvent("download", { timeout: 15000 });
  await recovered.getByTitle("下载记录包").first().click();
  const archive = await download;
  const zipPath = path.join(profile, "recovered.zip");
  await archive.saveAs(zipPath);
  const files = unzipSync(await fs.readFile(zipPath));
  const metadata = JSON.parse(strFromU8(files["manifest.json"]));
  if (!metadata.partial) throw new Error("异常中断记录包未标记为部分记录");
  const eventsText = metadata.eventChunks.map((name) => strFromU8(files[name])).join("\n");
  if (!eventsText.includes("浏览器关闭前的客户")) throw new Error("未恢复浏览器关闭前的操作");
  const events = eventsText.split("\n").filter(Boolean).map(JSON.parse);
  const networkRequest = events.find((event) => event.kind === "network.request" && event.payload?.url?.endsWith("/api/customer"));
  if (networkRequest?.payload.sourceFrame !== "main" || networkRequest.payload.documentUrl !== `http://127.0.0.1:${server.address().port}/`) throw new Error("接口请求未保存主页面来源");
  const embeddedRequest = events.find((event) => event.kind === "network.request" && event.payload?.url?.endsWith("/api/frame"));
  if (!embeddedRequest || embeddedRequest.payload.sourceFrame === "main" || embeddedRequest.payload.documentUrl !== `http://127.0.0.1:${server.address().port}/frame`) throw new Error("嵌入页面请求来源不正确");
  const flows = buildCatalog(events).flows;
  for (const [selector, requestId] of [["#request", networkRequest.id], ["#frame-request", embeddedRequest.id]]) {
    const action = events.find((event) => event.kind === "interaction.click" && event.payload?.target?.selector === selector);
    const step = flows.flatMap((flow) => flow.steps).find((item) => item.eventId === action?.id);
    if (!step?.candidateRequests.some((item) => item.eventId === requestId)) throw new Error(`${selector} 的候选请求未正确关联`);
  }
  const expectedPath = ["#outer-host", "#inner-host", "#shadow-field"];
  for (const type of ["pointerdown", "pointerup", "pointermove", "pointerover", "pointercancel", "focusin", "keyup", "paste", "copy", "cut", "dragstart", "drop", "compositionstart", "compositionend"]) {
    const matches = events.filter((event) => event.kind === `interaction.${type}` && JSON.stringify(event.payload?.target?.shadowPath) === JSON.stringify(expectedPath) && (!type.startsWith("pointer") || event.payload.x === 42));
    if (matches.length !== 1) throw new Error(`组件内 ${type} 应记录一次，实际 ${matches.length} 次`);
  }
  const nonComposed = events.filter((event) => event.kind === "interaction.focusout" && event.payload.trusted === false && JSON.stringify(event.payload.target?.shadowPath) === JSON.stringify(expectedPath));
  if (nonComposed.length !== 1) throw new Error(`不穿出组件边界的焦点事件应记录一次，实际 ${nonComposed.length} 次`);
  const keyup = events.find((event) => event.kind === "interaction.keyup" && JSON.stringify(event.payload.target?.shadowPath) === JSON.stringify(expectedPath));
  if (keyup?.payload.key !== "Escape" || !keyup.payload.ctrl || !keyup.payload.viewport?.width) throw new Error("组件内键盘释放的上下文未记录");
  const privateKey = events.find((event) => event.kind === "interaction.keyup" && event.payload?.target?.sensitive);
  if (privateKey?.payload.key !== "[输入]") throw new Error("敏感组件的按键未隐藏");
  const privateDrop = events.find((event) => event.kind === "interaction.drop" && event.payload?.target?.sensitive && event.payload.files?.length);
  if (privateDrop?.payload.files[0].name !== "[已隐藏]") throw new Error("敏感组件中的拖放文件名未隐藏");
  if (eventsText.includes("private-filename.txt")) throw new Error("敏感组件的拖放文件名泄漏");
  const customerInput = events.find((event) => event.kind === "interaction.input" && event.payload?.target?.selector === "#customer" && event.payload.value === "浏览器关闭前的客户");
  if (customerInput?.payload.beforeValue !== "初始客户" || customerInput.payload.beforeValueStatus !== "captured") throw new Error("未保存普通输入的操作前值");
  const shadowInput = events.find((event) => event.kind === "interaction.input" && JSON.stringify(event.payload?.target?.shadowPath) === JSON.stringify(expectedPath));
  if (shadowInput?.payload.beforeValue !== "组件初始") throw new Error("未保存组件输入的操作前值");
  const privateInput = events.find((event) => event.kind === "interaction.input" && event.payload?.target?.sensitive && event.payload.target.type === "password");
  if (privateInput?.payload.value !== "[已隐藏]" || privateInput.payload.beforeValue !== undefined) throw new Error("敏感输入的操作前值未正确隐藏");
  const noteInput = events.find((event) => event.kind === "interaction.input" && event.payload?.target?.selector === "#note");
  if (noteInput?.payload.beforeValue !== "password=[已隐藏]" || noteInput.payload.beforeValueStatus !== "redacted" || noteInput.payload.value !== "token=[已隐藏]") throw new Error("普通输入内的认证字段未隐藏");
  if (["private-password-value", "private-input-value", "private-initial-value", "private-option-value"].some((value) => eventsText.includes(value))) throw new Error("输入值或操作前值中存在敏感内容");
  const longInput = events.find((event) => event.kind === "interaction.input" && event.payload?.target?.selector === "#long-input");
  if (longInput?.payload.beforeValue?.length !== 4000 || longInput.payload.beforeValueStatus !== "truncated") throw new Error("过长的操作前值未标记截断");
  const scriptedInput = events.find((event) => event.kind === "interaction.input" && event.payload?.target?.selector === "#scripted-input");
  if (!scriptedInput || scriptedInput.payload.beforeValue !== undefined) throw new Error("脚本触发的输入被错误标记为已确认原值");
  const check = events.find((event) => event.kind === "interaction.change" && event.payload?.target?.selector === "#choice-check");
  if (check?.payload.beforeFormState?.checked !== true || check.payload.formState?.checked !== false) throw new Error("复选框的操作前状态未记录");
  const select = events.find((event) => event.kind === "interaction.change" && event.payload?.target?.selector === "#choice-select");
  if (JSON.stringify(select?.payload.beforeFormState?.selectedIndices) !== "[1]" || JSON.stringify(select.payload.formState?.selectedIndices) !== "[0]" || select.payload.beforeFormState.options[1].value !== "b") throw new Error("下拉框的操作前选择或选项未记录");
  const uncertain = events.find((event) => event.kind === "interaction.change" && event.payload?.target?.selector === "#uncertain-select");
  if (!uncertain?.payload.beforeFormState?.options[0].uncertain) throw new Error("脱敏选项未标记为无法确认身份");
  const longChoice = events.find((event) => event.kind === "interaction.change" && event.payload?.target?.selector === "#long-choice");
  if (!longChoice?.payload.beforeFormState?.options[0].uncertain || longChoice.payload.beforeFormState.options[0].value.length !== 512) throw new Error("过长选项未截断并标记为无法确认身份");
  const nav = events.filter((event) => event.kind === "navigation.committed" && event.frameId === 0).at(-1);
  const reloadedSnapshot = events.filter((event) => event.kind === "page.snapshot" && event.documentId === nav?.payload.documentId).at(-1);
  const reloadedClick = events.filter((event) => event.kind === "interaction.click" && event.documentId === nav?.payload.documentId && event.payload?.target?.selector === "#request").at(-1);
  const avatarRequest = events.filter((event) => event.kind === "network.request" && event.payload?.url?.endsWith("/avatar.png")).at(-1);
  const avatarFinish = events.find((event) => event.kind === "network.finished" && event.payload?.requestId === avatarRequest?.payload.requestId);
  const resourceContext = { frameId: 0, documentId: reloadedSnapshot?.documentId, url: reloadedSnapshot?.payload.url, snapshotEvent: reloadedSnapshot };
  if (!reloadedClick || !avatarFinish?.payload.assetId || buildResourceMap(events, nav?.tabId, reloadedClick, resourceContext).get(avatarRequest.payload.url) !== avatarFinish.payload.assetId)
    throw new Error("页面刷新后未关联实际加载的新图片");
  const scriptedCheck = events.find((event) => event.kind === "interaction.change" && event.payload?.target?.selector === "#scripted-check");
  if (!scriptedCheck || scriptedCheck.payload.beforeFormState !== undefined) throw new Error("脚本触发的选择被错误标记为已确认原状态");
  const privateCheck = events.find((event) => event.kind === "interaction.change" && event.payload?.target?.sensitive && event.payload?.target?.type === "checkbox");
  if (!privateCheck || privateCheck.payload.beforeFormState !== undefined || privateCheck.payload.formState !== undefined) throw new Error("敏感选择状态未隐藏");
  let replayRequests = 0;
  await context.route("**/api/**", (route) => { replayRequests++; return route.abort(); });
  await recovered.getByRole("button", { name: "导入记录包" }).click();
  await recovered.locator('input[type="file"]').first().setInputFiles(zipPath);
  await recovered.getByRole("button", { name: "复现", exact: true }).click();
  await recovered.getByRole("button", { name: "页面", exact: true }).click();
  const replayPage = recovered.frameLocator('iframe[title="逐步复现页面"]');
  await replayPage.locator("#request").click();
  await replayPage.locator("#frame-request").waitFor({ state: "visible" });
  await replayPage.locator("#frame-request").click();
  await recovered.waitForTimeout(200);
  if (replayRequests) throw new Error("实际记录的页面复现访问了原站接口");
  console.log("浏览器重启后的中断记录恢复和下载通过");
} finally {
  if (context) await context.close();
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  await fs.rm(extension, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}
