import { chromium } from "playwright";
import http from "node:http";
import path from "node:path";
import fs from "node:fs/promises";
import assert from "node:assert/strict";

const server = http.createServer((_request, response) => {
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end(
    '<!doctype html><title>长文本测试</title><textarea id="note"></textarea><textarea id="multiline"></textarea><input id="redacted">',
  );
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const profile = await fs.mkdtemp(path.resolve("test-input-profile-"));
const extension = await fs.mkdtemp(path.resolve("test-input-extension-"));
let context;
try {
  await fs.cp(path.resolve("dist"), extension, { recursive: true });
  const manifestPath = path.join(extension, "manifest.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  manifest.host_permissions = ["http://*/*", "https://*/*"];
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  context = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.CHROME_BIN || chromium.executablePath(),
    headless: true,
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
    ],
  });
  const worker =
    context.serviceWorkers()[0] ||
    (await context.waitForEvent("serviceworker", { timeout: 15000 }));
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const panel = await context.newPage();
  await panel.goto(
    `chrome-extension://${new URL(worker.url()).host}/sidepanel.html`,
  );
  const [tab] = await worker.evaluate(() =>
    chrome.tabs.query({ url: "http://127.0.0.1/*" }),
  );
  const started = await panel.evaluate(
    (tab) =>
      chrome.runtime.sendMessage({
        type: "START",
        tab,
        options: { screenshots: false, scope: "site" },
      }),
    tab,
  );
  assert.equal(started.ok, true);
  await page.locator("#note").fill("a".repeat(6000));
  await page.waitForTimeout(700);
  await page.locator("#note").fill("b".repeat(12000));
  await page.waitForTimeout(700);
  await page.locator("#multiline").fill("第一行\n第二行");
  await page.locator("#redacted").fill("token=x ".repeat(1200));
  const stopped = await panel.evaluate(() =>
    chrome.runtime.sendMessage({ type: "STOP" }),
  );
  assert.equal(stopped.ok, true);
  const events = await panel.evaluate(async (sessionId) => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("logic-recorder");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const result = await new Promise((resolve, reject) => {
      const request = db
        .transaction("events")
        .objectStore("events")
        .index("session")
        .getAll(sessionId);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return result;
  }, stopped.value.id);
  const inputs = events
    .filter(
      (event) =>
        event.kind === "interaction.input" &&
        event.payload.target?.selector === "#note",
    )
    .sort((a, b) => a.seq - b.seq);
  const replaySteps = events
    .filter(
      (event) =>
        [
          "interaction.click",
          "interaction.input",
          "interaction.change",
          "interaction.submit",
        ].includes(event.kind) && event.payload.target,
    )
    .sort((a, b) => a.time - b.time || a.seq - b.seq);
  assert.equal(inputs.length, 2);
  assert.equal(inputs[0].payload.value, "a".repeat(6000));
  assert.equal(inputs[0].payload.valueStatus, "captured");
  assert.equal(inputs[1].payload.beforeValue, "a".repeat(6000));
  assert.equal(inputs[1].payload.value, "b".repeat(10000));
  assert.equal(inputs[1].payload.valueStatus, "truncated");
  const redactedInput = events.find(
    (event) =>
      event.kind === "interaction.input" &&
      event.payload.target?.selector === "#redacted",
  );
  assert.equal(redactedInput?.payload.valueStatus, "redacted_truncated");
  assert.equal(redactedInput.payload.value.length, 10000);
  assert.ok(!redactedInput.payload.value.includes("token=x"));
  const finalSnapshot = events
    .filter(
      (event) =>
        event.kind === "page.snapshot" &&
        event.payload.html?.includes('id="redacted"'),
    )
    .sort((a, b) => a.time - b.time || a.seq - b.seq)
    .at(-1);
  const snapshotValue = await panel.evaluate(
    (html) =>
      new DOMParser()
        .parseFromString(html, "text/html")
        .querySelector("#redacted")
        .getAttribute("value"),
    finalSnapshot.payload.html,
  );
  assert.equal(snapshotValue.length, 10000);
  assert.ok(!snapshotValue.includes("token=x"));
  assert.ok(
    events.some(
      (event) =>
        event.kind === "page.snapshot" &&
        event.payload.html?.includes("a".repeat(6000)),
    ),
  );
  assert.ok(
    events.some(
      (event) =>
        event.kind === "page.snapshot" &&
        event.payload.status === "truncated" &&
        event.payload.html?.includes("b".repeat(10000)),
    ),
  );
  assert.ok(stopped.value.coverage.inputGaps >= 1);
  await panel.reload();
  const record = panel.locator(".record").filter({ hasText: "长文本测试" });
  await record.getByTitle("查看记录").click();
  await panel.getByRole("button", { name: "报告", exact: true }).click();
  await panel.getByText("输入值超过采集上限，仅记录部分内容").first().waitFor();
  await panel.getByRole("button", { name: "复现", exact: true }).click();
  await panel.getByLabel("输入记录值").fill("a".repeat(6000));
  await panel.getByText("输入值超过采集上限，仅显示已记录内容").waitFor();
  const fallbackValue = await panel.getByLabel("输入记录值").inputValue();
  assert.ok(
    fallbackValue === "a".repeat(6000),
    `备用输入初始状态错误：长度 ${fallbackValue.length}，前缀 ${fallbackValue.slice(0, 4)}`,
  );
  await panel.getByRole("button", { name: "页面", exact: true }).click();
  const replayInput = panel
    .frameLocator('iframe[title="逐步复现页面"]')
    .locator("#note");
  await replayInput.waitFor();
  await panel.waitForFunction(
    () =>
      document
        .querySelector('iframe[title="逐步复现页面"]')
        ?.contentDocument?.querySelector("#note")?.value === "a".repeat(6000),
  );
  const replayValue = await replayInput.inputValue();
  assert.ok(
    replayValue === "a".repeat(6000),
    `页面输入初始状态错误：长度 ${replayValue.length}，前缀 ${replayValue.slice(0, 4)}`,
  );
  await replayInput.fill("b".repeat(10000));
  await panel.getByRole("heading", { name: "更改 textarea" }).waitFor();
  await panel.getByRole("button", { name: "下一步" }).click();
  await panel.getByRole("button", { name: "截图", exact: true }).click();
  const fallback = panel.getByLabel("输入记录值");
  assert.equal(await fallback.evaluate((node) => node.localName), "textarea");
  const multilineIndex = replaySteps.findIndex(
    (event) =>
      event.kind === "interaction.input" &&
      event.payload.target?.selector === "#multiline",
  );
  assert.ok(multilineIndex >= 0);
  await fallback.fill("第一行\n第二行");
  if (multilineIndex === replaySteps.length - 1)
    await panel.getByRole("status").getByText("已到达记录末尾").waitFor();
  else
    await panel
      .getByText(`步骤 ${multilineIndex + 2} / ${replaySteps.length}`)
      .waitFor();
  console.log("长输入采集、快照与截断提示通过");
} finally {
  if (context) await context.close();
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(profile, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 250,
  });
  await fs.rm(extension, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 250,
  });
}
