import { launchExtension } from "./chrome-harness.mjs";
import http from "node:http";
import path from "node:path";
import fs from "node:fs/promises";
import assert from "node:assert/strict";
import { unzipSync, strFromU8 } from "fflate";
import { reconstructFragments } from "../src/fragments.js";

const server = http.createServer((_request, response) => {
  response.writeHead(200, { "Content-Type": "text/html" });
  response.end(`<!doctype html><title>Interrupted fragment</title><input id="value"><div hidden>${"d".repeat(1600000)}</div>`);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const profile = await fs.mkdtemp(path.resolve("test-fragment-interruption-profile-"));
const extension = await fs.mkdtemp(path.resolve("test-fragment-interruption-extension-"));
let browser;
try {
  await fs.cp(path.resolve("dist"), extension, { recursive: true });
  const manifestPath = path.join(extension, "manifest.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  manifest.host_permissions = ["http://*/*", "https://*/*"];
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  const contentPath = path.join(extension, "content.js");
  const fixture = `{
    const original = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = async (message, ...args) => {
      if (message?.type !== 'EVENTS') return original(message, ...args);
      const removed = message.events.filter((event) => event.kind === 'capture.fragmentEnd' && event.payload?.field === 'sourceHtml');
      if (!removed.length) return original(message, ...args);
      const events = message.events.filter((event) => !removed.includes(event));
      const result = events.length ? await original({ ...message, events }, ...args) : { ok: true, value: { accepted: 0, failed: 0 } };
      if (result?.ok && result.value && Number.isSafeInteger(result.value.accepted))
        return { ...result, value: { ...result.value, accepted: result.value.accepted + removed.length } };
      return result;
    };
  }\n`;
  await fs.writeFile(contentPath, fixture + await fs.readFile(contentPath, "utf8"));
  browser = await launchExtension(profile, extension);
  const context = browser.context;
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${browser.id}/sidepanel.html`);
  await page.bringToFront();
  await panel.getByRole("button", { name: "开始录制" }).click();
  await panel.getByText("录制中", { exact: true }).waitFor({ timeout: 30000 });
  await page.locator("#value").fill("saved-event");
  await panel.getByRole("button", { name: "停止录制" }).click();
  await panel.getByRole("button", { name: "开始录制" }).waitFor({ timeout: 45000 });
  await panel.getByRole("radio").first().waitFor();
  await panel.getByRole("radio").first().check();
  const downloadPromise = panel.waitForEvent("download", { timeout: 30000 });
  await panel.getByRole("button", { name: "导出记录包" }).click();
  const download = await downloadPromise;
  const archivePath = path.join(profile, "interrupted.zip");
  await download.saveAs(archivePath);
  const files = unzipSync(await fs.readFile(archivePath));
  const archive = JSON.parse(strFromU8(files["manifest.json"]));
  const events = archive.eventChunks.flatMap((chunk) => strFromU8(files[chunk]).split("\n").filter(Boolean).map(JSON.parse));
  const snapshot = events.find((event) => event.kind === "page.snapshot" && event.payload.sourceReference?.field === "sourceHtml");
  assert.ok(snapshot, "缺少大页面分段引用");
  assert.ok(events.some((event) => event.kind === "capture.fragment" && event.payload.captureId === snapshot.payload.sourceReference.captureId));
  assert.ok(!events.some((event) => event.kind === "capture.fragmentEnd" && event.payload.captureId === snapshot.payload.sourceReference.captureId));
  assert.throws(() => reconstructFragments(snapshot.payload.sourceReference, events));
  assert.ok(archive.session.coverage.snapshotGaps > 0);
  assert.ok(events.some((event) => event.kind === "interaction.input" && event.payload.value === "saved-event"));
  console.log("模拟大页面分段结束确认丢失：记录包标记缺口，已保存操作仍可导出");
} finally {
  if (browser) await browser.close();
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  await fs.rm(extension, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}
