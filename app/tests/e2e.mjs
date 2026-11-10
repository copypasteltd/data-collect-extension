import { chromium } from "playwright";
import http from "node:http";
import path from "node:path";
import fs from "node:fs/promises";
import { unzipSync, zipSync, strToU8, strFromU8 } from "fflate";
import { createHash } from "node:crypto";
import { WebSocketServer } from "ws";

const html = `<!doctype html><html lang="zh"><title>录制测试</title><body><h1>客户管理</h1><input id="search" placeholder="客户名称"><input id="password" type="password" value="test-secret-value"><input autocomplete="cc-number" value="hidden-value-credit"><input id="file" type="file" name="attachment"><button id="find">查询</button><button id="route">详情</button><button id="flash">短暂提示</button><button id="embed">打开嵌入页面</button><a id="download" href="/report.csv" download>下载表格</a><div contenteditable aria-label="密码">hidden-value-editor</div><span id="sensitive-text" data-info='{"token":"hidden-value-attr"}'>token="hidden-value visible"</span><div id="result">等待查询</div><script>document.querySelector('#find').onclick=async()=>{const r=await fetch('/api/customers?q='+encodeURIComponent(document.querySelector('#search').value)); const d=await r.json(); document.querySelector('#result').textContent=d.name};document.querySelector('#route').onclick=()=>history.pushState({},'', '/detail');document.querySelector('#flash').onclick=()=>{const e=document.createElement('div');e.textContent='短暂提示内容';document.body.append(e);setTimeout(()=>e.remove(),100)};document.querySelector('#embed').onclick=()=>{const f=document.createElement('iframe');f.id='embedded';f.src='http://localhost:'+location.port+'/frame';document.body.append(f)};</script></body></html>`;
function archiveEvents(files) {
  const manifest = JSON.parse(strFromU8(files["manifest.json"]));
  return (
    manifest.version === 1 ? ["timeline/events.jsonl"] : manifest.eventChunks
  ).flatMap((path) =>
    strFromU8(files[path]).split("\n").filter(Boolean).map(JSON.parse),
  );
}
function timed(promise, label, milliseconds = 20000) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label}超时`)), milliseconds);
    }),
  ]).finally(() => clearTimeout(timer));
}
let probeCount = 0;
let imageVersion = 0;
let initialImageRequests = 0;
let initialStyleRequests = 0;
let fontRequests = 0;
const testFont = Buffer.from("d09GMgABAAAAAAEoAAoAAAAAAnwAAADfAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAABmAANAocOAE2AiQDBgsGAAQgBWkHJhvaAQAuDszzms60hZtiY5R08Sme/+8w75s/W3pKtQ4azVnweBeLBiGCK5wOEt5vKtflev0uxydJSim2LMi7b5ADHsj5D4yjk+OIEoz9WxJpHBDGcV6AEeY8fHsiIrF3ZhdV/eXowAHdjsEal23UmQ0A4Aw0FA6U4EB3hq4L1ltsswBooCMojAEdkJq99nJaUAeC8K6L+9X+x6k/+D3+g7kXUG8FpYEwhfzDpkgAuhYJmhLQAADQ3QiIKQKakamSPhEHdr03S9ebN1yo6d+oHxAjFUfuhPOokL5mFhJk7AoAAAA=", "base64");
const server = http.createServer((req, res) => {
  if (req.url.startsWith("/probe")) {
    probeCount++;
    res.end("probe");
  } else if (req.url === "/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
    });
    res.write(
      'id: event-1\nevent: update\ndata: {"order":"推送订单","token":"hidden-value-sse"}\n\n',
    );
    res.write("id: event-2\ndata: session_id=hidden-value-stream order=ok\n\n");
  } else if (req.url === "/test-font.woff2") {
    fontRequests++;
    res.setHeader("Content-Type", "font/woff2");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "no-store");
    res.end(testFont);
  } else if (req.url === "/local-font.css") {
    res.setHeader("Content-Type", "text/css");
    res.end('@font-face{font-family:LocalTest;src:url("./test-font.woff2")} #local-font{font-family:LocalTest}');
  } else if (req.url === "/style-initial.css" || req.url === "/style-later.css") {
    if (req.url === "/style-initial.css") {
      initialStyleRequests++;
    }
    res.setHeader("Content-Type", "text/css; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.end(req.url === "/style-initial.css" ? "#css-before{color:rgb(44,55,66)}" : '@font-face{font-family:LogicTest;src:url("/test-font.woff2")} #css-later{color:rgb(77,88,99);font-family:LogicTest}');
  } else if (req.url === "/redirect-image") {
    res.writeHead(302, {
      Location: "/test-image.png",
      "Cache-Control": "no-store",
    });
    res.end();
  } else if (
    [
      "/test-image.png",
      "/instant-a.png",
      "/instant-b.png",
      "/initial-image.png",
    ].includes(req.url)
  ) {
    if (req.url === "/initial-image.png") initialImageRequests++;
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "no-store");
    res.end(
      Buffer.concat([
        Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
          "base64",
        ),
        Buffer.from(String(++imageVersion)),
      ]),
    );
  } else if (req.url === "/sensitive-text") {
    res.setHeader("Content-Type", "text/plain");
    res.end("otp=hidden-value-network");
  } else if (req.url === "/api/redirect") {
    res.writeHead(302, {
      Location: "/api/customers?redirected=1&token=hidden-value-redirect",
    });
    res.end();
  } else if (["/api/large-post", "/api/too-large"].includes(req.url)) {
    req.resume();
    req.on("end", () => {
      res.setHeader("Content-Type", "application/json");
      res.end('{"ok":true}');
    });
  } else if (req.url.startsWith("/api/mixed")) {
    req.resume();
    req.on("end", () => {
      if (req.url.endsWith("kind=text")) {
        res.setHeader("Content-Type", "text/plain");
        res.end("完成");
      } else {
        res.setHeader("Content-Type", "application/json");
        res.end(
          req.url.endsWith("kind=first") ? '{"order":"A"}' : '{"total":2}',
        );
      }
    });
  } else if (req.url.startsWith("/api/")) {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ name: "测试客户", token: "hidden-value" }));
  } else if (req.url.startsWith("/report.csv")) {
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", 'attachment; filename="report.csv"');
    res.end("name\nexample\n");
  } else {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    if (req.url === "/")
      res.setHeader("Set-Cookie", [
        "theme=light; Path=/",
        "session_id=hidden-value-cookie; Path=/; HttpOnly",
      ]);
    res.end(
      html.replace("<title>录制测试</title>", `<title>录制测试</title><style>#css-before{color:rgb(1,2,3)}</style><link rel="stylesheet" href="http://localhost:${server.address().port}/style-initial.css">`).replace(
        "</body></html>",
        `<label><input id="optin" type="checkbox">确认</label><label><input id="mode-a" type="radio" name="mode" checked>方案 A</label><label><input id="mode-b" type="radio" name="mode">方案 B</label><select id="multi" multiple><option value="a">A1</option><option value="b">B</option><option value="a">A2</option></select><span id="css-before">初始样式</span><span id="css-later">后续样式</span><img id="initial-image" src="/initial-image.png"><img id="initial-cross-image" src="http://localhost:${server.address().port}/test-image.png"><div id="initial-background" style="width:20px;height:20px;background-image:url('/initial-image.png')"></div></body></html>`,
      ),
    );
  }
});
const sockets = new WebSocketServer({ server });
sockets.on("connection", (socket) => {
  socket.on("message", (data, binary) => socket.send(data, { binary }));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
const root = await fs.mkdtemp(path.resolve("test-extension-"));
await fs.cp(path.resolve("dist"), root, { recursive: true });
const manifestPath = path.join(root, "manifest.json");
const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
manifest.host_permissions = ["http://*/*", "https://*/*"];
await fs.writeFile(manifestPath, JSON.stringify(manifest));
const profile = await fs.mkdtemp(path.resolve("test-profile-"));
const browserOptions = {
  executablePath:
    process.env.CHROME_BIN || chromium.executablePath(),
  headless: true,
  viewport: null,
  acceptDownloads: true,
  downloadsPath: path.join(profile, "downloads"),
  args: [
    "--window-size=1280,900",
    "--site-per-process",
    `--disable-extensions-except=${root}`,
    `--load-extension=${root}`,
  ],
};
let context;
try {
  context = await chromium.launchPersistentContext(profile, browserOptions);
  context.setDefaultTimeout(15000);
  let worker = context.serviceWorkers()[0];
  if (!worker)
    worker = await context.waitForEvent("serviceworker", { timeout: 15000 });
  const id = new URL(worker.url()).host;
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open("business", 1);
      req.onupgradeneeded = () => req.result.createObjectStore("customers");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    await new Promise((resolve, reject) => {
      const tx = db.transaction("customers", "readwrite");
      tx.objectStore("customers").put(
        { name: "测试客户", token: "db-hidden-value" },
        "1",
      );
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    await caches.open("business-cache");
  });
  const closedShadowRects = await page.evaluate(() => {
    const fields = [];
    globalThis.__shadowTest = [];
    for (const nested of [false, true]) {
      const host = document.createElement("div");
      document.body.insertBefore(host, document.querySelector("#initial-background"));
      const outer = nested ? host.attachShadow({ mode: "open" }) : null;
      const closedHost = nested ? document.createElement("div") : host;
      if (outer) outer.append(closedHost);
      const root = closedHost.attachShadow({ mode: "closed" });
      const slot = document.createElement("slot");
      slot.name = "caption";
      const caption = document.createElement("span");
      caption.slot = "caption";
      caption.textContent = nested ? "嵌套组件标题" : "组件标题";
      closedHost.append(caption);
      root.append(slot);
      const sheet = new CSSStyleSheet();
      sheet.replaceSync("button { color: rgb(17, 34, 51) }");
      root.adoptedStyleSheets = [sheet];
      const inertTemplate = document.createElement("template");
      inertTemplate.innerHTML = '<input type="password" value="hidden-value-shadow-template"><textarea name="token">hidden-value-shadow-text</textarea>';
      root.append(inertTemplate);
      const field = document.createElement("input");
      field.type = "password";
      field.value = "shadow-hidden-value";
      field.style.cssText = "background:rgb(255,0,0);width:160px;height:24px";
      root.append(field);
      const customer = document.createElement("input");
      customer.setAttribute("aria-label", nested ? "嵌套组件客户" : "组件客户");
      const button = document.createElement("button");
      button.textContent = nested ? "嵌套组件查询" : "组件查询";
      if (!nested) button.addEventListener("click", () => {
        const notice = document.createElement("div");
        notice.textContent = "组件瞬时提示";
        root.append(notice);
        setTimeout(() => notice.remove(), 100);
      });
      const choice = document.createElement("select");
      choice.setAttribute("aria-label", nested ? "嵌套组件选项" : "组件选项");
      choice.innerHTML = '<option value="a">A</option><option value="b">B</option>';
      const scroller = document.createElement("div");
      scroller.setAttribute("data-testid", nested ? "nested-shadow-scroll" : "shadow-scroll");
      scroller.style.cssText = "height:40px;width:120px;overflow:auto";
      scroller.innerHTML = '<div style="height:300px">组件滚动内容</div>';
      root.append(customer, button, choice, scroller);
      scroller.scrollTop = 45;
      globalThis.__shadowTest.push({ field, customer, button, choice });
      const { x, y, width, height } = field.getBoundingClientRect();
      fields.push({ x, y, width, height });
    }
    const documentTemplate = document.createElement("template");
    documentTemplate.innerHTML = '<input type="password" value="hidden-value-document-template">';
    document.body.append(documentTemplate);
    const rich = document.createElement("div");
    rich.id = "rich-editor";
    rich.contentEditable = "true";
    rich.innerHTML = "<span>星级</span><strong>会员</strong>";
    document.body.append(rich);
    return fields;
  });
  const panel = await context.newPage();
  await panel.setViewportSize({ width: 360, height: 780 });
  await panel.goto(`chrome-extension://${id}/sidepanel.html`);
  await fs.mkdir(path.resolve("test-artifacts"), { recursive: true });
  await panel.screenshot({
    path: path.resolve("test-artifacts/sidepanel.png"),
  });
  await panel.getByLabel("录制范围").selectOption("browser");
  await panel.getByLabel("保存非认证 Cookie 值（可能含敏感信息）").check();
  await panel.getByText("我有权记录所有打开的网页").click();
  await page.bringToFront();
  await panel.waitForTimeout(2200);
  const passwordRect = await page.locator("#password").boundingBox();
  const sensitiveTextRect = await page.locator("#sensitive-text").boundingBox();
  const [tab] = await worker.evaluate(async () =>
    chrome.tabs.query({ url: "http://127.0.0.1/*" }),
  );
  const imageRequestsBeforeStart = initialImageRequests;
  const styleRequestsBeforeStart = initialStyleRequests;
  await panel.getByRole("button", { name: "开始录制" }).click();
  await panel
    .getByText("录制中", { exact: true })
    .first()
    .waitFor({ timeout: 10000 });
  const result = await panel.evaluate(() =>
    chrome.runtime.sendMessage({ type: "GET_STATE" }),
  );
  if (!result.ok) throw new Error("录制启动失败");
  if (initialImageRequests !== imageRequestsBeforeStart)
    throw new Error("初始图片读取不应重新请求网站");
  if (initialStyleRequests !== styleRequestsBeforeStart)
    throw new Error("初始样式读取不应重新请求网站");
  console.log("录制已启动");
  await page.evaluate(() => {
    for (const [id, top] of [["scroll-one", 40], ["scroll-two", 75]]) {
      const node = document.createElement("div");
      node.id = id;
      node.style.cssText = "height:40px;width:120px;overflow:auto";
      node.innerHTML = '<div style="height:300px">滚动内容</div>';
      document.body.append(node);
      node.scrollTop = top;
      node.dispatchEvent(new Event("scroll"));
    }
  });
  await page.waitForTimeout(350);
  await page.waitForTimeout(1000);
  await page.evaluate(async () => {
    const style = document.createElement("style");
    style.setAttribute("data-logic-fonts", "FORGED-FONT-METADATA");
    style.textContent = '@font-face{font-family:InlineTest;src:url("/test-font.woff2")} #inline-font{font-family:InlineTest}';
    document.head.append(style);
    const adopted = new CSSStyleSheet();
    adopted.replaceSync('@font-face{font-family:AdoptedTest;src:url("/test-font.woff2")} #adopted-font{font-family:AdoptedTest}');
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, adopted];
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "/local-font.css";
    await new Promise((resolve, reject) => { link.onload = resolve; link.onerror = reject; document.head.append(link); });
    for (const id of ["inline-font", "adopted-font", "local-font"]) {
      const element = document.createElement("span");
      element.id = id;
      element.textContent = "AAA";
      document.body.append(element);
    }
    await document.fonts.ready;
  });
  await page.evaluate((port) => new Promise((resolve, reject) => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = `http://localhost:${port}/style-later.css`;
    link.onload = resolve;
    link.onerror = reject;
    document.head.append(link);
  }), port);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(700);
  for (const [index, name] of [[0, "客户甲"], [1, "客户乙"]]) {
    await page.evaluate((index) => globalThis.__shadowTest[index].customer.focus(), index);
    await page.keyboard.insertText(name);
    await page.evaluate((index) => globalThis.__shadowTest[index].button.click(), index);
    await page.evaluate((index) => {
      const choice = globalThis.__shadowTest[index].choice;
      choice.value = "b";
      choice.dispatchEvent(new Event("change", { bubbles: true }));
    }, index);
  }
  await page.evaluate(() => globalThis.__shadowTest[0].field.focus());
  await page.keyboard.insertText("shadow-private-value");
  await page.evaluate(() => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = host.attachShadow({ mode: "closed" });
    const button = document.createElement("button");
    button.textContent = "动态组件操作";
    root.append(button);
    button.click();
    const openHost = document.createElement("div");
    document.body.append(openHost);
    const openRoot = openHost.attachShadow({ mode: "open" });
    const openButton = document.createElement("button");
    openButton.textContent = "开放组件操作";
    openRoot.append(openButton);
    openButton.click();
  });
  await page.evaluate(() => {
    const editor = document.querySelector("#rich-editor");
    const text = editor.querySelector("strong").firstChild;
    editor.focus();
    const range = document.createRange();
    range.setStart(text, text.length);
    range.collapse(true);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await page.keyboard.insertText("等级");
  await page.evaluate(() => {
    const editor = document.querySelector("#rich-editor");
    const strong = editor.querySelector("strong");
    const emphasis = document.createElement("em");
    emphasis.textContent = strong.textContent;
    strong.replaceChildren(emphasis);
    editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "formatItalic" }));
  });
  await timed(
    page.evaluate(
      () =>
        new Promise((resolve, reject) => {
          const source = new EventSource("/events");
          let received = 0;
          const done = () => {
            if (++received === 2) {
              source.close();
              resolve();
            }
          };
          source.onerror = () => {
            source.close();
            reject(new Error("事件流连接失败"));
          };
          source.addEventListener("update", done);
          source.onmessage = done;
        }),
    ),
    "服务器推送收取",
  );
  await timed(
    page.evaluate(
      (port) =>
        new Promise((resolve, reject) => {
          const socket = new WebSocket(`ws://127.0.0.1:${port}/socket`);
          let received = 0;
          socket.onerror = () => reject(new Error("WebSocket 连接失败"));
          socket.onopen = () => {
            socket.send("业务消息");
            socket.send(
              JSON.stringify({ order: "订单A", token: "hidden-value-socket" }),
            );
            socket.send(
              "session_id=hidden-value-session api_key=hidden-value-api order=ok",
            );
            socket.send(new Uint8Array([1, 2, 3]));
          };
          socket.onmessage = () => {
            if (++received === 4) socket.close();
          };
          socket.onclose = () =>
            received === 4
              ? resolve()
              : reject(new Error("WebSocket 提前关闭"));
        }),
      port,
    ),
    "实时消息收发",
  );
  await page.locator("#search").fill("张三");
  await page.evaluate(() => {
    document.cookie = "theme=dark; path=/";
    localStorage.setItem("plain-business", "card_number=hidden-value-storage");
    const element = document.createElement("span");
    element.textContent = "otp=hidden-value-page";
    document.body.append(element);
  });
  await page.evaluate(() => fetch("/sensitive-text").then((res) => res.text()));
  await page.evaluate(() => fetch("/api/redirect").then((res) => res.json()));
  await page.evaluate(() =>
    fetch("/api/large-post", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        note: "r".repeat(90000),
        token: "hidden-value-large-post",
      }),
    }).then((res) => res.json()),
  );
  await page.evaluate(() =>
    fetch("/api/too-large", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ note: "x".repeat(1000001) }),
    }).then((res) => res.json()),
  );
  await page.evaluate(async () => {
    await fetch("/api/mixed?kind=first", {
      method: "POST",
      body: new URLSearchParams([
        ["name", "客户"],
        ["tag", "a"],
        ["tag", "b"],
        ["token", "hidden-value-form"],
      ]),
    });
    await fetch("/api/mixed?kind=second", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ count: 2 }),
    });
    await fetch("/api/mixed?kind=text", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "提交",
    });
  });
  await page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const image = document.createElement("img");
        image.id = "redirected-image";
        image.onload = resolve;
        image.onerror = reject;
        image.src = "/redirect-image";
        document.body.append(image);
      }),
  );
  await page.evaluate(() => {
    document.body.dataset.phase = "image-phase-one";
  });
  await page.waitForTimeout(1500);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const image = document.createElement("img");
        image.id = "redirected-image";
        image.onload = resolve;
        image.onerror = reject;
        image.src = "/redirect-image";
        document.body.append(image);
      }),
  );
  await page.evaluate(() => {
    document.body.dataset.phase = "image-phase-two";
  });
  await page.waitForTimeout(1500);
  await page.evaluate(async () => {
    const image = document.createElement("img");
    image.id = "instant-image";
    image.src = "/instant-a.png#section";
    document.body.append(image);
    await image.decode();
    await new Promise((resolve) => setTimeout(resolve, 200));
    image.src = "/instant-b.png";
    await image.decode();
    await new Promise((resolve) => setTimeout(resolve, 200));
    image.removeAttribute("src");
  });
  await page.waitForTimeout(700);
  await page.locator("#optin").check();
  await page.locator("#mode-b").check();
  await page.locator("#multi").selectOption([{ index: 0 }, { index: 2 }]);
  await page.locator("#optin").uncheck();
  await page.evaluate(() => {
    const select = document.createElement("select");
    select.id = "many-options";
    select.multiple = true;
    for (let index = 0; index < 201; index++) {
      const option = document.createElement("option");
      option.value = String(index);
      option.textContent = `项目 ${index}`;
      option.selected = true;
      select.append(option);
    }
    document.body.append(select);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await page.locator("#file").setInputFiles({
    name: "测试文件.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("sample"),
  });
  page.once("dialog", (dialog) => dialog.accept());
  await Promise.race([
    page.evaluate(() => alert("测试提示")),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("页面对话框测试超时")), 10000),
    ),
  ]);
  console.log("文件和弹窗已测试");
  const siteDownload = page.waitForEvent("download", { timeout: 10000 });
  await page.locator("#download").click();
  const downloadedSiteFile = await siteDownload;
  if (await timed(downloadedSiteFile.failure(), "站点下载完成"))
    throw new Error("站点下载失败");
  console.log("站点下载已测试");
  await page.locator("#find").click();
  await page.getByText("测试客户").waitFor();
  await page.evaluate(() =>
    localStorage.setItem(
      "business",
      JSON.stringify({ name: "业务", token: "storage-hidden-value" }),
    ),
  );
  await page.locator("#route").click();
  await page.waitForTimeout(1800);
  await page.locator("#flash").click();
  await page.waitForTimeout(250);
  console.log("主页面操作已测试");
  await page.locator("#embed").click();
  const embedded = page.frameLocator("#embedded");
  await embedded.locator("#search").fill("嵌入页面");
  const embeddedPasswordRect = await embedded
    .locator("#password")
    .boundingBox();
  await page.waitForTimeout(700);
  await embedded.locator("#find").click();
  await embedded.getByText("测试客户").waitFor();
  await page.waitForTimeout(1200);
  console.log("嵌入页面已测试");
  const childReady = context.waitForEvent("page", { timeout: 15000 });
  await page.evaluate(
    (port) => window.open(`http://localhost:${port}/child`, "_blank"),
    port,
  );
  const child = await childReady;
  await child.waitForLoadState("domcontentloaded");
  await child.locator("#search").fill("第二页");
  await child.locator("#find").click();
  await child.getByText("测试客户").waitFor();
  await child.waitForTimeout(1800);
  await child.locator("#route").click();
  await child.waitForTimeout(1600);
  const closedTab = await worker.evaluate(
    async () => (await chrome.tabs.query({ url: "http://localhost/*" }))[0]?.id,
  );
  await child.close();
  await page.bringToFront();
  console.log("跨站标签已测试");
  await page.evaluate(() => {
    const node = document.createElement("div");
    node.id = "scroll-final";
    node.style.cssText = "height:40px;width:120px;overflow:auto";
    node.innerHTML = '<div style="height:300px">滚动内容</div>';
    document.body.append(node);
    node.scrollTop = 95;
    node.dispatchEvent(new Event("scroll"));
  });
  await panel.getByRole("button", { name: "停止录制" }).click();
  await panel
    .getByRole("heading", { name: "准备开始" })
    .waitFor({ timeout: 15000 });
  console.log("录制已停止");
  const state = await panel.evaluate(() =>
    chrome.runtime.sendMessage({ type: "GET_STATE" }),
  );
  if (!state.value.sessions.some((s) => s.status === "ready"))
    throw new Error("录制任务没有完成");
  if (!state.value.sessions.find((s) => s.id === result.value.active.id)?.coverage?.initialResourceGaps)
    throw new Error("初始资源缺失未计入录制状态");
  await panel.reload();
  const downloadPromise = panel.waitForEvent("download", { timeout: 15000 });
  await panel.getByTitle("下载记录包").first().click();
  const download = await downloadPromise;
  const output = path.join(profile, "test-output.zip");
  await download.saveAs(output);
  console.log("记录包已下载");
  const files = unzipSync(await fs.readFile(output));
  const events = archiveEvents(files);
  for (const [name, label] of [["客户甲", "组件客户"], ["客户乙", "嵌套组件客户"]]) {
    const matching = events.filter((event) => event.kind === "interaction.input" && event.payload.value === name && event.payload.target?.name === label);
    if (matching.length !== 1 || !Array.isArray(matching[0].payload.target.shadowPath) || matching[0].payload.target.selector !== null)
      throw new Error(`组件输入未正确记录或重复记录：${label} ${JSON.stringify(events.filter((event) => event.kind === "interaction.input").map((event) => ({ value: event.payload.value, target: event.payload.target })))}`);
  }
  for (const label of ["组件查询", "嵌套组件查询", "动态组件操作", "开放组件操作"]) {
    const matching = events.filter((event) => event.kind === "interaction.click" && event.payload.target?.text === label);
    if (matching.length !== 1 || !Array.isArray(matching[0].payload.target.shadowPath))
      throw new Error(`组件点击未正确记录或重复记录：${label}`);
  }
  for (const label of ["组件选项", "嵌套组件选项"]) {
    const matching = events.filter((event) => event.kind === "interaction.change" && event.payload.target?.name === label);
    if (matching.length !== 1 || matching[0].payload.formState?.selectedIndices?.[0] !== 1 || !Array.isArray(matching[0].payload.target.shadowPath))
      throw new Error(`组件选择未正确记录或重复记录：${label}`);
  }
  if (JSON.stringify(events).includes("shadow-private-value"))
    throw new Error("组件内敏感输入未隐藏");
  const richInput = events.find((event) => event.kind === "interaction.input" && event.payload.target?.selector === "#rich-editor" && event.payload.value === "星级会员等级");
  const richMutation = events.find((event) => event.kind === "page.mutation" && event.payload.changes?.some((change) => change.type === "text" && change.value === "会员等级"));
  if (!richInput || !richMutation) throw new Error("富文本输入或结构变化未记录");
  const richStructural = events.find((event) => event.kind === "page.mutation" && event.payload.changes?.some((change) => change.added?.some((node) => node.tag === "em" && node.children?.some((child) => child.text === "会员等级"))));
  if (!richStructural) throw new Error("富文本结构性编辑未记录");
  const shadowToast = events.find((event) => event.kind === "page.mutation" && event.payload.changes?.some((change) => change.added?.some((node) => node.children?.some((child) => child.text === "组件瞬时提示"))));
  const toastNode = shadowToast?.payload.changes.flatMap((change) => change.added || []).find((node) => node.children?.some((child) => child.text === "组件瞬时提示"));
  const shadowToastRemoved = events.find((event) => event.kind === "page.mutation" && event.payload.changes?.some((change) => change.removed?.includes(toastNode?.id)));
  if (!shadowToast || !shadowToastRemoved) throw new Error("组件内短暂提示的出现或消失未记录");
  for (const [selector, top] of [
    ["#scroll-one", 40],
    ["#scroll-two", 75],
    ["#scroll-final", 95],
  ]) {
    if (
      !events.some(
        (event) =>
          event.kind === "interaction.scroll" &&
          event.payload.targetScope === "element" &&
          event.payload.target?.selector === selector &&
          event.payload.scrollTop === top,
      )
    )
      throw new Error(`滚动区域 ${selector} 的位置 ${top} 未记录`);
  }
  const scrollSnapshot = events.find(
    (event) =>
      event.kind === "page.snapshot" &&
      event.payload.html?.includes('id="scroll-one"') &&
      event.payload.scroll?.positions?.some((item) => item.top === 40) &&
      event.payload.scroll?.positions?.some((item) => item.top === 75),
  );
  if (!scrollSnapshot) throw new Error("页面快照未保存已有滚动位置");
  const initialImage = events.find(
    (event) =>
      event.kind === "resource.initial" &&
      event.tabId === tab.id &&
      event.payload.url.endsWith("/initial-image.png"),
  );
  if (initialImage && (initialImage.frameId !== 0 || !initialImage.documentId || initialImage.payload.documentId !== initialImage.documentId))
    throw new Error("初始图片未关联到实际页面实例");
  const initialSummary = events.find((event) => event.kind === "resource.initialSummary" && event.tabId === tab.id);
  if (initialSummary?.payload.status !== "partial" || initialSummary.payload.omitted < 1)
    throw new Error("无法读取的跨域初始图片未报告缺失");
  if (events.some((event) => event.kind === "resource.initial" && event.tabId === tab.id && event.payload.url.endsWith("/test-image.png")))
    throw new Error("不应绕过跨域限制读取初始图片");
  const laterStyleRequest = events.find((event) => event.kind === "network.request" && event.tabId === tab.id && event.payload.url.endsWith("/style-later.css"));
  const laterStyleFinished = events.find((event) => event.kind === "network.finished" && event.payload.requestId === laterStyleRequest?.payload.requestId && event.payload.body?.status === "captured_redacted_best_effort");
  const fontRequest = events.find((event) => event.kind === "network.request" && event.tabId === tab.id && event.payload.url.endsWith("/test-font.woff2"));
  const fontFinished = events.find((event) => event.kind === "network.finished" && event.payload.requestId === fontRequest?.payload.requestId && event.payload.body?.status === "captured_asset");
  if (!fontFinished || !files[`resources/${fontFinished.payload.assetId}.bin`]) throw new Error("录制期间加载的字体未保存");
  const laterStyleSnapshot = events.find((event) => event.kind === "page.snapshot" && event.tabId === tab.id && event.time >= Math.max(laterStyleFinished?.time || 0, fontFinished.time) && event.payload.html?.includes("/style-later.css") && event.payload.html?.includes("InlineTest"));
  if (!laterStyleFinished || !laterStyleSnapshot) throw new Error("录制期间的跨域样式未采集或未关联快照");
  if (!laterStyleSnapshot.payload.html.includes("data-logic-fonts") || laterStyleSnapshot.payload.html.includes("FORGED-FONT-METADATA"))
    throw new Error("可读样式的字体描述未保存或内部标记未清理");
  const fontRequestsAtPlayback = fontRequests;
  const initialPage = events.find(
    (event) =>
      event.kind === "page.snapshot" &&
      event.tabId === tab.id &&
      event.frameId === 0 &&
      event.payload.html?.includes('id="initial-image"') &&
      event.time >= initialImage?.time,
  );
  if (!initialImage?.payload.assetId || !initialPage)
    throw new Error("录制开始前的页面图片未保存");
  if ((initialPage.payload.shadow?.captured || 0) < 3)
    throw new Error("页面快照未保存开放和关闭式组件");
  const formEvent = (selector, predicate) =>
    events.find(
      (event) =>
        event.kind === "interaction.change" &&
        event.tabId === tab.id &&
        event.payload.target?.selector === selector &&
        predicate(event.payload.formState),
    );
  const checkedEvent = formEvent("#optin", (state) => state?.checked === true);
  const uncheckedEvent = formEvent(
    "#optin",
    (state) => state?.checked === false,
  );
  const radioEvent = formEvent("#mode-b", (state) => state?.checked === true);
  const multiEvent = formEvent(
    "#multi",
    (state) => JSON.stringify(state?.selectedIndices) === "[0,2]",
  );
  if (!checkedEvent || !uncheckedEvent || !radioEvent || !multiEvent)
    throw new Error("复选、单选或多选操作状态未记录");
  if (
    checkedEvent.payload.target.name !== "确认" ||
    radioEvent.payload.target.name !== "方案 B"
  )
    throw new Error("表单控件的可见标签未记录");
  if (
    multiEvent.payload.formState.options
      ?.map((option) => option.label)
      .join(",") !== "A1,B,A2"
  )
    throw new Error("多选控件的选项标签未记录");
  if (
    !formEvent(
      "#many-options",
      (state) => state?.truncated && state.selectedIndices.length === 200,
    )
  )
    throw new Error("过多选项未标记为不完整");
  const instantAdd = events.find(
    (event) =>
      event.kind === "page.mutation" &&
      event.tabId === tab.id &&
      event.payload.changes?.some((change) =>
        change.added?.some((item) => item.attrs?.id === "instant-image"),
      ),
  );
  const instantNode = instantAdd?.payload.changes
    .flatMap((change) => change.added || [])
    .find((item) => item.attrs?.id === "instant-image");
  const instantRemove = events.find(
    (event) =>
      event.kind === "page.mutation" &&
      event.tabId === tab.id &&
      event.payload.changes?.some(
        (change) =>
          change.id === instantNode?.id &&
          change.name === "src" &&
          change.value === null,
      ),
  );
  const imageFinish = (name) => {
    const request = events.find(
      (event) =>
        event.kind === "network.request" &&
        event.tabId === tab.id &&
        event.payload.url.endsWith(name),
    );
    return events.find(
      (event) =>
        event.kind === "network.finished" &&
        event.payload.requestId === request?.payload.requestId &&
        event.payload.assetId,
    );
  };
  const instantFirst = imageFinish("/instant-a.png"),
    instantSecond = imageFinish("/instant-b.png");
  if (
    !instantNode ||
    !instantRemove ||
    !instantFirst ||
    !instantSecond ||
    instantFirst.time > instantRemove.time ||
    instantSecond.time > instantRemove.time
  )
    throw new Error(
      `短暂图片变化的记录不完整：${JSON.stringify({ node: instantNode?.id, removal: instantRemove?.time, first: instantFirst?.time, second: instantSecond?.time })}`,
    );
  const largeRequest = events.find(
    (event) =>
      event.kind === "network.request" &&
      event.payload.url.endsWith("/api/large-post"),
  );
  const largeBody = events.find(
    (event) =>
      event.kind === "network.requestBody" &&
      event.payload.requestId === largeRequest?.payload.requestId,
  );
  if (
    largeRequest?.payload.postData?.status !== "pending" ||
    largeBody?.payload.body?.status !== "captured_redacted" ||
    JSON.parse(largeBody.payload.body.value).note.length !== 90000 ||
    JSON.parse(largeBody.payload.body.value).token !== "[已隐藏]"
  )
    throw new Error("较大请求体未正确补充或脱敏");
  const oversizedRequest = events.find(
    (event) =>
      event.kind === "network.request" &&
      event.payload.url.endsWith("/api/too-large"),
  );
  if (
    !events.some(
      (event) =>
        event.kind === "network.requestBody" &&
        event.payload.requestId === oversizedRequest?.payload.requestId &&
        event.payload.body?.status === "omitted_size",
    )
  )
    throw new Error("超出上限的请求体未标记");
  const pushes = events.filter(
    (event) => event.kind === "network.eventSourceMessage",
  );
  const pushConnection = events.find(
    (event) =>
      event.kind === "network.request" && event.payload.url.endsWith("/events"),
  );
  if (
    !pushConnection ||
    !pushes.some(
      (event) =>
        event.payload.requestId === pushConnection.payload.requestId &&
        event.payload.eventName === "update" &&
        event.payload.eventId === "event-1" &&
        event.payload.data?.value?.includes("推送订单"),
    ) ||
    !pushes.some(
      (event) =>
        event.payload.requestId === pushConnection.payload.requestId &&
        event.payload.eventId === "event-2" &&
        event.payload.data?.value?.includes("order=ok"),
    ) ||
    JSON.stringify(pushes).includes("hidden-value")
  )
    throw new Error("服务器推送消息或连接关联未正确记录");
  const canceledPush = events.some(
    (event) =>
      event.kind === "network.failed" &&
      event.payload.requestId === pushConnection.payload.requestId &&
      event.payload.canceled,
  );
  const frames = events.filter(
    (event) => event.kind === "network.websocketFrame",
  );
  for (const direction of ["sent", "received"]) {
    if (
      !frames.some(
        (event) =>
          event.payload.direction === direction &&
          event.payload.data?.value === "业务消息",
      ) ||
      !frames.some(
        (event) =>
          event.payload.direction === direction &&
          event.payload.data?.value?.includes("订单A") &&
          !event.payload.data.value.includes("hidden-value-socket"),
      ) ||
      !frames.some(
        (event) =>
          event.payload.direction === direction &&
          event.payload.data?.value?.includes("order=ok") &&
          !event.payload.data.value.includes("hidden-value"),
      ) ||
      !frames.some(
        (event) =>
          event.payload.direction === direction &&
          event.payload.opcode === 2 &&
          event.payload.data?.status === "omitted_binary",
      )
    )
      throw new Error(`实时消息${direction}记录不完整`);
  }
  if (
    !events.some(
      (event) =>
        event.kind === "page.lifecycle" &&
        event.tabId === tab.id &&
        event.payload.type === "pagehide",
    )
  )
    throw new Error("页面刷新时的离开事件未保存");
  if (
    !closedTab ||
    !events.some(
      (event) =>
        event.kind === "tab.closed" && event.payload.tabId === closedTab,
    )
  )
    throw new Error("已关闭标签页未被记录");
  if (
    events.some(
      (event) =>
        event.kind === "warning" &&
        event.payload.tabId === closedTab &&
        /结束时无法枚举页面框架|网络调试连接中断/.test(
          event.payload.message || "",
        ),
    )
  )
    throw new Error("正常关闭的标签页被错误标记为采集故障");
  const readyEvent = events.find((event) => event.kind === "session.ready");
  if (
    !readyEvent ||
    !events.some(
      (event) =>
        event.kind === "screenshot" &&
        event.payload.eventIds?.includes(readyEvent.id) &&
        event.payload.assetId,
    )
  )
    throw new Error("录制开始时的页面截图未成功保存");
  const routeClick = events.find(
    (event) =>
      event.kind === "interaction.click" &&
      event.tabId === tab.id &&
      event.payload.target?.selector === "#route",
  );
  if (
    !routeClick ||
    !events.some(
      (event) =>
        event.kind === "screenshot" &&
        event.payload.eventIds?.includes(routeClick.id) &&
        event.payload.assetId &&
        event.payload.contextChanged &&
        event.payload.url.endsWith("/detail"),
    )
  )
    throw new Error("操作后跳转的截图未正确标注页面变化");
  if (
    events.some(
      (event) =>
        event.kind === "page.mutation" &&
        JSON.stringify(event.payload).includes(
          "document.querySelector('#flash')",
        ),
    )
  )
    throw new Error("页面脚本内容不应作为页面变化记录");
  const redirectRequest = events.find(
    (event) =>
      event.kind === "network.request" &&
      event.payload.url.endsWith("/api/redirect"),
  );
  const redirectedRequest = events.find(
    (event) =>
      event.kind === "network.request" &&
      event.payload.redirectFrom === redirectRequest?.payload.requestId,
  );
  if (
    !redirectRequest ||
    !redirectedRequest ||
    !events.some(
      (event) =>
        event.kind === "network.response" &&
        event.payload.requestId === redirectRequest.payload.requestId &&
        event.payload.status === 302,
    ) ||
    !events.some(
      (event) =>
        event.kind === "network.response" &&
        event.payload.requestId === redirectedRequest.payload.requestId &&
        event.payload.status === 200,
    ) ||
    !events.some(
      (event) =>
        event.kind === "network.finished" &&
        event.payload.requestId === redirectedRequest.payload.requestId &&
        event.payload.body?.value?.includes("测试客户"),
    )
  )
    throw new Error("重定向前后请求及响应未完整关联");
  if (
    !events.some(
      (event) =>
        event.kind === "network.finished" &&
        event.payload.body?.value?.includes("otp="),
    )
  )
    throw new Error("未记录用于验证敏感文本的接口响应");
  for (const kind of [
    "interaction.input",
    "interaction.click",
    "page.snapshot",
    "page.mutation",
    "navigation.spa",
    "network.request",
    "network.response",
    "network.finished",
    "storage.snapshot",
    "database.snapshot",
    "cache.snapshot",
    "dialog.open",
    "dialog.closed",
    "download.started",
  ]) {
    if (!events.some((event) => event.kind === kind))
      throw new Error(`缺少事件：${kind}`);
  }
  if (
    !events.some(
      (event) => event.kind === "screenshot" && event.payload.assetId,
    )
  )
    throw new Error(
      "缺少成功的截图：" +
        JSON.stringify(
          events
            .filter((event) => event.kind === "screenshot")
            .map((event) => event.payload.reason),
        ),
    );
  const lastClick = events
    .filter((event) => event.kind === "interaction.click")
    .at(-1);
  if (
    !events.some(
      (event) =>
        event.kind === "screenshot" &&
        event.payload.assetId &&
        event.payload.eventIds.includes(lastClick.id),
    )
  )
    throw new Error("停止时最后一次点击的截图未完成");
  const shot = events.find(
    (event) =>
      event.kind === "screenshot" &&
      event.payload.assetId &&
      event.tabId === tab.id,
  );
  const image = files[`screenshots/${shot.payload.assetId}.jpg`];
  await fs.writeFile(path.resolve("test-artifacts/masked.jpg"), image);
  const pixel = await panel.evaluate(
    async ({ imageBytes, x, y }) => {
      const bitmap = await createImageBitmap(
        new Blob([new Uint8Array(imageBytes)], { type: "image/jpeg" }),
      );
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext("2d");
      ctx.drawImage(bitmap, 0, 0);
      return [...ctx.getImageData(x, y, 1, 1).data];
    },
    {
      imageBytes: [...image],
      x: Math.round(passwordRect.x + passwordRect.width / 2),
      y: Math.round(passwordRect.y + passwordRect.height / 2),
    },
  );
  if (pixel.slice(0, 3).some((v) => v > 12))
    throw new Error(`密码框截图未遮挡: ${pixel}`);
  const textPixel = await panel.evaluate(
    async ({ imageBytes, x, y }) => {
      const bitmap = await createImageBitmap(
        new Blob([new Uint8Array(imageBytes)], { type: "image/jpeg" }),
      );
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext("2d");
      ctx.drawImage(bitmap, 0, 0);
      return [...ctx.getImageData(x, y, 1, 1).data];
    },
    {
      imageBytes: [...image],
      x: Math.round(sensitiveTextRect.x + sensitiveTextRect.width / 2),
      y: Math.round(sensitiveTextRect.y + sensitiveTextRect.height / 2),
    },
  );
  if (textPixel.slice(0, 3).some((v) => v > 12))
    throw new Error(`敏感文本截图未遮挡: ${textPixel}`);
  for (const rect of closedShadowRects) {
    const shadowPixel = await panel.evaluate(
      async ({ imageBytes, x, y }) => {
        const bitmap = await createImageBitmap(new Blob([new Uint8Array(imageBytes)], { type: "image/jpeg" }));
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const ctx = canvas.getContext("2d");
        ctx.drawImage(bitmap, 0, 0);
        return [...ctx.getImageData(x, y, 1, 1).data];
      },
      { imageBytes: [...image], x: Math.round(rect.x + rect.width - 8), y: Math.round(rect.y + rect.height / 2) },
    );
    if (shadowPixel.slice(0, 3).some((v) => v > 12))
      throw new Error(`关闭式组件中的密码框截图未遮挡: ${shadowPixel}`);
  }
  if (
    !events.some((event) => event.kind === "tab.created") ||
    new Set(
      events
        .filter((event) => event.kind === "interaction.input")
        .map((event) => event.tabId),
    ).size < 2
  )
    throw new Error("新标签页操作未被记录");
  if (
    !events.some(
      (event) => event.kind === "interaction.input" && event.frameId > 0,
    )
  )
    throw new Error("嵌入页面操作未被记录");
  const frameActionIds = new Set(
    events
      .filter(
        (event) => event.kind.startsWith("interaction.") && event.frameId > 0,
      )
      .map((event) => event.id),
  );
  const frameShot = events.find(
    (event) =>
      event.kind === "screenshot" &&
      event.payload.assetId &&
      event.payload.eventIds.some((id) => frameActionIds.has(id)),
  );
  if (!frameShot)
    throw new Error(
      "嵌入页面截图未能安全采集：" +
        JSON.stringify(
          events
            .filter((event) => event.kind === "screenshot")
            .map((event) => event.payload.reason),
        ),
    );
  const frameImage = files[`screenshots/${frameShot.payload.assetId}.jpg`];
  const framePixel = await panel.evaluate(
    async ({ imageBytes, x, y }) => {
      const bitmap = await createImageBitmap(
        new Blob([new Uint8Array(imageBytes)], { type: "image/jpeg" }),
      );
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext("2d");
      ctx.drawImage(bitmap, 0, 0);
      return [...ctx.getImageData(x, y, 1, 1).data];
    },
    {
      imageBytes: [...frameImage],
      x: Math.round(embeddedPasswordRect.x + embeddedPasswordRect.width / 2),
      y: Math.round(embeddedPasswordRect.y + embeddedPasswordRect.height / 2),
    },
  );
  if (framePixel.slice(0, 3).some((v) => v > 12))
    throw new Error(`嵌入页面密码框未遮挡: ${framePixel}`);
  if (
    !events.some(
      (event) =>
        event.kind === "network.request" && event.payload.protocolSessionId,
    )
  )
    throw new Error("跨进程嵌入页面网络未被记录");
  if (JSON.stringify(events).includes("hidden-value"))
    throw new Error("敏感值未隐藏");
  const initialCookies = events
    .filter((event) => event.kind === "cookie.initial")
    .flatMap((event) => event.payload.items || []);
  if (
    !initialCookies.some(
      (cookie) => cookie.name === "theme" && cookie.value === "light",
    ) ||
    !initialCookies.some(
      (cookie) => cookie.name === "session_id" && cookie.value === "[已隐藏]",
    )
  )
    throw new Error("Cookie 初始值或敏感字段处理不正确");
  if (
    !events.some(
      (event) =>
        event.kind === "cookie.change" &&
        event.payload.name === "theme" &&
        event.payload.value === "dark",
    )
  )
    throw new Error("Cookie 变化未记录");
  if (
    !events.some(
      (event) =>
        event.kind === "interaction.change" &&
        event.payload.files?.some((file) => file.name === "测试文件.txt"),
    )
  )
    throw new Error("文件选择元数据未采集");
  if (
    !events.some(
      (event) =>
        event.kind === "database.snapshot" &&
        event.payload.database?.stores?.some((store) =>
          store.records?.some((row) => row.value?.name === "测试客户"),
        ),
    )
  )
    throw new Error("数据库业务记录未采集");
  await panel.getByRole("button", { name: "导入记录包" }).click();
  await panel.locator("input[type=file]").first().setInputFiles(output);
  await panel
    .getByRole("heading", { name: "录制测试" })
    .waitFor({ timeout: 10000 });
  console.log("记录包已导入");
  await panel.getByPlaceholder("搜索记录").fill(scrollSnapshot.id);
  await panel.locator(".timeline-item").first().click();
  await panel.waitForFunction(() => {
    const doc = document.querySelector('iframe[title="页面快照"]')?.contentDocument;
    return doc?.querySelector("#scroll-one")?.scrollTop === 40 &&
      doc?.querySelector("#scroll-two")?.scrollTop === 75;
  });
  await panel.getByPlaceholder("搜索记录").fill(initialPage.id);
  await panel.locator(".timeline-item").first().click();
  const initialRestored = panel
    .frameLocator('iframe[title="页面快照"]')
    .locator("#initial-image");
  await initialRestored.waitFor({ state: "attached" });
  const initialExpected = `data:image/png;base64,${Buffer.from(files[`resources/${initialImage.payload.assetId}.bin`]).toString("base64")}`;
  if ((await initialRestored.getAttribute("src")) !== initialExpected)
    throw new Error("录制前已有图片未在初始页面快照还原");
  const background = await panel
    .frameLocator('iframe[title="页面快照"]')
    .locator("#initial-background")
    .evaluate((element) => getComputedStyle(element).backgroundImage);
  if (!background.includes(initialExpected))
    throw new Error("页面背景图片未在快照中还原");
  if ((await panel.frameLocator('iframe[title="页面快照"]').locator("#css-before").evaluate((element) => getComputedStyle(element).color)) !== "rgb(1, 2, 3)")
    throw new Error("无法取得的初始跨域样式不应被伪造");
  await panel.getByText(/外部样式未取得：1 个/).waitFor();
  await panel.getByPlaceholder("搜索记录").fill(laterStyleSnapshot.id);
  await panel.locator(".timeline-item").first().click();
  await panel.waitForFunction(() => {
    const frame = document.querySelector('iframe[title="页面快照"]');
    const element = frame?.contentDocument?.querySelector("#css-later");
    return element && frame.contentWindow.getComputedStyle(element).color === "rgb(77, 88, 99)";
  });
  await panel.waitForFunction(() => {
    const fonts = document.querySelector('iframe[title="页面快照"]')?.contentDocument?.fonts;
    return fonts && ["LogicTest", "InlineTest", "AdoptedTest", "LocalTest"].every((name) => [...fonts].some((font) => font.family === name && font.status === "loaded"));
  });
  if (fontRequests !== fontRequestsAtPlayback) throw new Error("侧边栏回看时不应重新请求字体");
  await panel.getByPlaceholder("搜索记录").fill(initialPage.id);
  await panel.locator(".timeline-item").first().click();
  const shadowFrame = panel.frameLocator('iframe[title="页面快照"]');
  await shadowFrame.getByRole("button", { name: "嵌套组件查询" }).waitFor({ state: "attached" });
  if ((await shadowFrame.getByRole("button", { name: "组件查询", exact: true }).evaluate((element) => getComputedStyle(element).color)) !== "rgb(17, 34, 51)")
    throw new Error("组件的构造样式未还原");
  if ((await shadowFrame.getByText("组件标题", { exact: true }).evaluate((element) => element.assignedSlot?.name)) !== "caption")
    throw new Error("组件插槽未还原");
  await panel.waitForFunction(() => {
    const doc = document.querySelector('iframe[title="页面快照"]')?.contentDocument;
    const roots = doc ? [doc] : [];
    for (let i = 0; i < roots.length; i++)
      for (const element of roots[i].querySelectorAll("*")) {
        if (element.getAttribute("data-testid") === "shadow-scroll" && element.scrollTop === 45) return true;
        if (element.shadowRoot) roots.push(element.shadowRoot);
      }
    return false;
  });
  if ((await shadowFrame.getByLabel("组件客户", { exact: true }).inputValue()) !== "")
    throw new Error("组件初始输入状态未还原");
  await panel.getByPlaceholder("搜索记录").fill(shadowToast.id);
  await panel.locator(".timeline-item").first().click();
  await shadowFrame.getByText("组件瞬时提示", { exact: true }).waitFor({ state: "attached" });
  await panel.getByPlaceholder("搜索记录").fill(shadowToastRemoved.id);
  await panel.locator(".timeline-item").first().click();
  await shadowFrame.getByRole("button", { name: "组件查询", exact: true }).waitFor({ state: "attached" });
  if (await shadowFrame.getByText("组件瞬时提示", { exact: true }).count())
    throw new Error("组件内已消失的提示仍然显示");
  const shadowInput = events.find((event) => event.kind === "interaction.input" && event.payload.value === "客户甲");
  await panel.getByPlaceholder("搜索记录").fill(shadowInput.id);
  await panel.locator(".timeline-item").first().click();
  try {
    await panel.waitForFunction(() => {
      const doc = document.querySelector('iframe[title="页面快照"]')?.contentDocument;
      const roots = doc ? [doc] : [];
      for (let i = 0; i < roots.length; i++)
        for (const element of roots[i].querySelectorAll("*")) {
          if (element.getAttribute("aria-label") === "组件客户" && element.value === "客户甲") return true;
          if (element.shadowRoot) roots.push(element.shadowRoot);
        }
      return false;
    }, null, { timeout: 5000 });
  } catch {
    throw new Error(`组件输入状态未按事件还原：${JSON.stringify(shadowInput.payload.target)}`);
  }
  const shadowChoice = events.find((event) => event.kind === "interaction.change" && event.payload.target?.name === "组件选项");
  await panel.getByPlaceholder("搜索记录").fill(shadowChoice.id);
  await panel.locator(".timeline-item").first().click();
  await panel.waitForFunction(() => {
    const doc = document.querySelector('iframe[title="页面快照"]')?.contentDocument;
    const roots = doc ? [doc] : [];
    for (let i = 0; i < roots.length; i++)
      for (const element of roots[i].querySelectorAll("*")) {
        if (element.getAttribute("aria-label") === "组件选项" && element.value === "b") return true;
        if (element.shadowRoot) roots.push(element.shadowRoot);
      }
    return false;
  });
  await panel.getByPlaceholder("搜索记录").fill(richMutation.id);
  await panel.locator(".timeline-item").first().click();
  const restoredRich = shadowFrame.locator("#rich-editor");
  await restoredRich.locator("strong").waitFor({ state: "attached" });
  if ((await restoredRich.locator("span").textContent()) !== "星级" || (await restoredRich.locator("strong").textContent()) !== "会员等级")
    throw new Error("富文本输入后的格式未还原");
  if (await panel.getByText("复杂富文本仅按文本还原").count())
    throw new Error("已有完整变化的富文本被错误降级");
  await panel.getByPlaceholder("搜索记录").fill(richStructural.id);
  await panel.locator(".timeline-item").first().click();
  await shadowFrame.locator("#rich-editor strong em").waitFor({ state: "attached" });
  if ((await shadowFrame.locator("#rich-editor strong em").textContent()) !== "会员等级")
    throw new Error("富文本结构性编辑未正确还原");
  await panel.getByRole("button", { name: "报告", exact: true }).click();
  await panel.getByText(/组件内部的快照间变化可能不完整/).first().waitFor();
  await panel
    .locator(".catalog-row")
    .filter({ hasText: "选项数量超过采集上限" })
    .first()
    .waitFor();
  await panel.getByRole("button", { name: "时间线", exact: true }).click();
  const frameForForm = panel.frameLocator('iframe[title="页面快照"]');
  for (const [event, expected] of [
    [checkedEvent, true],
    [uncheckedEvent, false],
  ]) {
    await panel.getByPlaceholder("搜索记录").fill(event.id);
    await panel.locator(".timeline-item").first().click();
    if ((await frameForForm.locator("#optin").isChecked()) !== expected)
      throw new Error("复选框状态未按时间还原");
    if (expected) {
      await panel.getByRole("button", { name: "从此操作复现" }).click();
      await panel.getByLabel("复现勾选").click();
      await panel.getByRole("button", { name: "时间线", exact: true }).click();
    }
  }
  await panel.getByPlaceholder("搜索记录").fill(radioEvent.id);
  await panel.locator(".timeline-item").first().click();
  if (
    (await frameForForm.locator("#mode-a").isChecked()) ||
    !(await frameForForm.locator("#mode-b").isChecked())
  )
    throw new Error("单选框组状态未正确还原");
  await panel.getByPlaceholder("搜索记录").fill(multiEvent.id);
  await panel.locator(".timeline-item").first().click();
  await frameForForm.locator("#multi option").first().waitFor({ state: "attached" });
  const selection = await frameForForm
    .locator("#multi option")
    .evaluateAll((options) => options.map((option) => option.selected));
  if (JSON.stringify(selection) !== "[true,false,true]")
    throw new Error(`多选框状态未正确还原：${JSON.stringify(selection)}`);
  for (const event of [instantFirst, instantSecond]) {
    await panel.getByPlaceholder("搜索记录").fill(event.id);
    await panel.locator(".timeline-item").first().click();
    const image = panel
      .frameLocator('iframe[title="页面快照"]')
      .locator("#instant-image");
    await image.waitFor({ state: "attached" });
    const expected = `data:image/png;base64,${Buffer.from(files[`resources/${event.payload.assetId}.bin`]).toString("base64")}`;
    if ((await image.getAttribute("src")) !== expected)
      throw new Error("动态新增或替换的图片未正确还原");
  }
  await panel.getByPlaceholder("搜索记录").fill(instantRemove.id);
  await panel.locator(".timeline-item").first().click();
  if (
    (await panel
      .frameLocator('iframe[title="页面快照"]')
      .locator("#instant-image")
      .getAttribute("src")) !== null
  )
    throw new Error("图片地址删除后仍显示旧图片");
  await panel.getByRole("button", { name: "报告", exact: true }).click();
  await panel
    .locator(".catalog-row")
    .filter({ hasText: "请求体超过大小限制" })
    .first()
    .waitFor();
  await panel.getByRole("button", { name: "时间线", exact: true }).click();
  if (canceledPush) {
    await panel.getByRole("button", { name: "报告", exact: true }).click();
    await panel
      .locator(".catalog-row")
      .filter({ hasText: "请求取消" })
      .first()
      .waitFor();
    await panel.getByRole("button", { name: "时间线", exact: true }).click();
  }
  await panel.screenshot({ path: path.resolve("test-artifacts/viewer.png") });
  await panel.getByPlaceholder("搜索记录").fill("redirect-image");
  await panel
    .locator(".timeline-item")
    .filter({ hasText: "页面状态" })
    .last()
    .click();
  const restoredImage = panel
    .frameLocator('iframe[title="页面快照"]')
    .locator("#redirected-image");
  await restoredImage.waitFor();
  if (
    !(await restoredImage.getAttribute("src"))?.startsWith(
      "data:image/png;base64,",
    )
  )
    throw new Error("重定向图片未在页面快照中还原");
  await restoredImage.evaluate((image) => image.decode());
  const imageRequests = events.filter(
    (event) =>
      event.kind === "network.request" &&
      event.tabId === tab.id &&
      event.payload.url === `http://127.0.0.1:${port}/test-image.png`,
  );
  const imageAssets = imageRequests
    .map(
      (request) =>
        events.find(
          (event) =>
            event.kind === "network.finished" &&
            event.payload.requestId === request.payload.requestId &&
            event.payload.assetId,
        )?.payload.assetId,
    )
    .filter(Boolean);
  if (imageAssets.length < 2 || imageAssets[0] === imageAssets[1])
    throw new Error("同地址图片的两次响应未被分别保存");
  for (const [phase, asset] of [
    ["image-phase-one", imageAssets[0]],
    ["image-phase-two", imageAssets[1]],
  ]) {
    await panel.getByPlaceholder("搜索记录").fill(phase);
    await panel
      .locator(".timeline-item")
      .filter({ hasText: "页面状态" })
      .last()
      .click();
    const expected = `data:image/png;base64,${Buffer.from(files[`resources/${asset}.bin`]).toString("base64")}`;
    if ((await restoredImage.getAttribute("src")) !== expected)
      throw new Error(`${phase} 未显示对应时间的图片`);
  }
  await panel.getByPlaceholder("搜索记录").fill("短暂提示内容");
  await panel
    .locator(".timeline-item")
    .filter({ hasText: "页面变化" })
    .first()
    .click();
  await panel
    .frameLocator('iframe[title="页面快照"]')
    .getByText("短暂提示内容")
    .waitFor({ timeout: 10000 });
  await panel.getByPlaceholder("搜索记录").fill("");
  await panel.getByRole("button", { name: "复现", exact: true }).click();
  await panel.getByText(/^步骤 1 \/ /).waitFor();
  await panel.screenshot({ path: path.resolve("test-artifacts/replay.png") });
  await panel.getByRole("textbox", { name: "输入记录值" }).fill("客户甲");
  await panel.getByText(/^步骤 2 \/ /).waitFor();
  await panel.getByRole("button", { name: "下一步", exact: true }).click();
  await panel.getByText(/^步骤 3 \/ /).waitFor();
  await panel.getByRole("button", { name: /^页面 \d+$/ }).click();
  await panel.getByText("已记录的页面").waitFor();
  await panel.getByRole("button", { name: /^流程 \d+$/ }).click();
  await panel.getByText("操作流程").waitFor();
  await panel.getByRole("button", { name: /^接口 \d+$/ }).click();
  const specDownload = panel.waitForEvent("download", { timeout: 15000 });
  await panel.getByRole("button", { name: "导出接口规范草稿" }).click();
  const specFile = await specDownload,
    specPath = path.join(profile, "openapi.zip");
  await specFile.saveAs(specPath);
  const specs = unzipSync(await fs.readFile(specPath));
  const specIndex = JSON.parse(strFromU8(specs["index.json"]));
  if (
    !specIndex.some(
      (item) =>
        JSON.parse(strFromU8(specs[item.file])).paths["/api/customers"]?.get,
    )
  )
    throw new Error("接口规范草稿缺少观察到的接口");
  if (
    !specIndex.some((item) => {
      const operation = JSON.parse(strFromU8(specs[item.file])).paths[
        "/api/large-post"
      ]?.post;
      return (
        operation?.requestBody?.content?.["application/json"]?.examples
          ?.sample_1?.value?.note?.length === 90000 &&
        operation["x-logic-recorder-evidence"]?.[0]?.requestBodyEventId
      );
    })
  )
    throw new Error("接口规范草稿未使用补充的请求体");
  if (
    !specIndex.some((item) => {
      const operation = JSON.parse(strFromU8(specs[item.file])).paths[
        "/api/mixed"
      ]?.post;
      const form =
        operation?.requestBody?.content?.["application/x-www-form-urlencoded"];
      const response = operation?.responses?.["200"]?.content;
      return (
        JSON.stringify(form?.examples?.sample_1?.value?.tag) === '["a","b"]' &&
        form?.examples?.sample_1?.value?.token === "[已隐藏]" &&
        operation?.requestBody?.content?.["application/json"] &&
        operation?.requestBody?.content?.["text/plain"] &&
        response?.["application/json"]?.schema?.properties?.order &&
        response?.["application/json"]?.schema?.properties?.total &&
        response?.["text/plain"]
      );
    })
  )
    throw new Error("接口规范草稿未包含多种请求及响应样本");
  if (
    !specIndex.some((item) => {
      const paths = JSON.parse(strFromU8(specs[item.file])).paths;
      return (
        paths["/api/redirect"]?.get?.responses?.["302"] &&
        paths["/api/customers"]?.get?.responses?.["200"]
      );
    })
  )
    throw new Error("接口规范草稿缺少重定向请求或目标响应");
  console.log("复现和接口草稿已测试");
  const replayEvents = [
    {
      id: "replay-check",
      seq: 1,
      time: 1,
      kind: "interaction.change",
      tabId: 1,
      frameId: 0,
      payload: {
        url: "https://example.test/",
        target: {
          tag: "input",
          type: "checkbox",
          name: "确认",
          selector: "#check",
        },
        value: "on",
        formState: { checked: true },
      },
    },
    {
      id: "replay-radio",
      seq: 2,
      time: 2,
      kind: "interaction.change",
      tabId: 1,
      frameId: 0,
      payload: {
        url: "https://example.test/",
        target: {
          tag: "input",
          type: "radio",
          name: "方案",
          selector: "#radio",
        },
        value: "on",
        formState: { checked: true },
      },
    },
    {
      id: "replay-select",
      seq: 3,
      time: 3,
      kind: "interaction.change",
      tabId: 1,
      frameId: 0,
      payload: {
        url: "https://example.test/",
        target: { tag: "select", name: "项目", selector: "#select" },
        value: "a",
        formState: {
          selectedIndices: [0, 2],
          multiple: true,
          options: [{ label: "A1" }, { label: "B" }, { label: "A2" }],
        },
      },
    },
    {
      id: "replay-finish",
      seq: 4,
      time: 4,
      kind: "interaction.click",
      tabId: 1,
      frameId: 0,
      payload: {
        url: "https://example.test/",
        target: { tag: "button", text: "完成", selector: "#finish" },
      },
    },
  ];
  const replayManifest = {
    format: "logic-recorder",
    version: 2,
    session: { id: "replay-test", title: "选择复现测试", startedAt: 1 },
    eventCount: replayEvents.length,
    eventChunks: ["timeline/events-00001.jsonl"],
  };
  const replayFiles = {
    "manifest.json": strToU8(JSON.stringify(replayManifest)),
    "timeline/events-00001.jsonl": strToU8(
      replayEvents.map((event) => JSON.stringify(event)).join("\n"),
    ),
  };
  replayFiles["integrity.json"] = strToU8(
    JSON.stringify(
      Object.entries(replayFiles).map(([entryPath, bytes]) => ({
        path: entryPath,
        size: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      })),
    ),
  );
  const replayPath = path.join(profile, "replay-controls.zip");
  await fs.writeFile(replayPath, zipSync(replayFiles));
  await panel.locator("input[type=file]").first().setInputFiles(replayPath);
  await panel.getByRole("heading", { name: "选择复现测试" }).waitFor();
  await panel.getByRole("button", { name: "复现", exact: true }).click();
  await panel.getByLabel("复现勾选").click();
  await panel.getByText("步骤 2 / 4").waitFor();
  await panel.getByLabel("复现勾选").click();
  await panel.getByText("步骤 3 / 4").waitFor();
  await panel.getByLabel("复现选择").selectOption(["0", "2"]);
  await panel.getByText("步骤 4 / 4").waitFor();
  console.log("选择控件复现已测试");
  const probe = `http://127.0.0.1:${port}/probe`;
  const unsafeEvents = [
    {
      id: "unsafe-snapshot",
      sessionId: "unsafe",
      seq: 1,
      time: 1,
      tabId: 1,
      frameId: 0,
      kind: "page.snapshot",
      payload: {
        url: "https://example.test/",
        status: "captured",
        html: `<html><head><meta http-equiv="refresh" content="0;url=${probe}"><style>@import url('${probe}'); body{background:url('${probe}')}</style><script>fetch('${probe}')</script></head><body data-logic-node="1" data-logic-background="${probe}"><img src="${probe}"><iframe src="${probe}"></iframe><p>隔离内容</p></body></html>`,
      },
    },
    {
      id: "unsafe-mutation",
      sessionId: "unsafe",
      seq: 2,
      time: 2,
      tabId: 1,
      frameId: 0,
      kind: "page.mutation",
      payload: {
        status: "captured",
        changes: [
          {
            type: "children",
            id: "1",
            removed: [],
            next: null,
            added: [
              {
                id: "2",
                type: "element",
                tag: "img",
                attrs: { src: probe, onerror: `fetch('${probe}')` },
                children: [],
              },
            ],
          },
        ],
      },
    },
  ];
  const unsafeManifest = {
    format: "logic-recorder",
    version: 2,
    session: { id: "unsafe", title: "隔离测试", startedAt: 1 },
    eventCount: unsafeEvents.length,
    eventChunks: ["timeline/events-00001.jsonl"],
  };
  const unsafeFiles = {
    "manifest.json": strToU8(JSON.stringify(unsafeManifest)),
    "timeline/events-00001.jsonl": strToU8(
      unsafeEvents.map((event) => JSON.stringify(event)).join("\n"),
    ),
  };
  unsafeFiles["integrity.json"] = strToU8(
    JSON.stringify(
      Object.entries(unsafeFiles).map(([entryPath, bytes]) => ({
        path: entryPath,
        size: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      })),
    ),
  );
  const unsafePath = path.join(profile, "unsafe.zip");
  await fs.writeFile(unsafePath, zipSync(unsafeFiles));
  await panel.locator("input[type=file]").first().setInputFiles(unsafePath);
  await panel.getByRole("heading", { name: "隔离测试" }).waitFor();
  await panel.getByRole("button", { name: /页面变化/ }).click();
  await panel
    .frameLocator('iframe[title="页面快照"]')
    .getByText("隔离内容")
    .waitFor();
  await panel.waitForTimeout(500);
  if (probeCount !== 0) throw new Error("导入的页面尝试访问了外部地址");
  await panel.getByTitle("返回录制").click();
  await panel.getByRole("heading", { name: "准备开始" }).waitFor();
  const pageCount = context.pages().length;
  await panel.getByTitle("查看记录").first().click();
  await panel.getByRole("heading", { name: "录制测试" }).waitFor();
  if (context.pages().length !== pageCount)
    throw new Error("查看记录时打开了新标签");
  await panel.getByTitle("返回录制").click();
  await page.bringToFront();
  const attempts = await panel.evaluate(
    async (tab) =>
      Promise.all(
        Array.from({ length: 2 }, () =>
          chrome.runtime.sendMessage({
            type: "START",
            tab,
            options: { screenshots: false, scope: "site" },
          }),
        ),
      ),
    { ...tab, url: page.url() },
  );
  if (attempts.filter((attempt) => attempt.ok).length !== 1)
    throw new Error("并发开始录制未被正确限制");
  const again = attempts.find((attempt) => attempt.ok);
  if (!again.ok) throw new Error(`第二次录制启动失败：${again.error}`);
  await page.locator("#search").fill("第二次");
  await page.locator("#find").click();
  await embedded.locator("#search").fill("不在授权范围的输入");
  const againStop = await panel.evaluate(() =>
    chrome.runtime.sendMessage({ type: "STOP" }),
  );
  if (!againStop.ok) throw new Error(`第二次录制停止失败：${againStop.error}`);
  const secondEvents = await panel.evaluate(async (id) => {
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open("logic-recorder");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return await new Promise((resolve, reject) => {
      const req = db
        .transaction("events")
        .objectStore("events")
        .index("session")
        .getAll(id);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }, again.value.id);
  if (!secondEvents.some((event) => event.kind === "interaction.click"))
    throw new Error(
      `第二次录制未重新启用采集器：${JSON.stringify({ status: againStop.value?.status, notice: againStop.value?.notice, warnings: secondEvents.filter((event) => event.kind === "warning").map((event) => event.payload), kinds: secondEvents.map((event) => event.kind) })}`,
    );
  if (JSON.stringify(secondEvents).includes("不在授权范围的输入"))
    throw new Error("站点范围录制采集了未授权框架");
  console.log("重复录制和授权范围已测试");
  const deliverySession = await panel.evaluate(
    (tab) =>
      chrome.runtime.sendMessage({
        type: "START",
        tab,
        options: { screenshots: false, scope: "site" },
      }),
    { ...tab, url: page.url() },
  );
  if (!deliverySession.ok) throw new Error("消息故障测试未能启动录制");
  await panel.evaluate(
    (tabId) =>
      chrome.scripting.executeScript({
        target: { tabId, frameIds: [0] },
        func: () => {
          globalThis.__testOriginalSend = chrome.runtime.sendMessage;
          chrome.runtime.sendMessage = function (message, ...args) {
            if (message?.type === "EVENTS")
              return Promise.reject(new Error("测试发送失败"));
            return globalThis.__testOriginalSend.call(
              chrome.runtime,
              message,
              ...args,
            );
          };
        },
      }),
    tab.id,
  );
  await page.locator("#search").fill("消息故障测试");
  await page.waitForTimeout(600);
  await panel.evaluate(
    (tabId) =>
      chrome.scripting.executeScript({
        target: { tabId, frameIds: [0] },
        func: () => {
          chrome.runtime.sendMessage = globalThis.__testOriginalSend;
          delete globalThis.__testOriginalSend;
        },
      }),
    tab.id,
  );
  const failedDeliveryStop = await panel.evaluate(() =>
    chrome.runtime.sendMessage({ type: "STOP" }),
  );
  if (
    !failedDeliveryStop.ok ||
    failedDeliveryStop.value.status !== "interrupted"
  )
    throw new Error("采集消息失败时未将记录标记为不完整");
  const deliveryState = await panel.evaluate(() =>
    chrome.runtime.sendMessage({ type: "GET_STATE" }),
  );
  const failedRecord = deliveryState.value.sessions.find(
    (session) => session.id === deliverySession.value.id,
  );
  if (!failedRecord?.notice?.includes("最终状态"))
    throw new Error("采集消息失败时未显示提示");
  await panel.reload();
  await panel
    .locator(".record")
    .filter({ hasText: "异常中断" })
    .first()
    .getByTitle("查看记录")
    .click();
  await panel.getByRole("button", { name: "报告", exact: true }).click();
  await panel.getByText("录制异常中断，此包只包含已保存的部分。").waitFor();
  await panel.getByTitle("返回录制").click();
  console.log("采集消息故障提示已测试");
  await panel.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open("logic-recorder");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    await new Promise((resolve, reject) => {
      const tx = db.transaction(["sessions", "events"], "readwrite");
      tx.objectStore("sessions").put({
        id: "large-test",
        title: "大数据测试",
        origin: "http://127.0.0.1",
        status: "ready",
        startedAt: Date.now(),
      });
      for (let i = 1; i <= 2300; i++)
        tx.objectStore("events").put({
          id: `large-${i}`,
          sessionId: "large-test",
          seq: i,
          time: Date.now() + i,
          kind: "interaction.input",
          payload: { text: `${i}:` + "x".repeat(1200) },
        });
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  });
  await panel.reload();
  const largeRecord = panel
    .locator(".record")
    .filter({ hasText: "大数据测试" });
  await largeRecord.waitFor();
  const largeDownload = panel.waitForEvent("download", { timeout: 15000 });
  await largeRecord.getByTitle("下载记录包").click();
  const largeFile = await largeDownload;
  const largePath = path.join(profile, "large.zip");
  await largeFile.saveAs(largePath);
  const largeFiles = unzipSync(await fs.readFile(largePath));
  const largeManifest = JSON.parse(strFromU8(largeFiles["manifest.json"]));
  if (
    largeManifest.version !== 2 ||
    largeManifest.eventChunks.length < 2 ||
    archiveEvents(largeFiles).length !== 2300
  )
    throw new Error("分段归档不完整");
  await panel.getByRole("button", { name: "导入记录包" }).click();
  await panel.locator("input[type=file]").first().setInputFiles(largePath);
  await panel.getByRole("heading", { name: "大数据测试" }).waitFor();
  if ((await panel.locator(".timeline-item").count()) > 100)
    throw new Error("时间线没有限制渲染数量");
  await panel.getByTitle("下一页").click();
  await panel.getByText("2 / 23", { exact: true }).waitFor();
  await panel.getByTitle("返回录制").click();
  console.log("大记录包已测试");
  await page.bringToFront();
  console.log("开始中断恢复测试");
  const third = await timed(
    panel.evaluate(
      async (tab) =>
        chrome.runtime.sendMessage({
          type: "START",
          tab,
          options: { screenshots: false, scope: "site" },
        }),
      { ...tab, url: page.url() },
    ),
    "中断测试录制启动",
  );
  if (!third.ok) throw new Error("中断测试录制未能启动");
  console.log("中断测试录制已启动");
  await page.locator("#search").fill("中断前数据");
  await page.waitForTimeout(400);
  await timed(context.close(), "浏览器关闭");
  context = null;
  console.log("浏览器已关闭");
  const resumedDownloads = path.join(profile, "downloads-resumed");
  await fs.mkdir(resumedDownloads, { recursive: true });
  context = await chromium.launchPersistentContext(profile, {
    ...browserOptions,
    downloadsPath: resumedDownloads,
    timeout: 45000,
  });
  console.log("浏览器已重新打开");
  if (!context.serviceWorkers()[0])
    await context.waitForEvent("serviceworker", { timeout: 15000 });
  const recoveredPanel = await context.newPage();
  await recoveredPanel.goto(`chrome-extension://${id}/sidepanel.html`);
  await recoveredPanel.waitForTimeout(1500);
  await recoveredPanel
    .getByText("异常中断（可导出部分记录）", { exact: false })
    .first()
    .waitFor({ timeout: 10000 });
  const partialDownload = recoveredPanel.waitForEvent("download", {
    timeout: 15000,
  });
  await recoveredPanel.getByTitle("下载记录包").first().click();
  const partial = await partialDownload;
  const downloadError = await timed(partial.failure(), "中断记录下载完成");
  if (downloadError) throw new Error(`中断记录下载失败：${downloadError}`);
  const partialPath = path.join(profile, "partial.zip");
  await partial.saveAs(partialPath);
  const partialFiles = unzipSync(await fs.readFile(partialPath));
  if (!JSON.parse(strFromU8(partialFiles["manifest.json"])).partial)
    throw new Error("异常中断记录包未标记为部分记录");
  if (!JSON.stringify(archiveEvents(partialFiles)).includes("中断前数据"))
    throw new Error("异常中断前数据未保留");
  console.log("端到端录制、侧边栏查看、跨站和中断恢复测试通过");
} finally {
  if (context) await context.close();
  await new Promise((resolve) => sockets.close(resolve));
  await new Promise((resolve) => server.close(resolve));
  if (
    path.dirname(profile) === process.cwd() &&
    path.basename(profile).startsWith("test-profile-")
  )
    await fs.rm(profile, {
      recursive: true,
      force: true,
      maxRetries: 20,
      retryDelay: 250,
    });
  if (
    path.dirname(root) === process.cwd() &&
    path.basename(root).startsWith("test-extension-")
  )
    await fs.rm(root, {
      recursive: true,
      force: true,
      maxRetries: 20,
      retryDelay: 250,
    });
}
