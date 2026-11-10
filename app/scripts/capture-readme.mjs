import { chromium } from "playwright";
import http from "node:http";
import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const media = path.resolve(appRoot, "../docs/media");
const temp = await fs.mkdtemp(path.join(appRoot, ".demo-"));
const fixture = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>客户管理演示</title>
<style>body{margin:0;background:#f4f7f6;color:#22362f;font:15px Arial,sans-serif}header{background:#174c3e;color:white;padding:18px 28px;font-weight:bold}main{max-width:920px;margin:32px auto;padding:0 24px}h1{font-size:24px;margin:0 0 8px}p{color:#62766f}section{background:white;border:1px solid #dce7e2;border-radius:6px;padding:22px;margin-top:20px}button{border:0;border-radius:4px;background:#216b55;color:white;padding:10px 16px;cursor:pointer}input{border:1px solid #bdcec6;border-radius:4px;padding:10px;width:190px}table{border-collapse:collapse;width:100%;margin-top:16px}th,td{border-bottom:1px solid #e3ebe7;padding:12px;text-align:left}th{font-size:12px;color:#71867d}#details{margin-top:15px;padding:12px;background:#edf6f1;border-left:3px solid #308566}#details[hidden]{display:none}</style>
<header>示例工作台　/　客户管理</header><main><h1>客户管理</h1><p>本地演示数据</p><section><strong>预约趋势</strong><canvas id="demo-chart" width="300" height="80" style="display:block;max-width:100%;margin-top:10px"></canvas></section><section><button id="open">查看客户详情</button><div id="details" hidden>示例客户 A　·　状态：已预约</div></section><section><label>客户编号 <input id="query" placeholder="输入客户编号"></label> <button id="search">查询</button><table><thead><tr><th>编号</th><th>客户</th><th>状态</th></tr></thead><tbody id="result"><tr><td>C001</td><td>示例客户 A</td><td>待查询</td></tr></tbody></table></section></main>
<script>const chart=document.querySelector('#demo-chart').getContext('2d');chart.fillStyle='#edf6f1';chart.fillRect(0,0,300,80);[28,48,36,62,52,70].forEach((height,index)=>{chart.fillStyle=index===5?'#d09b49':'#438b72';chart.fillRect(18+index*46,75-height,27,height)});document.querySelector('#open').onclick=()=>{document.querySelector('#details').hidden=false};document.querySelector('#search').onclick=async()=>{const response=await fetch('/api/customers?code='+encodeURIComponent(document.querySelector('#query').value));const data=await response.json();document.querySelector('#result').innerHTML='<tr><td>'+data.code+'</td><td>'+data.name+'</td><td>'+data.status+'</td></tr>'}</script></html>`;
const server = http.createServer((req, res) => {
  if (req.url.startsWith("/api/customers")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ code: "C001", name: "示例客户 A", status: "已预约" }));
  } else {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(fixture);
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
let browser;
try {
  await fs.mkdir(media, { recursive: true });
  const extension = path.join(temp, "extension");
  await fs.cp(path.join(appRoot, "dist"), extension, { recursive: true });
  const manifestPath = path.join(extension, "manifest.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  manifest.host_permissions = ["http://*/*", "https://*/*"];
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  browser = await chromium.launchPersistentContext(path.join(temp, "profile"), {
    executablePath: process.env.CHROME_BIN || chromium.executablePath(),
    headless: true,
    viewport: null,
    acceptDownloads: true,
    recordVideo: { dir: path.join(temp, "video"), size: { width: 420, height: 900 } },
    args: ["--window-size=1280,1000", `--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  const worker = browser.serviceWorkers()[0] || await browser.waitForEvent("serviceworker", { timeout: 15000 });
  const site = await browser.newPage();
  await site.goto(`http://127.0.0.1:${server.address().port}/`);
  const panel = await browser.newPage();
  await panel.setViewportSize({ width: 420, height: 900 });
  await panel.goto(`chrome-extension://${new URL(worker.url()).host}/sidepanel.html`);
  const video = panel.video();
  await site.bringToFront();
  await panel.waitForTimeout(2200);
  await panel.getByText("我有权记录当前站点").click();
  await panel.screenshot({ path: path.join(media, "01-ready.png") });
  await panel.waitForTimeout(800);
  await panel.getByRole("button", { name: "开始录制" }).click();
  await panel.getByText("录制中", { exact: true }).first().waitFor({ timeout: 15000 });
  await panel.screenshot({ path: path.join(media, "02-recording.png") });
  await site.locator("#open").click();
  await site.waitForTimeout(600);
  await site.locator("#query").fill("C001");
  await site.waitForTimeout(500);
  await site.locator("#search").click();
  await site.locator("#result").getByText("已预约").waitFor();
  await site.screenshot({ path: path.join(media, "sample-site.png") });
  await panel.waitForTimeout(1200);
  await panel.getByRole("button", { name: "停止录制" }).click();
  const record = panel.locator(".record").filter({ hasText: "客户管理演示" }).first();
  await record.getByTitle("下载记录包").waitFor({ state: "visible", timeout: 20000 });
  await panel.waitForTimeout(800);
  await panel.screenshot({ path: path.join(media, "03-history.png") });
  const download = panel.waitForEvent("download", { timeout: 15000 });
  await record.getByTitle("下载记录包").click();
  const zip = await download;
  await zip.saveAs(path.join(temp, "demo.zip"));
  await panel.waitForTimeout(700);
  await record.getByTitle("查看记录").click();
  await panel.getByRole("heading", { name: "客户管理演示" }).waitFor();
  await panel.waitForTimeout(600);
  await panel.screenshot({ path: path.join(media, "04-timeline.png") });
  await panel.getByRole("button", { name: /^流程 \d+$/ }).click();
  await panel.getByText("操作流程").waitFor();
  await panel.screenshot({ path: path.join(media, "05-flow.png") });
  await panel.waitForTimeout(800);
  await panel.getByRole("button", { name: "复现", exact: true }).click();
  await panel.getByRole("button", { name: "页面", exact: true }).click();
  const replay = panel.frameLocator('iframe[title="逐步复现页面"]');
  await replay.locator("#open").waitFor({ state: "visible" });
  await panel.waitForTimeout(700);
  await replay.locator("#open").click();
  await panel.getByText(/^步骤 2 \/ /).waitFor();
  await replay.locator("#details").getByText("示例客户 A", { exact: false }).waitFor();
  await panel.screenshot({ path: path.join(media, "06-replay.png") });
  await panel.waitForTimeout(1500);
  const canvasSnapshotId = await panel.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("logic-recorder");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const events = await new Promise((resolve, reject) => {
      const request = db.transaction("events").objectStore("events").getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return events.filter((event) => event.kind === "page.snapshot" && event.payload?.canvas?.captured > 0 &&
      event.payload?.html?.includes('id="demo-chart"')).sort((a, b) => b.seq - a.seq)[0]?.id;
  });
  if (!canvasSnapshotId) throw new Error("演示画布快照未采集");
  await panel.getByRole("button", { name: "时间线", exact: true }).click();
  await panel.getByPlaceholder("搜索记录").fill(canvasSnapshotId);
  await panel.locator(".timeline-item").first().click();
  await panel.frameLocator('iframe[title="页面快照"]').locator("#demo-chart").waitFor({ state: "visible" });
  await panel.locator(".detail-content").evaluate((element) => element.scrollIntoView({ block: "start" }));
  await panel.waitForTimeout(700);
  await panel.screenshot({ path: path.join(media, "07-canvas.png") });
  await panel.waitForTimeout(1200);
  await browser.close();
  browser = null;
  await fs.copyFile(await video.path(), path.join(media, "workflow.webm"));
  console.log(`演示素材已生成：${media}`);
} finally {
  if (browser) await browser.close();
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(temp, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}
