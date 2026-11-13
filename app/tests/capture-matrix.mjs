import path from "node:path";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createCapturePlan } from "./capture-scenarios.mjs";
import { runCaptureMatrix } from "./capture-matrix-run.mjs";
import { validationBudgets, validationEnvironment, validationStep } from "./matrix-options.mjs";
import { runScenario } from "./scenario-runner.mjs";
import { captureValidationIdentity } from "./validation-identity.mjs";

// Native-host validation entrypoint per the release request. This runner is not
// an OS isolation launcher or a claim of universal product acceptance.
const appRoot = fileURLToPath(new URL("../", import.meta.url));
const budgets = validationBudgets(process.env);
if (!process.env.CHROME_BIN || !path.isAbsolute(process.env.CHROME_BIN))
  throw new Error("请通过 CHROME_BIN 指定正式版 Chrome 的绝对路径");
const executable = process.env.CHROME_BIN;
const runId = randomUUID();
const directory = await fs.mkdtemp(path.join(appRoot, "test-matrix-"));
const reportPath = path.join(directory, "result.json");
const directories = Object.fromEntries(["home", "temp", "appdata", "localappdata"].map((key) => [key, path.join(directory, key)]));
for (const folder of Object.values(directories)) await fs.mkdir(folder);
let fontPath = process.env.TEST_FONT_PATH || (process.platform === "win32" ? "C:\\Windows\\Fonts\\arial.ttf" : null);
if (fontPath) {
  try { if (!(await fs.stat(fontPath)).isFile()) fontPath = null; } catch { fontPath = null; }
}
const plan = createCapturePlan({ fontAvailable: !!fontPath });
const startedAt = Date.now(), controller = new AbortController();
let stopReason = null, finished = false;
const requestStop = (reason) => {
  if (finished || controller.signal.aborted) return;
  stopReason = reason; controller.abort();
};
const interrupt = () => requestStop("SIGINT"), terminate = () => requestStop("SIGTERM");
process.on("SIGINT", interrupt); process.on("SIGTERM", terminate);
const deadline = setTimeout(() => requestStop("matrix_deadline"), budgets.matrixMs);
const envelope = (result) => ({ ...result, runId, startedAt, updatedAt: Date.now(), stopReason, budgets,
  environment: { nodeVersion: process.versions.node, platform: process.platform, arch: process.arch, chromeVersion: null },
  qualification: { executionIsolation: "not_attested_by_runner", finalRequirementAcceptance: false,
    meaning: "Scenario results are candidate evidence only, never OS-isolation or full requirement approval." } });
let reportNumber = 0;
const writeReport = async (result) => {
  const temporary = path.join(directory, `result-${++reportNumber}.tmp`);
  await fs.writeFile(temporary, JSON.stringify(envelope(result), null, 2) + "\n", { flag: "wx" });
  await fs.rename(temporary, reportPath);
};
console.log(`采集矩阵候选runId=${runId}；报告在本插件app下的独立test-matrix目录`);
try {
  const result = await runCaptureMatrix({ plan, signal: controller.signal,
    captureIdentity: () => validationStep(() => captureValidationIdentity({ appRoot, host: {
      nodeVersion: process.versions.node, platform: process.platform, arch: process.arch,
      chromeBinaryPath: executable, chromeVersion: null, chromeBinarySha256: null,
    } }), { timeoutMs: Math.max(1, budgets.matrixMs - (Date.now() - startedAt)), signal: controller.signal }),
    runScenario: (scenario) => {
      console.log(`开始验证 ${scenario.id}`);
      return runScenario({ id: scenario.id, command: process.execPath,
        args: [path.join(appRoot, "tests/chrome-errors.e2e.mjs")], cwd: appRoot,
        env: validationEnvironment(process.env, directories, { executable, flags: scenario.flags, nativeHost: true,
          fontPath: ["font", "initial-resources"].includes(scenario.id) ? fontPath : null }),
        timeoutMs: Math.min(budgets.scenarioMs, Math.max(1, budgets.matrixMs - (Date.now() - startedAt))),
        cleanupMs: budgets.cleanupMs, signal: controller.signal, requireCleanupAck: true });
    }, onUpdate: (result) => validationStep(() => writeReport(result), { timeoutMs: 5000 }) });
  if (controller.signal.aborted || !result.passed) {
    process.exitCode = controller.signal.aborted ? 130 : 1;
    console.error(`采集矩阵未完整通过：${result.status}`);
  } else {
    console.log(`采集矩阵候选场景完成：${result.counts.passed} passed，${result.counts.skipped || 0} skipped；不等最终需求验收。`);
  }
} catch {
  process.exitCode = 1;
  console.error("采集矩阵证据记录失败；不得将本轮计为通过");
} finally {
  finished = true; clearTimeout(deadline);
  process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", terminate);
}
