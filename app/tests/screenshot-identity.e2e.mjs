import { chromium } from "playwright";
import path from "node:path";
import fs from "node:fs/promises";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { zipSync, strToU8 } from "fflate";

const url = "https://example.test/";
const viewport = { width: 100, height: 100, scrollX: 0, scrollY: 0 };
const events = [];
for (const [index, documentId, screenshotDocumentId] of [
  [1, "document-1", "document-1"],
  [2, "document-2", "different-document"],
  [3, null, "document-3"],
]) {
  const time = index * 5000;
  events.push({
    id: `action-${index}`,
    seq: index * 2 - 1,
    time,
    tabId: 1,
    frameId: 0,
    ...(documentId ? { documentId } : {}),
    kind: "interaction.click",
    payload: {
      url,
      viewport,
      target: {
        tag: "button",
        text: `操作${index}`,
        selector: `#button-${index}`,
        rect: { x: 10, y: 10, width: 20, height: 20 },
      },
    },
  });
  events.push({
    id: `shot-${index}`,
    seq: index * 2,
    time: time + 100,
    tabId: 1,
    kind: "screenshot",
    payload: {
      assetId: `image-${index}`,
      eventIds: [`action-${index}`],
      documentId: screenshotDocumentId,
      url,
      viewport,
      captureStartedAt: time + 20,
      capturedAt: time + 100,
    },
  });
}
const manifest = {
  format: "logic-recorder",
  version: 2,
  session: { id: "screenshot-identity", title: "截图归属测试", startedAt: 1 },
  eventCount: events.length,
  eventChunks: ["timeline/events-00001.jsonl"],
};
const image = new Uint8Array(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
    "base64",
  ),
);
const files = {
  "manifest.json": strToU8(JSON.stringify(manifest)),
  "timeline/events-00001.jsonl": strToU8(
    events.map((event) => JSON.stringify(event)).join("\n"),
  ),
  "screenshots/image-1.jpg": image,
  "screenshots/image-2.jpg": image,
  "screenshots/image-3.jpg": image,
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
const profile = await fs.mkdtemp(
  path.resolve("test-screenshot-identity-profile-"),
);
const extension = path.resolve("dist");
let context;
try {
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
      name: "identity.zip",
      mimeType: "application/zip",
      buffer: Buffer.from(zipSync(files)),
    });
  await panel.getByRole("heading", { name: "截图归属测试" }).waitFor();
  await panel.getByRole("button", { name: "复现", exact: true }).click();
  await panel.getByAltText("该步骤关联的页面截图").waitFor();
  const hotspot = panel.locator(".replay-hotspot");
  await hotspot.click();
  await panel
    .getByText("截图与操作的页面实例不一致", { exact: false })
    .waitFor();
  assert.equal(await hotspot.count(), 0);
  await panel.getByRole("button", { name: "下一步" }).click();
  await panel.getByText("截图页面实例未确认", { exact: false }).waitFor();
  assert.equal(await hotspot.count(), 0);
  await panel.getByRole("button", { name: "完成", exact: true }).click();
  await panel.getByRole("status").getByText("已到达记录末尾").waitFor();
  console.log("截图页面实例校验与侧边栏备用操作通过");
} finally {
  if (context) await context.close();
  await fs.rm(profile, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 250,
  });
}
