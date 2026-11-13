import { chromium } from "playwright";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { attachCleanup, createOwnedChromeCleanup } from "./owned-chrome-cleanup.mjs";
import { createProfileCleanupGuard } from "./profile-cleanup-guard.mjs";

const profileCleanup = createProfileCleanupGuard();

export async function removeTestProfile(profile, removeCallback) {
  let result;
  try { result = await profileCleanup.remove(profile, removeCallback); }
  catch { result = { status: "preserved" }; }
  if (result.status === "preserved") {
    process.exitCode = 1;
    // Never throw/log an error or path here: finally must preserve the startup error.
    try { console.error("test_profile_cleanup: preserved"); } catch {}
  }
  return result;
}

export async function launchExtension(profile, extension, extraArgs = []) {
  let child, browser, root, attempt, chromeStderr = "", closePromise;
  const cleanup = createOwnedChromeCleanup({ getRoot: () => root, getBrowser: () => browser });
  const onStderr = (chunk) => { chromeStderr = (chromeStderr + chunk.toString()).slice(-8000); };
  const close = () => {
    if (!closePromise) closePromise = cleanup.closeOrThrow().then((result) => {
      profileCleanup.report(profile, attempt, result);
      return result;
    }).catch((error) => {
      try { error.chromeStderr = chromeStderr; } catch {}
      throw error;
    }).finally(() => child?.stderr?.removeListener("data", onStderr));
    return closePromise;
  };
  try {
    attempt = profileCleanup.begin(profile);
    child = cleanup.registerChild(spawn(process.env.CHROME_BIN || chromium.executablePath(), [
      `--user-data-dir=${profile}`, "--headless=new", "--remote-debugging-port=0",
      "--enable-unsafe-extension-debugging", "--no-first-run", "--no-default-browser-check",
      "--disable-background-networking", "--no-proxy-server", ...extraArgs, "about:blank",
    ], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] }));
    // Register child lifecycle and diagnostics synchronously, before the first await.
    child.stderr?.on("data", onStderr);
    let port;
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline && !port) {
      const state = cleanup.childState();
      if (state.launchError) throw state.launchError;
      if (state.rootClosed) throw new Error(`Chrome exited during startup (${state.exitCode ?? state.signal ?? state.terminal})`);
      try { port = Number((await fs.readFile(path.join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]); }
      catch { await new Promise((resolve) => setTimeout(resolve, 100)); }
    }
    if (!port) throw new Error("Chrome 调试接口未启动");
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    root = await browser.newBrowserCDPSession();
    const { id } = await root.send("Extensions.loadUnpacked", { path: extension });
    return { context: browser.contexts()[0], id, close };
  } catch (error) {
    // Cleanup failure must not replace the startup exception/stack.
    try {
      const result = await cleanup.close();
      profileCleanup.report(profile, attempt, result);
      attachCleanup(error, result);
    }
    catch (cleanupFailure) {
      attachCleanup(error, cleanupFailure?.cleanup ?? { status: "unconfirmed", code: "cleanup_unconfirmed" });
    }
    finally { child?.stderr?.removeListener("data", onStderr); }
    try { error.chromeStderr = chromeStderr; } catch {}
    throw error;
  }
}
