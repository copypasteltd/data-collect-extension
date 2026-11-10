import { chromium } from "playwright";
import path from "node:path";
import fs from "node:fs/promises";

const profile = await fs.mkdtemp(path.resolve("test-recovery-profile-"));
const extension = path.resolve("dist");
let context;
try {
  context = await chromium.launchPersistentContext(profile, {
    executablePath:
      process.env.CHROME_BIN || chromium.executablePath(),
    headless: true,
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
    ],
  });
  const firstWorker =
    context.serviceWorkers()[0] ||
    (await context.waitForEvent("serviceworker", { timeout: 15000 }));
  const panel = await context.newPage();
  await panel.goto(
    `chrome-extension://${new URL(firstWorker.url()).host}/sidepanel.html`,
  );
  const initial = await panel.evaluate(() => chrome.runtime.sendMessage({ type: "GET_STATE" }));
  if (!initial.ok) throw new Error("后台初始化失败");
  const cdp = await context.newCDPSession(panel);
  await cdp.send("ServiceWorker.enable");
  for (const [name, storedStatus, activeStatus, expectedStatus] of [
    ["preparing", "preparing", "preparing", "interrupted"],
    ["stopping", "stopping", "recording", "interrupted"],
    ["recording", "recording", "recording", "recording"],
    ["completed", "ready", "recording", "ready"],
  ]) {
    await panel.evaluate(async ({ name, storedStatus, activeStatus }) => {
      const session = {
        id: name,
        title: name,
        origin: "https://example.test",
        startedAt: Date.now(),
        status: storedStatus,
        options: { scope: "site" },
        tabs: {},
      };
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open("logic-recorder");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      await new Promise((resolve, reject) => {
        const tx = db.transaction("sessions", "readwrite");
        tx.objectStore("sessions").put(session);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
      db.close();
      await chrome.storage.session.set({
        active: { ...session, status: activeStatus },
      });
    }, { name, storedStatus, activeStatus });
    const before = await cdp.send("Target.getTargets");
    if (!before.targetInfos.some((item) => item.type === "service_worker"))
      throw new Error(`${name}: 测试前后台未运行`);
    await cdp.send("ServiceWorker.stopAllWorkers");
    const after = await cdp.send("Target.getTargets");
    if (after.targetInfos.some((item) => item.type === "service_worker"))
      throw new Error(`${name}: 未能停止后台`);
    const result = await panel.evaluate(() =>
      chrome.runtime.sendMessage({ type: "GET_STATE" }),
    );
    if (
      !result.ok ||
      (expectedStatus === "recording"
        ? result.value.active?.id !== name
        : !!result.value.active)
    )
      throw new Error(`${name}: 后台重启后的活动状态错误`);
    const session = result.value.sessions.find((item) => item.id === name);
    if (session?.status !== expectedStatus)
      throw new Error(`${name}: 记录状态错误 ${session?.status}`);
    if (expectedStatus === "interrupted" && !session.notice)
      throw new Error(`${name}: 缺少中断说明`);
  }
  console.log("后台重启后的准备、录制、收尾和完成状态恢复通过");
} finally {
  if (context) await context.close();
  await fs.rm(profile, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 250,
  });
}
