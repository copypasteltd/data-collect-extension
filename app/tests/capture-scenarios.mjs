// Pure scenario catalog. Importing it does not launch processes or read fixtures.
export const CAPTURE_SCENARIOS = [
  ["combined", { TEST_LARGE_DOM: "1", TEST_LARGE_STORAGE: "1", TEST_DATABASE_GRAPH: "1", TEST_DATABASE_LARGE: "1",
    TEST_LARGE_REQUEST: "1", TEST_LARGE_RESPONSE: "1", TEST_FILE_CAPTURE: "1", TEST_CANVAS_MANY: "1", TEST_STYLE_CAPTURE: "1" }],
  ["frames-and-navigation", { TEST_FRAME_TREE: "1", TEST_BACKGROUND_PAGE: "1" }],
  ["restricted-frame", { TEST_FRAME_RESTRICTED: "1" }],
  ["dynamic-restricted-frame", { TEST_DYNAMIC_RESTRICTED_FRAME: "1" }],
  ["frame-injection-failure", { TEST_FRAME_TREE: "1", TEST_FRAME_INJECTION_FAILURE: "1" }],
  ["page-instances", { TEST_PAGE_INSTANCES: "1" }],
  ["large-select", { TEST_LARGE_SELECT: "1" }],
  ["dynamic-form-ime", { TEST_DYNAMIC_FORM: "1" }],
  ["scroll-containers", { TEST_SCROLL_MANY: "1" }],
  ["virtual-list-and-lazy", { TEST_VIRTUAL_LIST: "1" }],
  ["tainted-canvas", { TEST_CANVAS_TAINTED: "1" }],
  ["webgl-canvas", { TEST_CANVAS_WEBGL: "1" }],
  ["webgl-canvas-no-buffer", { TEST_CANVAS_WEBGL_NO_BUFFER: "1" }],
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
  ["network-text-fields", { TEST_TEXT_FIELDS: "1" }],
  ["network-xml-fields", { TEST_XML_FIELDS: "1" }],
  ["network-xml-limit", { TEST_XML_LIMIT: "1" }],
  ["network-realtime-large", { TEST_REALTIME_LARGE: "1" }],
  ["mutations", { TEST_MUTATION_BATCH: "1", TEST_RAW_MUTATION: "1" }],
  ["shadow-style", { TEST_SHADOW_STYLE: "1" }],
  ["pseudo-style", { TEST_PSEUDO_STYLE: "1" }],
  ["theme-switch-and-hover", { TEST_THEME_SWITCH: "1" }],
  ["interaction-descendant-limit", { TEST_INTERACTION_DESCENDANT_LIMIT: "1" }],
  ["computed-style-stress", { TEST_STYLE_STRESS: "1" }],
  ["full-page-dpr2", { TEST_FULL_PAGE: "1", TEST_PNG_PIXEL: "1", TEST_DEVICE_SCALE: "2" }],
  ["fixed-and-nested-scroll", { TEST_FIXED_NESTED: "1" }],
  ["full-page-tiles", { TEST_FULL_PAGE_TILED: "1" }],
  ["skill-reconstruction", { TEST_LARGE_DOM: "1", TEST_SKILL_RECONSTRUCT: "1" }],
  ["long-input-and-clicks", { TEST_LONG_INPUT: "1", TEST_FAST_CLICKS: "1" }],
];

export function createCapturePlan({ fontAvailable = false } = {}) {
  const scenarios = CAPTURE_SCENARIOS.map(([id, flags]) => ({ id, flags: { ...flags }, state: "pending" }));
  for (const [id, flags] of [["font", { TEST_FONT: "1" }], ["initial-resources", { TEST_INITIAL_RESOURCES: "1" }]])
    scenarios.push({ id, flags, state: fontAvailable ? "pending" : "skipped",
      ...(fontAvailable ? {} : { reason: "font_fixture_unavailable" }) });
  return scenarios;
}

export function summarizeCaptureResults(results, { interrupted = false, identityMatches = true, preflightFailed = false } = {}) {
  const counts = Object.create(null);
  for (const result of results) counts[result.status] = (counts[result.status] || 0) + 1;
  const complete = !interrupted && !preflightFailed && identityMatches && results.length > 0 &&
    results.some((result) => result.status === "passed") &&
    results.every((result) => ["passed", "skipped"].includes(result.status));
  return { status: !identityMatches ? "invalidated" : complete ? "completed" : "incomplete",
    passed: complete, counts: { ...counts } };
}
