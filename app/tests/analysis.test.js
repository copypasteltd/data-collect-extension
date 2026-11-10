import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildCatalog, buildResourceMap, findRequestsWithoutOutcome } from "../src/analysis.js";

describe("记录资料整理", () => {
  it("识别没有结束状态的请求，并区分已结束、显式不完整和标识复用", () => {
    const request = (id, seq) => ({ id: `event-${seq}`, kind: "network.request", seq, time: seq, payload: { requestId: id } });
    const outcome = (id, kind, seq) => ({ kind, seq, time: seq, payload: { requestId: id } });
    const events = [request("pending", 1), request("done", 2), outcome("done", "network.finished", 3),
      request("failed", 4), outcome("failed", "network.failed", 5),
      request("incomplete", 6), outcome("incomplete", "network.incomplete", 7),
      request("reused", 8), request("reused", 9), outcome("reused", "network.finished", 10),
      request("second", 11), outcome("absent", "network.finished", 12)];
    assert.deepEqual(findRequestsWithoutOutcome(events.reverse()).map((event) => event.id).sort(),
      ["event-1", "event-8", "event-11"].sort());
  });
  it("初始图片可回看，并由后续同地址响应替换", () => {
    const url = "https://example.test/image.png";
    const events = [
      {
        kind: "resource.initial",
        tabId: 1,
        time: 1,
        seq: 1,
        payload: { url, assetId: "initial" },
      },
      {
        kind: "network.request",
        tabId: 1,
        time: 2,
        seq: 2,
        payload: { requestId: "r", url },
      },
      {
        kind: "network.finished",
        tabId: 1,
        time: 3,
        seq: 3,
        payload: { requestId: "r", assetId: "later" },
      },
    ];
    assert.equal(
      buildResourceMap(events, 1, { time: 1, seq: 1 }).get(url),
      "initial",
    );
    assert.equal(
      buildResourceMap(events, 1, { time: 3, seq: 3 }).get(url),
      "later",
    );
    assert.equal(buildResourceMap(events, 2).has(url), false);
    const lateInitial = { ...events[0], time: 4, seq: 4 };
    assert.equal(
      buildResourceMap([events[1], events[2], lateInitial], 1).get(url),
      "later",
    );
  });
  it("将重定向前的图片地址关联到最终保存的资源", () => {
    const events = [
      {
        kind: "network.request",
        payload: { requestId: "a", url: "https://example.test/start" },
      },
      {
        kind: "network.request",
        payload: {
          requestId: "b",
          url: "https://example.test/next",
          redirectFrom: "a",
        },
      },
      {
        kind: "network.request",
        payload: {
          requestId: "c",
          url: "https://example.test/image",
          redirectFrom: "b",
        },
      },
      {
        kind: "network.finished",
        payload: { requestId: "c", assetId: "image" },
      },
    ];
    const resources = buildResourceMap(events);
    assert.equal(resources.get("https://example.test/start"), "image");
    assert.equal(resources.get("https://example.test/next"), "image");
    assert.equal(resources.get("https://example.test/image"), "image");
  });
  it("同一图片地址在不同标签页中优先使用本标签页的资源", () => {
    const url = "https://example.test/avatar";
    const events = [
      { kind: "network.request", tabId: 1, payload: { requestId: "a", url } },
      {
        kind: "network.finished",
        tabId: 1,
        payload: { requestId: "a", assetId: "first" },
      },
      { kind: "network.request", tabId: 2, payload: { requestId: "b", url } },
      {
        kind: "network.finished",
        tabId: 2,
        payload: { requestId: "b", assetId: "second" },
      },
    ];
    assert.equal(buildResourceMap(events, 1).get(url), "first");
    assert.equal(buildResourceMap(events, 2).get(url), "second");
  });
  it("相同资源地址按嵌入页面及页面实例区分", () => {
    const url = "https://example.test/avatar.png";
    const main = { kind: "page.snapshot", tabId: 1, frameId: 0, documentId: "main", time: 3, seq: 3, payload: { url: "https://example.test/" } };
    const child = { kind: "page.snapshot", tabId: 1, frameId: 4, documentId: "child", time: 4, seq: 4, payload: { url: "https://example.test/frame" } };
    const events = [
      { kind: "resource.initial", tabId: 1, time: 1, seq: 1, payload: { url, assetId: "main-image", frameId: 0, documentId: "main" } },
      { kind: "resource.initial", tabId: 1, time: 2, seq: 2, payload: { url, assetId: "child-image", frameId: 4, documentId: "child" } },
      main, child,
    ];
    const cutoff = { time: 5, seq: 5 };
    assert.equal(buildResourceMap(events, 1, cutoff, { frameId: 0, documentId: "main", url: main.payload.url, snapshotEvent: main }).get(url), "main-image");
    assert.equal(buildResourceMap(events, 1, cutoff, { frameId: 4, documentId: "child", url: child.payload.url, snapshotEvent: child }).get(url), "child-image");
  });
  it("页面刷新后不会把旧页面尚未完成的同地址资源当作新页面内容", () => {
    const url = "https://example.test/avatar.png";
    const snapshot = { kind: "page.snapshot", tabId: 1, frameId: 0, documentId: "new-doc", time: 4, seq: 4, payload: { url: "https://example.test/" } };
    const events = [
      { kind: "network.request", tabId: 1, time: 1, seq: 1, payload: { requestId: "old", url, sourceFrame: "main" } },
      { kind: "navigation.committed", tabId: 1, frameId: 0, time: 3, seq: 3, payload: { documentId: "new-doc" } },
      snapshot,
      { kind: "network.request", tabId: 1, time: 5, seq: 5, payload: { requestId: "new", url, sourceFrame: "main" } },
      { kind: "network.finished", tabId: 1, time: 6, seq: 6, payload: { requestId: "old", assetId: "old-image" } },
      { kind: "network.finished", tabId: 1, time: 7, seq: 7, payload: { requestId: "new", assetId: "new-image" } },
    ];
    const context = { frameId: 0, documentId: "new-doc", url: snapshot.payload.url, snapshotEvent: snapshot };
    assert.equal(buildResourceMap(events, 1, { time: 6, seq: 6 }, context).has(url), false);
    assert.equal(buildResourceMap(events, 1, { time: 7, seq: 7 }, context).get(url), "new-image");
  });
  it("相同网址的多个嵌入页面不会复用无法区分来源的资源", () => {
    const url = "https://example.test/avatar.png", page = "https://example.test/frame";
    const frame = (id) => ({ kind: "page.snapshot", tabId: 1, frameId: id, documentId: `doc-${id}`, time: id, seq: id, payload: { url: page } });
    const a = frame(3), b = frame(4);
    const events = [a, b, { kind: "network.request", tabId: 1, time: 5, seq: 5, payload: { requestId: "r", url, sourceFrame: "unknown", documentUrl: page } }, { kind: "network.finished", tabId: 1, time: 6, seq: 6, payload: { requestId: "r", assetId: "ambiguous" } }];
    assert.equal(buildResourceMap(events, 1, { time: 7, seq: 7 }, { frameId: 3, documentId: "doc-3", url: page, snapshotEvent: a }).has(url), false);
    events.push({ kind: "navigation.committed", tabId: 1, frameId: 4, time: 4.5, seq: 8, payload: { documentId: "other-doc" } });
    assert.equal(buildResourceMap(events, 1, { time: 7, seq: 7 }, { frameId: 3, documentId: "doc-3", url: page, snapshotEvent: a }).get(url), "ambiguous");
  });
  it("回看页面时只使用所选事件之前最近取得的图片", () => {
    const url = "https://example.test/avatar";
    const events = [
      {
        kind: "network.request",
        tabId: 1,
        time: 1,
        seq: 1,
        payload: { requestId: "a", url },
      },
      {
        kind: "network.finished",
        tabId: 1,
        time: 2,
        seq: 2,
        payload: { requestId: "a", assetId: "old" },
      },
      {
        kind: "network.request",
        tabId: 1,
        time: 3,
        seq: 3,
        payload: { requestId: "b", url },
      },
      {
        kind: "network.finished",
        tabId: 1,
        time: 4,
        seq: 4,
        payload: { requestId: "b", assetId: "new" },
      },
    ];
    assert.equal(
      buildResourceMap(events, 1, { time: 1, seq: 1 }).has(url),
      false,
    );
    assert.equal(
      buildResourceMap(events, 1, { time: 3, seq: 3 }).get(url),
      "old",
    );
    assert.equal(
      buildResourceMap(events, 1, { time: 4, seq: 3 }).get(url),
      "old",
    );
    assert.equal(
      buildResourceMap(events, 1, { time: 4, seq: 4 }).get(url),
      "new",
    );
    assert.equal(
      buildResourceMap([...events].reverse(), 1, { time: 5, seq: 5 }).get(url),
      "new",
    );
  });
  it("只汇总实际观察到的页面与接口，并保留证据关联", () => {
    const events = [
      {
        id: "p",
        time: 1,
        kind: "page.snapshot",
        payload: { url: "https://example.test/list", title: "列表" },
      },
      {
        id: "q",
        time: 2,
        kind: "network.request",
        payload: {
          requestId: "1",
          type: "Fetch",
          method: "GET",
          url: "https://example.test/api?id=1",
        },
      },
      {
        id: "r",
        time: 3,
        kind: "network.response",
        payload: { requestId: "1", status: 200 },
      },
      {
        id: "f",
        time: 4,
        kind: "network.finished",
        payload: { requestId: "1", body: { value: "{}" } },
      },
    ];
    const result = buildCatalog(events);
    assert.deepEqual(result.pages[0].snapshots, ["p"]);
    assert.equal(result.endpoints[0].path, "https://example.test/api");
    assert.equal(result.endpoints[0].samples[0].responseEventId, "r");
    assert.equal(result.endpoints[0].samples[0].finishedEventId, "f");
  });
  it("补充后取得的请求体并保留证据", () => {
    const result = buildCatalog([
      {
        id: "request",
        time: 1,
        kind: "network.request",
        payload: {
          requestId: "r",
          type: "Fetch",
          method: "POST",
          url: "https://example.test/api",
          postData: { status: "pending" },
        },
      },
      {
        id: "finish",
        time: 2,
        kind: "network.finished",
        payload: { requestId: "r" },
      },
      {
        id: "body",
        time: 3,
        kind: "network.requestBody",
        payload: {
          requestId: "r",
          body: { status: "captured_redacted", value: '{"name":"客户"}' },
        },
      },
    ]);
    const sample = result.endpoints[0].samples[0];
    assert.equal(sample.request.postData.value, '{"name":"客户"}');
    assert.equal(sample.requestBodyEventId, "body");
  });
  it("再次访问同一页面时保留独立操作片段", () => {
    const target = {
      url: "https://example.test/list",
      target: { text: "打开" },
    };
    const events = [
      {
        id: "a",
        time: 1,
        tabId: 1,
        kind: "interaction.click",
        payload: target,
      },
      {
        id: "n",
        time: 2,
        tabId: 1,
        kind: "navigation.spa",
        payload: { tabId: 1, url: "https://example.test/detail" },
      },
      {
        id: "b",
        time: 3,
        tabId: 1,
        kind: "interaction.click",
        payload: target,
      },
    ];
    const result = buildCatalog(events);
    assert.deepEqual(
      result.flows.map((flow) => flow.steps[0].eventId),
      ["a", "b"],
    );
  });
  it("按发生时间整理流程，并在页面刷新和框架导航时区分页面实例", () => {
    const action = (id, time, frameId, documentId) => ({
      id,
      time,
      seq: time,
      tabId: 1,
      frameId,
      documentId,
      kind: "interaction.click",
      payload: { url: "https://example.test/list", target: { text: id } },
    });
    const events = [
      action("main-before", 1, 0, "main-1"),
      action("frame-before", 2, 4, "frame-1"),
      { id: "frame-nav", time: 3, seq: 3, tabId: 1, frameId: 4, kind: "navigation.committed", payload: {} },
      action("frame-after", 4, 4, "frame-2"),
      action("main-same", 5, 0, "main-1"),
      action("main-reloaded", 6, 0, "main-2"),
      { id: "top-nav", time: 7, seq: 7, tabId: 1, frameId: 0, kind: "navigation.committed", payload: {} },
      action("frame-after-main-nav", 8, 4, "frame-3"),
    ];
    const flows = buildCatalog([events[4], ...events.slice(0, 4), ...events.slice(5)]).flows;
    assert.deepEqual(
      flows.map((flow) => flow.steps.map((step) => step.eventId)),
      [["main-before", "main-same"], ["frame-before"], ["frame-after"], ["main-reloaded"], ["frame-after-main-nav"]],
    );
    assert.deepEqual(flows.map((flow) => flow.documentId), ["main-1", "frame-1", "frame-2", "main-2", "frame-3"]);
  });
  it("按页面范围和时间展示候选接口，不把资源或其他嵌入页面混入", () => {
    const action = (id, time, tabId, frameId, documentId, url) => ({ id, time, seq: time, tabId, frameId, documentId, kind: "interaction.click", payload: { url, target: { text: id } } });
    const request = (id, time, tabId, type, sourceFrame, documentUrl, extra = {}) => ({ id, time, seq: time, tabId, kind: "network.request", payload: { requestId: id, method: "GET", url: `https://api.test/${id}`, type, sourceFrame, documentUrl, ...extra } });
    const events = [
      action("main", 1000, 1, 0, "top", "https://site.test/"),
      action("frame", 1100, 1, 3, "child", "https://site.test/frame"),
      request("main-api", 1200, 1, "Fetch", "main", "https://site.test/"),
      request("frame-api", 1250, 1, "XHR", "unknown", "https://site.test/frame"),
      request("asset", 1260, 1, "Image", "main", "https://site.test/"),
      request("ambiguous", 1270, 1, "Fetch", "unknown", null),
      request("other-tab", 1280, 2, "Fetch", "main", "https://site.test/"),
      request("redirect", 1290, 1, "Fetch", "main", "https://site.test/", { redirectFrom: "main-api" }),
      action("main-later", 1300, 1, 0, "top", "https://site.test/"),
      request("later-api", 1350, 1, "Fetch", "main", "https://site.test/"),
    ];
    const flows = buildCatalog(events).flows;
    const main = flows.find((flow) => flow.frameId === 0), frame = flows.find((flow) => flow.frameId === 3);
    assert.deepEqual(main.steps.map((step) => step.candidateRequests.map((item) => item.eventId)), [["main-api"], ["later-api"]]);
    assert.deepEqual(frame.steps[0].candidateRequests.map((item) => [item.eventId, item.source]), [["frame-api", "unconfirmed"]]);
    assert.equal(main.steps[0].candidateRequests[0].source, "main");
    assert.equal(main.steps[0].candidateRequests[0].delay, 200);
  });
  it("相同网址的多个嵌入页面无法区分时不自动关联请求", () => {
    const events = [3, 4].map((frameId) => ({ id: `step-${frameId}`, time: 10, seq: frameId, tabId: 1, frameId, documentId: `doc-${frameId}`, kind: "interaction.click", payload: { url: "https://site.test/frame", target: {} } }));
    events.push({ id: "request", time: 11, seq: 10, tabId: 1, kind: "network.request", payload: { requestId: "r", method: "GET", type: "Fetch", url: "https://site.test/api", sourceFrame: "embedded", documentUrl: "https://site.test/frame" } });
    assert.ok(buildCatalog(events).flows.every((flow) => flow.steps[0].candidateRequests.length === 0));
  });
});
