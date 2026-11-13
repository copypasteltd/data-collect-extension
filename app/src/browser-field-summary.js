import { browserObservationEvidence, browserStorageNamespace } from "./browser-observations.js";

export function createBrowserFieldSummary() {
  const samples = new Map(), fields = new Map();
  const groupKey = (row, namespace) => JSON.stringify([namespace, row.database, row.store]);
  return {
    add(row) {
      if (row.domain !== "indexeddb") return;
      const source = browserObservationEvidence(row.source);
      if (!source.eventId) return;
      const namespace = browserStorageNamespace(source), group = groupKey(row, namespace);
      if (row.kind === "sample") {
        const count = samples.get(group) || { total: 0, available: 0 };
        count.total++;
        if (["captured", "fragmented"].includes(row.status)) count.available++;
        samples.set(group, count);
      } else if (row.kind === "field-path") {
        const key = JSON.stringify([group, row.location || row.path]);
        let field = fields.get(key);
        if (!field) {
          field = { schemaVersion: 2, namespace, database: row.database, store: row.store, path: row.path, location: row.location, occurrences: 0,
            types: Object.create(null), samples: new Set(), evidence: [] };
          fields.set(key, field);
        }
        field.occurrences++;
        field.types[row.type] = (field.types[row.type] || 0) + 1;
        const sampleKey = JSON.stringify([source.eventId, source.path, source.line]);
        if (!field.samples.has(sampleKey)) {
          field.samples.add(sampleKey);
          if (field.evidence.length < 3) field.evidence.push(source);
        }
      }
    },
    *results() {
      for (const field of fields.values()) {
        const { samples: sampleIds, ...result } = field;
        yield { ...result, observedSamples: sampleIds.size,
          sampleCounts: samples.get(groupKey(field, field.namespace)) || { total: 0, available: 0 },
          typeConflict: Object.keys(field.types).length > 1,
          note: "仅统计观察到的数据库记录，不推断必填或未观察字段" };
      }
    },
  };
}
