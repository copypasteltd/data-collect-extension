import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs/promises";

if (!process.env.CHROME_BIN) throw new Error("请通过 CHROME_BIN 指定正式版 Chrome 的路径");
const scenarios = [
  ["combined", { TEST_LARGE_DOM: "1", TEST_LARGE_STORAGE: "1", TEST_DATABASE_GRAPH: "1", TEST_DATABASE_LARGE: "1",
    TEST_LARGE_REQUEST: "1", TEST_LARGE_RESPONSE: "1", TEST_FILE_CAPTURE: "1", TEST_CANVAS_MANY: "1", TEST_STYLE_CAPTURE: "1" }],
  ["frames-and-navigation", { TEST_FRAME_TREE: "1", TEST_BACKGROUND_PAGE: "1" }],
  ["restricted-frame", { TEST_FRAME_RESTRICTED: "1" }],
  ["frame-injection-failure", { TEST_FRAME_TREE: "1", TEST_FRAME_INJECTION_FAILURE: "1" }],
  ["page-instances", { TEST_PAGE_INSTANCES: "1" }],
  ["large-select", { TEST_LARGE_SELECT: "1" }],
  ["dynamic-form-ime", { TEST_DYNAMIC_FORM: "1" }],
  ["scroll-containers", { TEST_SCROLL_MANY: "1" }],
  ["virtual-list-and-lazy", { TEST_VIRTUAL_LIST: "1" }],
  ["tainted-canvas", { TEST_CANVAS_TAINTED: "1" }],
  ["delayed-final-canvas", { TEST_DELAYED_CANVAS: "1" }],
  ["delayed-final-shadow", { TEST_DELAYED_SHADOW: "1" }],
  ["cache-and-opaque", { TEST_CACHE_BODY: "1", TEST_CACHE_MANY: "1", TEST_CACHE_OPAQUE: "1" }],
  ["cache-removal", { TEST_CACHE_REMOVAL: "1" }],
  ["large-cache-catalog", { TEST_CACHE_CATALOG_LARGE: "1" }],
  ["database-catalog", { TEST_DATABASE_CATALOG: "1" }],
  ["large-database-catalog", { TEST_DATABASE_CATALOG_LARGE: "1" }],
  ["partitioned-cookie", { TEST_PARTITIONED_COOKIE: "1" }],
  ["file-read-failure", { TEST_FILE_CAPTURE: "1", TEST_FILE_FAILURE: "1" }],
  ["missing-asset", { TEST_MISSING_ASSET: "1" }],
  ["quota-failure", { TEST_QUOTA_FAILURE: "1" }],
  ["coverage-read-failure", { TEST_COVERAGE_FAILURE: "1" }],
  ["coverage-read-timeout", { TEST_COVERAGE_TIMEOUT: "1" }],
  ["file-drop", { TEST_FILE_DROP: "1" }],
  ["network-binary", { TEST_BINARY_REQUEST: "1", TEST_LARGE_BINARY: "1", TEST_LARGE_IMAGE: "1" }],
  ["network-binary-18mb", { TEST_LARGE_BINARY_18: "1" }],
  ["visual-resources", { TEST_VISUAL_RESOURCES: "1" }],
  ["network-redirect", { TEST_REDIRECT: "1" }],
  ["network-concurrent", { TEST_NETWORK_CONCURRENT: "1" }],
  ["network-form-fields", { TEST_FORM_FIELDS: "1" }],
  ["network-realtime-large", { TEST_REALTIME_LARGE: "1" }],
  ["mutations", { TEST_MUTATION_BATCH: "1", TEST_RAW_MUTATION: "1" }],
  ["shadow-style", { TEST_SHADOW_STYLE: "1" }],
  ["pseudo-style", { TEST_PSEUDO_STYLE: "1" }],
  ["theme-switch-and-hover", { TEST_THEME_SWITCH: "1" }],
  ["computed-style-stress", { TEST_STYLE_STRESS: "1" }],
  ["full-page-dpr2", { TEST_FULL_PAGE: "1", TEST_PNG_PIXEL: "1", TEST_DEVICE_SCALE: "2" }],
  ["fixed-and-nested-scroll", { TEST_FIXED_NESTED: "1" }],
  ["full-page-tiles", { TEST_FULL_PAGE_TILED: "1" }],
  ["skill-reconstruction", { TEST_LARGE_DOM: "1", TEST_SKILL_RECONSTRUCT: "1" }],
  ["long-input-and-clicks", { TEST_LONG_INPUT: "1", TEST_FAST_CLICKS: "1" }],
];
const fontPath = process.env.TEST_FONT_PATH || (process.platform === "win32" ? "C:\\Windows\\Fonts\\arial.ttf" : null);
if (fontPath) {
  try { await fs.access(fontPath); scenarios.push(["font", { TEST_FONT: "1", TEST_FONT_PATH: fontPath }], ["initial-resources", { TEST_INITIAL_RESOURCES: "1", TEST_FONT_PATH: fontPath }]); }
  catch { console.log("字体测试样本不可用"); }
} else console.log("字体测试样本不可用");
const failed = [];
for (const [name, flags] of scenarios) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("TEST_")) delete env[key];
  Object.assign(env, flags);
  console.log(`开始验证 ${name}`);
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.resolve("tests/chrome-errors.e2e.mjs")], {
      cwd: process.cwd(), env, windowsHide: true, stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (status) => resolve(status));
  });
  if (code !== 0) failed.push(name);
}
if (failed.length) {
  console.error(`未通过: ${failed.join(", ")}`);
  process.exitCode = 1;
} else console.log(`采集验证矩阵通过：${scenarios.length} 项`);
