import { chromium } from "playwright";
import http from "node:http";
import path from "node:path";
import fs from "node:fs/promises";

const server = http.createServer((_request, response) => {
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.end("<!doctype html><title>授权测试</title><h1>授权测试</h1>");
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const profile = await fs.mkdtemp(path.resolve("test-permission-profile-"));
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
  const id = new URL(worker.url()).host;
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${id}/sidepanel.html`);
  const before = await panel.evaluate(() => chrome.permissions.getAll());
  if (before.origins?.length) throw new Error("测试环境不应预先授予站点权限");
  await panel.getByText("我有权记录当前站点").click();
  await page.bringToFront();
  await panel.waitForTimeout(2200);
  await panel
    .getByRole("button", { name: "开始录制" })
    .click({ timeout: 5000 });
  await panel.waitForTimeout(2500);
  const pendingState = await panel.evaluate(() =>
    chrome.runtime.sendMessage({ type: "GET_STATE" }),
  );
  if (
    pendingState.value.active ||
    (await panel.evaluate(() => chrome.permissions.getAll())).origins?.length
  )
    throw new Error("授权未完成时不应开始录制或获得站点权限");
  await panel.getByRole("button", { name: "正在准备…" }).waitFor();
  console.log("真实权限请求等待用户处理，未提前启动录制");
  await panel.close();

  const checkedPanel = await context.newPage();
  await checkedPanel.goto(`chrome-extension://${id}/sidepanel.html`);
  await checkedPanel.evaluate(() => {
    globalThis.__permissionTest = { mode: "deny", calls: [] };
    chrome.permissions.request = (request) => {
      globalThis.__permissionTest.calls.push(request.origins);
      if (globalThis.__permissionTest.mode === "hold")
        return new Promise((resolve) => {
          globalThis.__permissionTest.resolve = resolve;
        });
      return Promise.resolve(globalThis.__permissionTest.mode === "grant");
    };
  });
  await page.bringToFront();
  await checkedPanel.waitForTimeout(2200);
  await checkedPanel.getByText("我有权记录当前站点").click();
  await checkedPanel.getByRole("button", { name: "开始录制" }).click();
  await checkedPanel.getByText("需要授予当前站点访问权限才能录制").waitFor();
  let calls = await checkedPanel.evaluate(
    () => globalThis.__permissionTest.calls,
  );
  if (JSON.stringify(calls.at(-1)) !== JSON.stringify(["http://127.0.0.1/*"]))
    throw new Error("当前站点权限请求范围不正确");

  await checkedPanel.getByLabel("录制范围").selectOption("browser");
  await checkedPanel.getByText("我有权记录所有打开的网页").click();
  await checkedPanel.getByRole("button", { name: "开始录制" }).click();
  await checkedPanel.getByText("需要授予所有网页访问权限才能录制").waitFor();
  calls = await checkedPanel.evaluate(() => globalThis.__permissionTest.calls);
  if (
    JSON.stringify(calls.at(-1)) !==
    JSON.stringify(["http://*/*", "https://*/*"])
  )
    throw new Error("所有网页权限请求范围不正确");

  await checkedPanel.getByLabel("录制范围").selectOption("site");
  await checkedPanel.getByText("我有权记录当前站点").click();
  await checkedPanel.evaluate(() => {
    globalThis.__permissionTest.mode = "grant";
  });
  await checkedPanel.getByRole("button", { name: "开始录制" }).click();
  await checkedPanel.getByText("尚未授予当前站点权限").waitFor();

  const otherPage = await context.newPage();
  await otherPage.goto(`http://127.0.0.1:${server.address().port}/other`);
  await page.bringToFront();
  await checkedPanel.waitForTimeout(2200);
  const beforeCalls = await checkedPanel.evaluate(() => {
    globalThis.__permissionTest.mode = "hold";
    return globalThis.__permissionTest.calls.length;
  });
  await checkedPanel.evaluate(() => {
    const button = [...document.querySelectorAll("button")].find((item) =>
      item.textContent.includes("开始录制"),
    );
    button.click();
    button.click();
  });
  await checkedPanel.waitForFunction(
    () => typeof globalThis.__permissionTest.resolve === "function",
  );
  calls = await checkedPanel.evaluate(() => globalThis.__permissionTest.calls);
  if (calls.length !== beforeCalls + 1)
    throw new Error("重复点击触发了多个权限请求");
  await otherPage.bringToFront();
  await checkedPanel.evaluate(() => globalThis.__permissionTest.resolve(true));
  await checkedPanel.getByText("当前页面已变化，请确认后重新开始").waitFor();
  const finalState = await checkedPanel.evaluate(() =>
    chrome.runtime.sendMessage({ type: "GET_STATE" }),
  );
  if (
    finalState.value.active ||
    finalState.value.sessions.length ||
    (await checkedPanel.evaluate(() => chrome.permissions.getAll())).origins
      ?.length
  )
    throw new Error("权限未授予或页面变化时不应创建录制任务");
  console.log("模拟拒绝、权限核对、重复点击和切换页面验证通过");
} finally {
  if (context) await context.close();
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(profile, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 250,
  });
}
