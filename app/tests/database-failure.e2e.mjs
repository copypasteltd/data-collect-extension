import { launchExtension, removeTestProfile } from "./chrome-harness.mjs";
import http from "node:http";
import path from "node:path";
import fs from "node:fs/promises";
import assert from "node:assert/strict";
import { unzipSync, strFromU8 } from "fflate";

const server = http.createServer((_request, response) => {
  response.writeHead(200, { "Content-Type": "text/html" });
  response.end("<!doctype html><title>Database failure</title><input id='value'>");
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

async function runScenario(mode) {
  const profile = await fs.mkdtemp(path.resolve("test-db-failure-profile-"));
  const extension = await fs.mkdtemp(path.resolve("test-db-failure-extension-"));
  let browser;
  try {
    await fs.cp(path.resolve("dist"), extension, { recursive: true });
    const manifestPath = path.join(extension, "manifest.json");
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    manifest.host_permissions = ["http://*/*", "https://*/*"];
    await fs.writeFile(manifestPath, JSON.stringify(manifest));
    const contentPath = path.join(extension, "content.js");
    const replacement = mode === "failure"
      ? "async () => { throw new Error('fixture database failure'); }"
      : "() => new Promise(() => {})";
    await fs.writeFile(contentPath, `Object.defineProperty(indexedDB, 'databases', { configurable: true, value: ${replacement} });\n` +
      await fs.readFile(contentPath, "utf8"));
    browser = await launchExtension(profile, extension);
    const context = browser.context;
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    const panel = await context.newPage();
    await panel.goto(`chrome-extension://${browser.id}/sidepanel.html`);
    await page.bringToFront();
    await panel.getByRole("button", { name: "开始录制" }).click();
    await panel.getByText("录制中", { exact: true }).waitFor({ timeout: 30000 });
    await page.locator("#value").fill(`fixture-${mode}`);
    await panel.getByRole("button", { name: "停止录制" }).click();
    await panel.getByRole("button", { name: "开始录制" }).waitFor({ timeout: 45000 });
    await panel.getByRole("radio").first().waitFor();
    await panel.getByRole("radio").first().check();
    const downloadPromise = panel.waitForEvent("download", { timeout: 30000 });
    await panel.getByRole("button", { name: "导出记录包" }).click();
    const download = await downloadPromise;
    const archivePath = path.join(profile, "failure.zip");
    await download.saveAs(archivePath);
    const files = unzipSync(await fs.readFile(archivePath));
    const archive = JSON.parse(strFromU8(files["manifest.json"]));
    const events = archive.eventChunks.flatMap((chunk) => strFromU8(files[chunk]).split("\n").filter(Boolean).map(JSON.parse));
    assert.ok(events.some((event) => event.kind === "interaction.input" && event.payload.value === `fixture-${mode}`));
    if (mode === "failure") {
      assert.ok(events.some((event) => event.kind === "database.snapshot" && event.payload.status === "failed" &&
        event.payload.error.includes("fixture database failure")));
      assert.ok(archive.session.coverage.databaseGaps > 0);
    } else {
      assert.ok(events.some((event) => event.kind === "state.capture" && event.payload.source === "database" && event.payload.status === "timeout"));
      assert.ok(archive.session.coverage.stateCaptureGaps > 0);
    }
    console.log(`数据库${mode === "failure" ? "读取失败" : "采集超时"}的缺口和已保存事件可导出`);
  } finally {
    if (browser) await browser.close();
    await removeTestProfile(profile, () => fs.rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }));
    await fs.rm(extension, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
}

try {
  await runScenario("failure");
  await runScenario("timeout");
} finally {
  await new Promise((resolve) => server.close(resolve));
}
