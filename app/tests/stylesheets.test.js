import { it } from "node:test";
import assert from "node:assert/strict";
import { parse } from "parse5";
import { buildStylesheetMap } from "../src/stylesheet-resources.js";
import { sanitizeCss } from "../src/snapshot.js";
import { fontMime } from "../src/font-format.js";
import { recordedFontFaces, recordedFontMetadata } from "../src/font-resources.js";

it("按标签页和时间还原已采集样式，并关联重定向地址", () => {
  const assets = new Map([["css", { type: "resource", mime: "text/css" }]]);
  const files = { "resources/css.bin": new TextEncoder().encode(".x{color:red}") };
  const events = [
    { kind: "resource.initial", tabId: 1, time: 1, seq: 1, payload: { url: "https://example.test/start.css", mime: "text/css", assetId: "css" } },
    { kind: "network.request", tabId: 1, time: 2, seq: 2, payload: { requestId: "one", type: "Stylesheet", url: "https://example.test/start.css" } },
    { kind: "network.request", tabId: 1, time: 3, seq: 3, payload: { requestId: "two", redirectFrom: "one", type: "Stylesheet", url: "https://example.test/final.css" } },
    { kind: "network.finished", tabId: 1, time: 4, seq: 4, payload: { requestId: "two", body: { status: "captured_redacted_best_effort", value: ".x{color:blue}" } } },
    { kind: "network.request", tabId: 2, time: 5, seq: 5, payload: { requestId: "other", type: "Stylesheet", url: "https://example.test/start.css" } },
    { kind: "network.finished", tabId: 2, time: 6, seq: 6, payload: { requestId: "other", body: { status: "captured_redacted_best_effort", value: ".x{color:green}" } } },
  ];
  assert.equal(buildStylesheetMap(events, 1, { time: 3, seq: 3 }, assets, files).get("https://example.test/start.css"), ".x{color:red}");
  const later = buildStylesheetMap(events, 1, { time: 7, seq: 7 }, assets, files);
  assert.equal(later.get("https://example.test/start.css"), ".x{color:blue}");
  assert.equal(later.get("https://example.test/final.css"), ".x{color:blue}");
  assert.equal(buildStylesheetMap(events, 2, { time: 7, seq: 7 }, assets, files).get("https://example.test/start.css"), ".x{color:green}");
});

it("刷新后的页面不会使用旧页面延迟返回的同地址样式", () => {
  const url = "https://example.test/site.css";
  const snapshot = { kind: "page.snapshot", tabId: 1, frameId: 0, documentId: "new", time: 4, seq: 4, payload: { url: "https://example.test/" } };
  const events = [
    { kind: "network.request", tabId: 1, time: 1, seq: 1, payload: { requestId: "old", type: "Stylesheet", sourceFrame: "main", url } },
    { kind: "navigation.committed", tabId: 1, frameId: 0, time: 3, seq: 3, payload: { documentId: "new" } }, snapshot,
    { kind: "network.request", tabId: 1, time: 5, seq: 5, payload: { requestId: "new", type: "Stylesheet", sourceFrame: "main", url } },
    { kind: "network.finished", tabId: 1, time: 6, seq: 6, payload: { requestId: "old", body: { status: "captured_redacted", value: ".x{color:red}" } } },
    { kind: "network.finished", tabId: 1, time: 7, seq: 7, payload: { requestId: "new", body: { status: "captured_redacted", value: ".x{color:blue}" } } },
  ];
  const context = { frameId: 0, documentId: "new", url: snapshot.payload.url, snapshotEvent: snapshot };
  assert.equal(buildStylesheetMap(events, 1, { time: 6, seq: 6 }, new Map(), {}, context).has(url), false);
  assert.equal(buildStylesheetMap(events, 1, { time: 7, seq: 7 }, new Map(), {}, context).get(url), ".x{color:blue}");
});

it("只从有效字体描述与已保存的地址生成离线字体", () => {
  const value = JSON.stringify([{ descriptors: { "font-family": '"Demo"', "font-weight": "700" }, sources: ["https://example.test/font.woff2", "https://example.test/missing.woff"] }]);
  const result = recordedFontMetadata(value, (url) => url.endsWith("font.woff2") ? "data:font/woff2;base64,d09GMg==" : null);
  assert.match(result.css, /font-weight:700/);
  assert.match(result.css, /data:font\/woff2;base64/);
  assert.equal(result.missing, 1);
  assert.equal(recordedFontMetadata('{"broken":true}', () => null).missing, 1);
  assert.equal(recordedFontMetadata('[{"descriptors":null,"sources":[]}]', () => null).missing, 1);
  assert.equal(recordedFontMetadata(JSON.stringify([{ descriptors: { "font-family": '"</style><img>"' }, sources: ["https://example.test/font.woff2"] }]), () => "data:font/woff2;base64,d09GMg==").css, "");
});

it("样式无法关闭隔离样式标签或引入外部资源", () => {
  const css = sanitizeCss('a{content:"</style><img src=https://example.test/probe>";background:url(https://example.test/probe)} @import "https://example.test/probe";');
  assert.ok(!css.toLowerCase().includes("</style"));
  assert.ok(!css.includes("url("));
  assert.ok(!css.includes("@import"));
  const nodes = [parse(`<style>${css}</style>`)];
  for (let i = 0; i < nodes.length; i++) nodes.push(...(nodes[i].childNodes || []));
  assert.ok(!nodes.some((node) => node.tagName === "img"));
});

it("字体只使用已录制的 WOFF 资源并报告缺失", () => {
  assert.equal(fontMime(new Uint8Array([119, 79, 70, 50])), "font/woff2");
  assert.equal(fontMime(new Uint8Array([119, 79, 70, 70])), "font/woff");
  assert.equal(fontMime(new Uint8Array([0, 1, 2, 3])), null);
  const seen = [];
  const result = recordedFontFaces('@font-face{font-family:"Demo";src:local("Installed"),url("../demo.woff2?token=secret") format("woff2"),url(https://other.test/missing.woff)}',
    "https://example.test/css/site.css", (url) => {
      seen.push(url);
      return url.startsWith("https://example.test/") ? "data:font/woff2;base64,d09GMg==" : null;
    });
  assert.deepEqual(seen, ["https://example.test/demo.woff2?token=%5B%E5%B7%B2%E9%9A%90%E8%97%8F%5D", "https://other.test/missing.woff"]);
  assert.equal(result.missing, 1);
  assert.match(result.css, /data:font\/woff2;base64,d09GMg==/);
  assert.doesNotMatch(result.css, /secret|Installed|other\.test/);
  const hostile = recordedFontFaces('@font-face{font-family:"</style><img>";src:url("x.woff2")}', "https://example.test/", () => 'data:font/woff2;base64,d09GMg=="}body{color:red}');
  assert.equal(hostile.css, "");
});
