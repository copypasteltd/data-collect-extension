export function createFieldSummary() {
  const samples = new Map(), fields = new Map();
  function sampleKey(row) {
    return JSON.stringify([row.source.endpoint?.method, row.source.endpoint?.url, row.source.direction]);
  }
  return {
    add(row) {
      if (!row.source?.endpoint || !row.source.direction) return;
      const group = sampleKey(row);
      if (row.kind === "sample") {
        const count = samples.get(group) || { total: 0, parsed: 0 };
        count.total++;
        if (["parsed_json", "parsed_form_urlencoded"].includes(row.status)) count.parsed++;
        samples.set(group, count);
      } else if (row.kind === "field") {
        const location = row.location.map((part) => Object.hasOwn(part, "key") ? { key: part.key } : { arrayItem: true });
        const key = JSON.stringify([group, location]);
        let field = fields.get(key);
        if (!field) {
          field = { endpoint: row.source.endpoint, direction: row.source.direction, location,
            occurrences: 0, observedSamples: 0, types: Object.create(null), lastEventId: null };
          fields.set(key, field);
        }
        field.occurrences++;
        field.types[row.type] = (field.types[row.type] || 0) + 1;
        if (field.lastEventId !== row.source.eventId) { field.observedSamples++; field.lastEventId = row.source.eventId; }
      }
    },
    *results() {
      for (const field of fields.values()) {
        const { lastEventId, ...result } = field;
        const group = JSON.stringify([field.endpoint.method, field.endpoint.url, field.direction]);
        yield { ...result, sampleCounts: samples.get(group) || { total: 0, parsed: 0 },
          typeConflict: Object.keys(field.types).length > 1, evidence: "fieldObservationChunks",
          note: "仅统计观察到的样本，不推断必填或未观察字段" };
      }
    },
  };
}
