import { chromium } from "playwright";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

export async function launchExtension(profile, extension, extraArgs = []) {
  const child = spawn(process.env.CHROME_BIN || chromium.executablePath(), [
    `--user-data-dir=${profile}`, "--headless=new", "--remote-debugging-port=0",
    "--enable-unsafe-extension-debugging", "--no-first-run", "--no-default-browser-check",
    "--disable-background-networking", "--no-proxy-server", ...extraArgs, "about:blank",
  ], { windowsHide: true, stdio: "ignore" });
  let launchError, browser, root;
  const exited = new Promise((resolve) => {
    child.once("exit", resolve);
    child.once("error", (error) => { launchError = error; resolve(); });
  });
  const close = async () => {
    if (root) await root.send("Browser.close").catch(() => {});
    if (browser) await browser.close().catch(() => {});
    if (child.exitCode === null) child.kill();
    await exited;
  };
  try {
    let port;
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline && !port) {
      if (launchError) throw launchError;
      try { port = Number((await fs.readFile(path.join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]); }
      catch { await new Promise((resolve) => setTimeout(resolve, 100)); }
    }
    if (!port) throw new Error("Chrome 调试接口未启动");
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    root = await browser.newBrowserCDPSession();
    const { id } = await root.send("Extensions.loadUnpacked", { path: extension });
    return { context: browser.contexts()[0], id, close };
  } catch (error) {
    await close();
    throw error;
  }
}
