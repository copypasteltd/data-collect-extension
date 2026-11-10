import { chromium } from "playwright";
import path from "node:path";
import fs from "node:fs/promises";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { zipSync, strToU8 } from "fflate";

const a = "https://example.test/a", b = "https://example.test/b", c = "https://example.test/c";
const snapshot = (id, time, documentId, url, text) => ({
  id, seq: time, time, tabId: 1, frameId: 0, documentId,
  kind: "page.snapshot", payload: { url, status: "captured", html: `<html><body><div id="page">${text}</div></body></html>` },
});
const navigation = (id, time, documentId, url) => ({
  id, seq: time, time, tabId: 1, frameId: 0,
  kind: "navigation.committed", payload: { documentId, url },
});
const request = (id, time, documentUrl) => ({
  id, seq: time, time, tabId: 1, kind: "network.request",
  payload: { requestId: id, type: "Fetch", method: "GET", url: `https://example.test/api/${id}`, sourceFrame: "main", documentUrl },
});
const events = [
  snapshot("page-a", 10, "doc-a", a, "页面甲"),
  request("req-a", 20, a),
  snapshot("page-a-updated", 22, "doc-a", a, "页面甲更新"),
  { id: "response-a-early", seq: 25, time: 25, tabId: 1, kind: "network.response", payload: { requestId: "req-a", status: 200 } },
  navigation("navigate-b", 30, "doc-b", b),
  request("req-b-before", 40, b),
  snapshot("page-b", 50, "doc-b", b, "页面乙"),
  request("req-b-after", 60, b),
  navigation("reload-b", 70, "doc-b2", b),
  request("req-b-reload", 80, b),
  { id: "response-a", seq: 90, time: 90, tabId: 1, kind: "network.response", payload: { requestId: "req-a", status: 200 } },
  { id: "route-c", seq: 100, time: 100, tabId: 1, kind: "navigation.spa", payload: { tabId: 1, url: c } },
  request("req-c-before", 110, c),
  snapshot("page-c", 120, "doc-b2", c, "页面丙"),
  request("req-c-after", 130, c),
];
const manifest = { format: "logic-recorder", version: 2,
  session: { id: "context-test", title: "接口页面归属测试", startedAt: 1 },
  eventCount: events.length, eventChunks: ["timeline/events-00001.jsonl"] };
const files = {
  "manifest.json": strToU8(JSON.stringify(manifest)),
  "timeline/events-00001.jsonl": strToU8(events.map((event) => JSON.stringify(event)).join("\n")),
};
files["integrity.json"] = strToU8(JSON.stringify(Object.entries(files).map(([name, bytes]) => ({
  path: name, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"),
}))));
const profile = await fs.mkdtemp(path.resolve("test-network-context-profile-"));
let context;
try {
  const extension = path.resolve("dist");
  context = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.CHROME_BIN || chromium.executablePath(),
    headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  const worker = context.serviceWorkers()[0] ||
    await context.waitForEvent("serviceworker", { timeout: 15000 });
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${new URL(worker.url()).host}/sidepanel.html`);
  await panel.getByRole("button", { name: "导入记录包" }).click();
  await panel.locator('input[type="file"]').first().setInputFiles({
    name: "context.zip", mimeType: "application/zip", buffer: Buffer.from(zipSync(files)),
  });
  await panel.getByRole("heading", { name: "接口页面归属测试" }).waitFor();
  async function select(id) {
    await panel.getByPlaceholder("搜索记录").fill(id);
    await panel.locator(".timeline-item").first().click();
  }
  async function expectPage(id, text) {
    await select(id);
    await panel.frameLocator('iframe[title="页面快照"]').locator("#page").getByText(text).waitFor();
  }
  async function expectMissing(id) {
    await select(id);
    await panel.getByText("请求所属页面快照无法确认").waitFor({ timeout: 5000 });
    assert.equal(await panel.locator('iframe[title="页面快照"]').count(), 0, `${id} 错误关联了页面`);
  }
  await expectPage("req-a", "页面甲");
  await expectPage("response-a-early", "页面甲更新");
  await expectMissing("req-b-before");
  await expectPage("req-b-after", "页面乙");
  await expectMissing("req-b-reload");
  await expectPage("response-a", "页面甲");
  await expectMissing("req-c-before");
  await expectPage("req-c-after", "页面丙");
  console.log("接口页面归属、刷新和延迟响应通过");
} finally {
  if (context) await context.close();
  await fs.rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}
