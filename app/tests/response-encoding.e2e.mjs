import { launchExtension } from "./chrome-harness.mjs";
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
let context, browser;
try {
  await fs.cp(path.resolve("dist"), extension, { recursive: true });
  const manifestPath = path.join(extension, "manifest.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  manifest.host_permissions = ["http://*/*", "https://*/*"];
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  browser = await launchExtension(profile, extension);
  context = browser.context;
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${browser.id}/sidepanel.html`);
  const worker = context.serviceWorkers().find((item) => item.url().startsWith(`chrome-extension://${browser.id}/`)) ||
    await context.waitForEvent("serviceworker", { predicate: (item) => item.url().startsWith(`chrome-extension://${browser.id}/`), timeout: 15000 });
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
  assert.equal(form?.status, "captured");
  assert.equal(new URLSearchParams(form.value).get("customer"), "C001");
  assert.equal(new URLSearchParams(form.value).get("token"), "private-form-value");
  assert.equal(graphql?.status, "captured");
  assert.ok(
    graphql.value.includes("customerName") &&
      graphql.value.includes("private-graphql-value"),
  );
  assert.equal(invalid?.status, "unavailable");
  assert.match(invalid.reason, /声明长度非零/);
  assert.deepEqual(responseFor("/invalid-base64"), { value: "//7/", encoding: "base64", status: "captured", textStatus: "unavailable_encoding" });
  assert.equal(responseFor("/gbk")?.value, "中文");
  assert.equal(responseFor("/invalid-json")?.status, "captured");
  assert.equal(responseFor("/empty")?.status, "empty");
  assert.ok(stopped.value.coverage.responseGaps >= 2);
  await panel.reload();
  await panel.getByRole("radio").first().waitFor();
  const downloadPromise = panel.waitForEvent("download");
  await panel.getByRole("button", { name: "导出记录包" }).click();
  const archivePath = path.join(profile, "responses.zip");
  await (await downloadPromise).saveAs(archivePath);
  const files = unzipSync(await fs.readFile(archivePath));
  const archiveManifest = JSON.parse(strFromU8(files["manifest.json"]));
  const archiveEvents = archiveManifest.eventChunks.flatMap((chunk) =>
    strFromU8(files[chunk]).split("\n").filter(Boolean).map(JSON.parse),
  );
  const text = JSON.stringify(archiveEvents);
  assert.ok(
    text.includes("private-form-value") &&
      text.includes("private-graphql-value"),
  );
  assert.ok(archiveEvents.some((event) => event.kind === "network.finished" && event.payload.body?.textStatus === "unavailable_encoding"));
  console.log("编码文本响应的原值采集和异常提示通过");
} finally {
  if (browser) await browser.close();
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
