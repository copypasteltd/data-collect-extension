import { launchExtension, removeTestProfile } from "../tests/chrome-harness.mjs";
import http from "node:http";
import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const media = path.resolve(appRoot, "../docs/media");
const temp = await fs.mkdtemp(path.join(appRoot, ".demo-"));
const fixture = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>客户管理演示</title>
<style>body{margin:0;background:#f4f7f6;color:#22362f;font:15px Arial,sans-serif}header{background:#174c3e;color:white;padding:18px 28px;font-weight:bold}main{max-width:920px;margin:32px auto;padding:0 24px}h1{font-size:24px}section{background:white;border:1px solid #dce7e2;border-radius:6px;padding:22px;margin-top:20px}button{border:0;border-radius:4px;background:#216b55;color:white;padding:10px 16px}input{border:1px solid #bdcec6;border-radius:4px;padding:10px;width:190px}</style>
<header>示例工作台 / 客户管理</header><main><h1>客户管理</h1><p>本地演示数据</p><section><label>客户编号 <input id="query"></label> <button id="search">查询</button><p id="result">等待查询</p></section></main>
<script>document.querySelector('#search').onclick=async()=>{const r=await fetch('/api/customers?code='+encodeURIComponent(document.querySelector('#query').value));document.querySelector('#result').textContent=(await r.json()).name}</script></html>`;
const server = http.createServer((request, response) => {
  if (request.url.startsWith("/api/customers")) {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ code: "C001", name: "示例客户 A" }));
  } else {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(fixture);
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
let browser;
const profile = path.join(temp, "profile");
try {
  const extension = path.join(temp, "extension");
  await fs.cp(path.join(appRoot, "dist"), extension, { recursive: true });
  const manifestPath = path.join(extension, "manifest.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  manifest.host_permissions = ["http://*/*", "https://*/*"];
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  browser = await launchExtension(profile, extension, ["--window-size=1280,1000"]);
  const context = browser.context;
  const site = await context.newPage();
  await site.goto(`http://127.0.0.1:${server.address().port}/`);
  const panel = await context.newPage();
  await panel.setViewportSize({ width: 420, height: 900 });
  await panel.goto(`chrome-extension://${browser.id}/sidepanel.html`);
  await site.bringToFront();
  await panel.waitForTimeout(2200);
  await panel.screenshot({ path: path.join(media, "v0.4.0-01-ready.png") });
  await panel.waitForTimeout(800);
  await panel.getByRole("button", { name: "开始录制" }).click();
  await panel.getByRole("button", { name: "停止录制" }).waitFor({ timeout: 20000 });
  await panel.screenshot({ path: path.join(media, "v0.4.0-02-recording.png") });
  await site.locator("#query").fill("C001");
  await site.locator("#search").click();
  await site.getByText("示例客户 A").waitFor();
  await site.screenshot({ path: path.join(media, "v0.4.0-sample-site.png") });
  await panel.waitForTimeout(800);
  await panel.getByRole("button", { name: "停止录制" }).click();
  await panel.getByRole("radio").first().waitFor({ timeout: 20000 });
  await panel.waitForTimeout(800);
  await site.bringToFront();
  await panel.waitForTimeout(2200);
  await panel.getByRole("button", { name: "开始录制" }).click();
  await panel.getByRole("button", { name: "停止录制" }).waitFor({ timeout: 20000 });
  await site.locator("#query").fill("C002");
  await panel.waitForTimeout(600);
  await panel.getByRole("button", { name: "停止录制" }).click();
  await panel.waitForFunction(() => document.querySelectorAll('input[type="radio"]').length === 2);
  await panel.getByRole("radio").nth(1).check();
  await panel.waitForTimeout(600);
  await panel.screenshot({ path: path.join(media, "v0.4.0-03-history.png") });
  const download = panel.waitForEvent("download", { timeout: 15000 });
  await panel.getByRole("button", { name: "导出记录包" }).click();
  await (await download).saveAs(path.join(temp, "demo.zip"));
  await panel.waitForTimeout(1200);
  await browser.close();
  browser = null;
  console.log(`演示素材已生成：${media}`);
} finally {
  if (browser) await browser.close();
  await new Promise((resolve) => server.close(resolve));
  const removed = await removeTestProfile(profile, () => fs.rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }));
  if (removed.status === "removed")
    await fs.rm(temp, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}
