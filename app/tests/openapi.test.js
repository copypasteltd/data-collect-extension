import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildOpenApi } from "../src/openapi.js";
import { buildCatalog } from "../src/analysis.js";

describe("接口规范草稿", () => {
  it("区分成功、失败和未完成的响应，不把未知状态伪装成成功", () => {
    const url = "https://example.test/api";
    let sequence = 0;
    const event = (kind, requestId, payload = {}) => ({
      id: `e${++sequence}`, seq: sequence, time: sequence, tabId: 1, kind,
      payload: { requestId, ...payload },
    });
    const request = (id) => event("network.request", id, { method: "GET", url, type: "Fetch", headers: {} });
    const events = [request("ok"), event("network.response", "ok", { status: 200, mimeType: "application/json" }),
      event("network.finished", "ok", { body: { status: "captured_redacted", value: '{"ok":true}' } }),
      request("error"), event("network.response", "error", { status: 404 }), event("network.finished", "error", { body: { status: "empty" } }),
      request("interrupted"), event("network.response", "interrupted", { status: 200 }),
      event("network.incomplete", "interrupted", { reason: "recording_stopped" }),
      request("failed"), event("network.failed", "failed", { canceled: true }),
      request("unknown"), request("unusual"), event("network.response", "unusual", { status: 600 }),
      request("invalid"), event("network.response", "invalid", { status: "__proto__" })];
    const operation = buildOpenApi(buildCatalog(events))[0].document.paths["/api"].get;
    assert.deepEqual(Object.keys(operation.responses).sort(), ["200", "404", "default"]);
    assert.match(operation.responses.default.description, /占位/);
    const evidence = operation["x-logic-recorder-evidence"];
    assert.deepEqual(evidence.map((item) => item.outcome),
      ["finished", "finished", "incomplete", "failed", "unrecorded", "unrecorded", "unrecorded"]);
    assert.equal(evidence[0].responseBodyStatus, "captured_redacted");
    assert.equal(evidence[2].outcomeReason, "recording_stopped");
    assert.equal(evidence[3].canceled, true);
    assert.equal(evidence[5].observedStatus, 600);
    assert.equal(evidence[6].observedStatus, undefined);
  });
  it("将路径中的字面花括号转义，并合并规范化后相同的接口样本", () => {
    const sample = (url, id) => ({ url, requestEventId: id, request: { headers: {} }, response: { status: 200 } });
    const doc = buildOpenApi({ endpoints: [
      { method: "GET", path: "https://example.test/api/{literal}", samples: [sample("https://example.test/api/{literal}?a=1", "a")] },
      { method: "get", path: "https://example.test/api/%7bliteral%7d", samples: [sample("https://example.test/api/%7bliteral%7d?b=2", "b")] },
    ] })[0].document;
    assert.deepEqual(Object.keys(doc.paths), ["/api/%7Bliteral%7D"]);
    const operation = doc.paths["/api/%7Bliteral%7D"].get;
    assert.deepEqual(operation.parameters.map((parameter) => parameter.name), ["a", "b"]);
    assert.deepEqual(operation["x-logic-recorder-evidence"].map((item) => item.requestEventId), ["a", "b"]);
  });
  it("根据样本生成参数、响应和证据，不推断必填字段", () => {
    const catalog = {
      endpoints: [
        {
          method: "GET",
          path: "https://example.test/api/users",
          samples: [
            {
              url: "https://example.test/api/users?page=1",
              requestEventId: "req1",
              responseEventId: "res1",
              finishedEventId: "end1",
              request: { headers: {} },
              response: {
                status: 200,
                mimeType: "application/json",
                headers: {},
              },
              result: { body: { value: '{"name":"A","count":2}' } },
            },
          ],
        },
      ],
    };
    const [entry] = buildOpenApi(catalog),
      operation = entry.document.paths["/api/users"].get;
    assert.equal(entry.document.openapi, "3.1.0");
    assert.equal(operation.parameters[0].name, "page");
    assert.equal(operation.parameters[0].required, undefined);
    assert.equal(
      operation.responses["200"].content["application/json"].schema.properties
        .count.type,
      "integer",
    );
    assert.equal(
      operation["x-logic-recorder-evidence"][0].requestEventId,
      "req1",
    );
    assert.equal(
      operation.responses["200"].content["application/json"].schema.required,
      undefined,
    );
  });
  it("整理多种内容类型、重复表单字段及不同响应样本", () => {
    const call = (
      id,
      requestMime,
      requestBody,
      responseMime,
      responseBody,
    ) => ({
      url: "https://example.test/api/orders",
      requestEventId: `req-${id}`,
      finishedEventId: `end-${id}`,
      request: {
        headers: { "Content-Type": requestMime },
        postData: { value: requestBody },
      },
      response: { status: 200, headers: { "Content-Type": responseMime } },
      result: { body: { value: responseBody } },
    });
    const catalog = {
      endpoints: [
        {
          method: "POST",
          path: "https://example.test/api/orders",
          samples: [
            call(
              1,
              "application/x-www-form-urlencoded",
              "name=A&tag=x&tag=y",
              "application/json",
              '{"order":"A","items":[{"a":1},{"b":true}]}',
            ),
            call(
              2,
              "application/json",
              '{"count":2}',
              "application/json",
              '{"total":2,"order":null}',
            ),
            call(3, "text/plain", "hello", "text/plain", "ok"),
          ],
        },
      ],
    };
    const operation =
      buildOpenApi(catalog)[0].document.paths["/api/orders"].post;
    const form =
      operation.requestBody.content["application/x-www-form-urlencoded"];
    assert.deepEqual(form.examples.sample_1.value.tag, ["x", "y"]);
    assert.equal(form.schema.properties.tag.type, "array");
    assert.equal(form.examples.sample_1["x-logic-recorder-event-id"], "req-1");
    assert.ok(operation.requestBody.content["application/json"]);
    assert.ok(operation.requestBody.content["text/plain"]);
    const json = operation.responses["200"].content["application/json"];
    assert.equal(json["x-logic-recorder-observed-samples"], 2);
    assert.deepEqual(
      json.schema.properties.order.anyOf.map((item) => item.type),
      ["string", "null"],
    );
    assert.equal(json.schema.properties.total.type, "integer");
    assert.ok(json.schema.properties.items.items.properties.a);
    assert.ok(json.schema.properties.items.items.properties.b);
    assert.equal(json.examples.sample_2["x-logic-recorder-event-id"], "end-2");
    assert.equal(
      operation.responses["200"].content["text/plain"].examples.sample_1.value,
      "ok",
    );
    assert.equal(json.schema.required, undefined);
  });
  it("限制规范中的示例数量并标明省略数量", () => {
    const sample = {
      url: "https://example.test/api",
      request: { headers: {} },
      response: { status: 200, mimeType: "text/plain", headers: {} },
      result: { body: { value: "ok" } },
    };
    const doc = buildOpenApi({
      endpoints: [
        {
          method: "GET",
          path: sample.url,
          samples: Array.from({ length: 22 }, () => sample),
        },
      ],
    })[0].document;
    const media = doc.paths["/api"].get.responses["200"].content["text/plain"];
    assert.equal(Object.keys(media.examples).length, 20);
    assert.equal(media["x-logic-recorder-observed-samples"], 22);
    assert.equal(media["x-logic-recorder-omitted-examples"], 2);
  });
  it("异常内容类型和非文本主体不会使规范导出失败", () => {
    const sample = {
      url: "https://example.test/api",
      request: {
        headers: { "Content-Type": 123 },
        postData: { value: { unexpected: true } },
      },
      response: { status: 200, headers: { "Content-Type": null } },
      result: { body: { value: null } },
    };
    const doc = buildOpenApi({
      endpoints: [{ method: "POST", path: sample.url, samples: [sample] }],
    })[0].document;
    assert.equal(doc.paths["/api"].post.requestBody, undefined);
    assert.ok(doc.paths["/api"].post.responses["200"]);
    sample.response.mimeType = "not-a-media-type";
    sample.result.body.value = "response";
    const media = buildOpenApi({
      endpoints: [{ method: "POST", path: sample.url, samples: [sample] }],
    })[0].document.paths["/api"].post.responses["200"].content;
    assert.ok(media["application/octet-stream"]);
  });
});
