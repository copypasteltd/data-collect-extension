import { chromium } from "playwright";
import http from "node:http";
import path from "node:path";
import fs from "node:fs/promises";
import assert from "node:assert/strict";
import { unzipSync, strFromU8 } from "fflate";
import { execFileSync } from "node:child_process";

const server = http.createServer((request, response) => {
  if (request.url.startsWith("/api")) {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end('{"result":"fixture-response"}');
  } else {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Set-Cookie": "fixture_session=fixture-cookie; Path=/" });
    response.end(`<!doctype html><title>测试页面 ${request.url}</title><input id="value"><button id="send" onclick="fetch('/api?token=fixture-token')">发送</button><script>window.fixtureLoaded=true</script>`);
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const profile = await fs.mkdtemp(path.resolve("test-sidepanel-profile-"));
const extension = await fs.mkdtemp(path.resolve("test-sidepanel-extension-"));
let context;
try {
  await fs.cp(path.resolve("dist"), extension, { recursive: true });
  const manifestPath = path.join(extension, "manifest.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  manifest.host_permissions = ["http://*/*", "https://*/*"];
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  context = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.CHROME_BIN || chromium.executablePath(), headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker", { timeout: 15000 });
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/first`);
  const panel = await context.newPage();
  await panel.setViewportSize({ width: 320, height: 720 });
  await panel.goto(`chrome-extension://${new URL(worker.url()).host}/sidepanel.html`);
  await page.bringToFront();
  await panel.waitForTimeout(2200);
  assert.deepEqual(await panel.locator("button").allTextContents(), ["开始录制", "导出记录包"]);
  assert.equal(await panel.getByRole("button", { name: "导出记录包" }).isDisabled(), true);
  await panel.getByRole("button", { name: "开始录制" }).click();
  await panel.getByRole("button", { name: "停止录制" }).waitFor();
  await page.locator("#value").fill("fixture-first");
  await Promise.all([page.waitForResponse((response) => response.url().includes("/api?")), page.locator("#send").click()]);
  await panel.getByRole("button", { name: "停止录制" }).click();
  await panel.getByRole("button", { name: "开始录制" }).waitFor();
  await panel.getByRole("radio").first().waitFor();
  const firstSession = (await panel.evaluate(() => chrome.runtime.sendMessage({ type: "GET_STATE" }))).value.sessions[0];
  assert.equal(firstSession.options.scope, "browser");
  assert.equal(firstSession.options.screenshots, true);
  assert.equal(firstSession.options.canvasSnapshots, true);
  await page.goto(`http://127.0.0.1:${server.address().port}/second`);
  await page.bringToFront();
  await panel.waitForTimeout(2200);
  await panel.getByRole("button", { name: "开始录制" }).click();
  await panel.getByRole("button", { name: "停止录制" }).waitFor();
  await page.locator("#value").fill("fixture-second");
  await panel.getByRole("button", { name: "停止录制" }).click();
  await panel.getByRole("button", { name: "开始录制" }).waitFor();
  await panel.waitForFunction(() => document.querySelectorAll('input[type="radio"]').length === 2);
  assert.deepEqual(await panel.locator("button").allTextContents(), ["开始录制", "导出记录包"]);
  assert.equal(await panel.getByText("测试页面", { exact: false }).count(), 0);
  assert.equal(await panel.getByRole("link").count(), 0);
  const sessions = (await panel.evaluate(() => chrome.runtime.sendMessage({ type: "GET_STATE" }))).value.sessions;
  assert.equal(sessions.length, 2);
  for (const [index, expectedValue] of [[0, "fixture-second"], [1, "fixture-first"]]) {
    await panel.getByRole("radio").nth(index).check();
    const downloadPromise = panel.waitForEvent("download", { timeout: 30000 });
    await panel.getByRole("button", { name: "导出记录包" }).click();
    const download = await downloadPromise;
    const archivePath = path.join(profile, `batch-${index}.zip`);
    await download.saveAs(archivePath);
    const files = unzipSync(await fs.readFile(archivePath));
    const archive = JSON.parse(strFromU8(files["manifest.json"]));
    assert.equal(archive.session.id, sessions[index].id);
    const events = archive.eventChunks.flatMap((chunk) => strFromU8(files[chunk]).split("\n").filter(Boolean).map(JSON.parse));
    if (process.env.LOGIC_SKILL_INDEX_CHECK === "1") {
      const skill = process.env.LOGIC_SKILL_INDEX_SCRIPT || path.resolve("skills/extension-logic-clone/scripts/index_archive.py");
      const indexPath = path.join(profile, `batch-${index}.sqlite3`);
      const output = execFileSync(process.env.PYTHON_BIN || "python", [skill, archivePath, "--output", indexPath],
        { encoding: "utf8", env: { ...process.env, PYTHONUTF8: "1" } });
      assert.equal(JSON.parse(output).events, events.length);
      assert.ok(!output.includes("fixture-token"));
    }
    assert.ok(events.some((event) => event.kind === "interaction.input" && event.payload.value === expectedValue));
    assert.ok(events.some((event) => event.kind === "page.snapshot" && event.payload.sourceHtml?.includes("window.fixtureLoaded=true")));
    if (index === 1) {
      assert.ok(events.some((event) => event.kind === "network.request" && event.payload.url.includes("token=fixture-token")));
      assert.ok(events.some((event) => event.kind === "cookie.initial" && event.payload.items?.some((cookie) => cookie.value === "fixture-cookie")));
    }
  }
  const layout = await panel.evaluate(() => ({ width: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth }));
  assert.equal(layout.width, layout.scrollWidth);
  assert.equal(context.pages().length, 3);
  console.log("侧边栏录制、停止、批次选择和分别导出通过");
} finally {
  if (context) await context.close();
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  await fs.rm(extension, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}
