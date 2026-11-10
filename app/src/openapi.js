function mergeSchema(left, right) {
  if (!left) return right;
  if (!right) return left;
  if (left.anyOf || right.anyOf || left.type !== right.type) {
    const variants = [];
    for (const variant of [
      ...(left.anyOf || [left]),
      ...(right.anyOf || [right]),
    ]) {
      const index = variants.findIndex((item) => item.type === variant.type);
      if (index < 0) variants.push(variant);
      else variants[index] = mergeSchema(variants[index], variant);
    }
    return variants.length === 1 ? variants[0] : { anyOf: variants };
  }
  if (left.type === "object") {
    const properties = new Map(Object.entries(left.properties || {}));
    for (const [key, value] of Object.entries(right.properties || {}))
      properties.set(key, mergeSchema(properties.get(key), value));
    return { type: "object", properties: Object.fromEntries(properties) };
  }
  if (left.type === "array") {
    const items = mergeSchema(left.items, right.items);
    return { type: "array", ...(items ? { items } : {}) };
  }
  return left.description ? left : right;
}

function schemaFrom(value, depth = 0) {
  if (depth > 6) return { description: "样本层级超过推断限制" };
  if (value === null) return { type: "null" };
  if (Array.isArray(value))
    return {
      type: "array",
      ...(value.length
        ? {
            items: value
              .slice(0, 50)
              .reduce(
                (schema, item) =>
                  mergeSchema(schema, schemaFrom(item, depth + 1)),
                undefined,
              ),
          }
        : {}),
    };
  if (typeof value === "object")
    return {
      type: "object",
      properties: Object.fromEntries(
        Object.entries(value)
          .slice(0, 200)
          .map(([key, item]) => [key, schemaFrom(item, depth + 1)]),
      ),
    };
  if (typeof value === "number")
    return { type: Number.isInteger(value) ? "integer" : "number" };
  if (typeof value === "boolean") return { type: "boolean" };
  return value === "[已隐藏]"
    ? { type: "string", description: "样本值已隐藏" }
    : { type: "string" };
}
function contentType(headers, fallback = "application/json") {
  const raw = Object.entries(headers || {}).find(
    ([key]) => key.toLowerCase() === "content-type",
  )?.[1];
  const value =
    typeof raw === "string" ? raw.split(";")[0].trim().toLowerCase() : "";
  return value &&
    /^[a-z0-9!#$%&'*+.^_`|~-]+\/[a-z0-9!#$%&'*+.^_`|~-]+$/.test(value)
    ? value
    : fallback;
}
function sampleContent(content, mime) {
  if (typeof content?.value !== "string") return null;
  const raw = content.value;
  if (/json/i.test(mime)) {
    try {
      const value = JSON.parse(raw);
      return { schema: schemaFrom(value), example: value };
    } catch {
      return null;
    }
  }
  if (mime === "application/x-www-form-urlencoded") {
    const fields = new Map();
    for (const [name, value] of new URLSearchParams(raw)) {
      const values = fields.get(name) || [];
      values.push(value);
      fields.set(name, values);
    }
    const value = Object.fromEntries(
      [...fields].map(([name, values]) => [
        name,
        values.length === 1 ? values[0] : values,
      ]),
    );
    return { schema: schemaFrom(value), example: value };
  }
  return { schema: { type: "string" }, example: raw };
}
function addSample(content, mime, sample, eventId) {
  const media = (content[mime] ||= {
    schema: sample.schema,
    examples: {},
    "x-logic-recorder-observed-samples": 0,
  });
  media.schema = mergeSchema(media.schema, sample.schema);
  const count = ++media["x-logic-recorder-observed-samples"];
  if (count <= 20)
    media.examples[`sample_${count}`] = {
      value: sample.example,
      ...(eventId ? { "x-logic-recorder-event-id": eventId } : {}),
    };
  else media["x-logic-recorder-omitted-examples"] = count - 20;
}
export function buildOpenApi(catalog) {
  const docs = new Map();
  for (const endpoint of catalog.endpoints) {
    let url;
    try {
      url = new URL(endpoint.path);
    } catch {
      continue;
    }
    const method = String(endpoint.method || "").toLowerCase();
    if (
      ![
        "get",
        "put",
        "post",
        "delete",
        "options",
        "head",
        "patch",
        "trace",
      ].includes(method)
    )
      continue;
    let doc = docs.get(url.origin);
    if (!doc) {
      doc = {
        openapi: "3.1.0",
        info: {
          title: `${url.origin} 已观察接口`,
          version: "0.1.0",
          description:
            "根据录制样本生成的草稿，不代表完整接口契约。字段类型、参数和响应需要人工验证。",
        },
        servers: [{ url: url.origin }],
        paths: {},
      };
      docs.set(url.origin, doc);
    }
    const operation = {
      description:
        "仅反映录制中观察到的样本；不推断必填项、身份认证或未观察到的响应。",
      parameters: [],
      responses: {},
      "x-logic-recorder-evidence": [],
    };
    const parameters = new Map();
    for (const call of endpoint.samples) {
      operation["x-logic-recorder-evidence"].push({
        requestEventId: call.requestEventId,
        ...(call.requestBodyEventId
          ? { requestBodyEventId: call.requestBodyEventId }
          : {}),
        responseEventId: call.responseEventId,
        finishedEventId: call.finishedEventId,
      });
      try {
        for (const [name, value] of new URL(call.url).searchParams)
          if (!parameters.has(name))
            parameters.set(name, {
              name,
              in: "query",
              description: "是否必填尚未确认",
              schema: { type: "string" },
              example: value,
            });
      } catch {}
      const requestMime = contentType(call.request?.headers, "text/plain");
      const request = sampleContent(call.request?.postData, requestMime);
      if (request) {
        operation.requestBody ||= {
          description: "是否必填尚未确认",
          content: {},
        };
        addSample(
          operation.requestBody.content,
          requestMime,
          request,
          call.requestBodyEventId || call.requestEventId,
        );
      }
      const status = call.response?.status
        ? String(call.response.status)
        : "default";
      const response = (operation.responses[status] ||= {
        description: call.response?.status
          ? `观察到 HTTP ${status}`
          : "未观察到完整响应",
      });
      const responseMime = contentType(
        call.response?.headers,
        call.response?.mimeType || "application/octet-stream",
      );
      const sample = sampleContent(call.result?.body, responseMime);
      if (sample) {
        response.content ||= {};
        addSample(response.content, responseMime, sample, call.finishedEventId);
      }
    }
    operation.parameters = [...parameters.values()];
    if (!Object.keys(operation.responses).length)
      operation.responses.default = { description: "未观察到完整响应" };
    (doc.paths[url.pathname] ||= {})[method] = operation;
  }
  return [...docs.entries()].map(([origin, document]) => ({
    origin,
    document,
  }));
}
