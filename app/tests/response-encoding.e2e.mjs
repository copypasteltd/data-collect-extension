import { chromium } from "playwright";
import http from "node:http";
import path from "node:path";
import fs from "node:fs/promises";
import assert from "node:assert/strict";
import { unzipSync, strFromU8 } from "fflate";

const server = http.createServer((request, response) => {
  if (request.url === "/form") {
    response.setHeader(
      "Content-Type",
      "application/x-www-form-urlencoded; charset=utf-8",
    );
    response.end("customer=C001&token=private-form-value");
  } else if (request.url === "/graphql") {
    response.setHeader("Content-Type", "application/graphql; charset=utf-8");
    response.end(
      "query Customer { customerName } # token=private-graphql-value",
    );
  } else if (request.url === "/invalid" || request.url === "/invalid-base64") {
    response.setHeader("Content-Type", "application/graphql; charset=utf-8");
    response.end(Buffer.from([0xff, 0xfe, 0xff]));
  } else if (request.url === "/gbk") {
    response.setHeader("Content-Type", "application/graphql; charset=gbk");
    response.end(Buffer.from([0xd6, 0xd0, 0xce, 0xc4]));
  } else if (request.url === "/invalid-json") {
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.end("{invalid-json");
  } else if (request.url === "/empty") {
    response.setHeader("Content-Type", "application/graphql; charset=utf-8");
    response.end("");
  } else {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end("<!doctype html><title>响应编码测试</title>");
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const profile = await fs.mkdtemp(path.resolve("test-response-profile-"));
const extension = await fs.mkdtemp(path.resolve("test-response-extension-"));
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
    acceptDownloads: true,
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
  await worker.evaluate(() => {
    const original = chrome.debugger.sendCommand.bind(chrome.debugger);
    const paths = new Map();
    chrome.debugger.onEvent.addListener((_source, method, params) => {
      if (method === "Network.requestWillBeSent")
        paths.set(params.requestId, new URL(params.request.url).pathname);
    });
    // Simulate CDP returning encoded bytes for text responses.
    chrome.debugger.sendCommand = async (...args) => {
      const result = await original(...args);
      if (args[1] !== "Network.getResponseBody") return result;
      const path = paths.get(args[2].requestId);
      if (path === "/invalid-base64")
        return { body: "//7/", base64Encoded: true };
      if (path === "/gbk") return { body: "1tDOxA==", base64Encoded: true };
      if (["/form", "/graphql"].includes(path)) {
        const bytes = new TextEncoder().encode(result.body);
        return {
          body: btoa(String.fromCharCode(...bytes)),
          base64Encoded: true,
        };
      }
      return result;
    };
  });
  await page.evaluate(async () => {
    for (const url of [
      "/form",
      "/graphql",
      "/invalid",
      "/invalid-base64",
      "/gbk",
      "/invalid-json",
      "/empty",
    ])
      await (await fetch(url)).arrayBuffer();
  });
  await page.waitForTimeout(600);
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
  function responseFor(pathname) {
    const request = events.find(
      (event) =>
        event.kind === "network.request" &&
        new URL(event.payload.url).pathname === pathname,
    );
    return events.find(
      (event) =>
        event.kind === "network.finished" &&
        event.payload.requestId === request?.payload.requestId,
    )?.payload.body;
  }
  const form = responseFor("/form"),
    graphql = responseFor("/graphql"),
    invalid = responseFor("/invalid");
  assert.equal(form?.status, "captured_redacted");
  assert.equal(new URLSearchParams(form.value).get("customer"), "C001");
  assert.equal(new URLSearchParams(form.value).get("token"), "[已隐藏]");
  assert.equal(graphql?.status, "captured_redacted_best_effort");
  assert.ok(
    graphql.value.includes("customerName") &&
      !graphql.value.includes("private-graphql-value"),
  );
  assert.equal(invalid?.status, "unavailable");
  assert.match(invalid.reason, /声明长度非零/);
  assert.equal(responseFor("/invalid-base64")?.status, "omitted_encoding");
  assert.equal(responseFor("/gbk")?.value, "中文");
  assert.equal(responseFor("/invalid-json")?.status, "omitted_unparseable");
  assert.equal(responseFor("/empty")?.status, "empty");
  assert.ok(stopped.value.coverage.responseGaps >= 3);
  await panel.reload();
  const record = panel.locator(".record").filter({ hasText: "响应编码测试" });
  await record.getByText("完成（有采集提示）").waitFor();
  const downloadPromise = panel.waitForEvent("download");
  await record.getByTitle("下载记录包").click();
  const archivePath = path.join(profile, "responses.zip");
  await (await downloadPromise).saveAs(archivePath);
  const files = unzipSync(await fs.readFile(archivePath));
  const archiveManifest = JSON.parse(strFromU8(files["manifest.json"]));
  const archiveEvents = archiveManifest.eventChunks.flatMap((chunk) =>
    strFromU8(files[chunk]).split("\n").filter(Boolean).map(JSON.parse),
  );
  const text = JSON.stringify(archiveEvents);
  assert.ok(
    !text.includes("private-form-value") &&
      !text.includes("private-graphql-value"),
  );
  await panel.getByRole("button", { name: "导入记录包" }).click();
  await panel.locator("input[type=file]").first().setInputFiles(archivePath);
  await panel.getByRole("heading", { name: "响应编码测试" }).waitFor();
  await panel.getByRole("button", { name: "报告", exact: true }).click();
  await panel.getByText("响应体编码无法解析").first().waitFor();
  await panel.getByText("响应体无法读取").first().waitFor();
  await panel.getByText("响应体内容无法解析").first().waitFor();
  console.log("编码文本响应的采集、脱敏和异常提示通过");
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
