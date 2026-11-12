export function createBrowserFieldSummary() {
  const samples = new Map(), fields = new Map();
  const groupKey = (row) => JSON.stringify([row.database, row.store]);
  return {
    add(row) {
      if (row.domain !== "indexeddb" || !row.source?.eventId) return;
      const group = groupKey(row);
      if (row.kind === "sample") {
        const count = samples.get(group) || { total: 0, available: 0 };
        count.total++;
        if (["captured", "fragmented"].includes(row.status)) count.available++;
        samples.set(group, count);
      } else if (row.kind === "field-path") {
        const key = JSON.stringify([group, row.location || row.path]);
        let field = fields.get(key);
        if (!field) {
          field = { database: row.database, store: row.store, path: row.path, location: row.location, occurrences: 0,
            types: Object.create(null), samples: new Set(), evidence: [] };
          fields.set(key, field);
        }
        field.occurrences++;
        field.types[row.type] = (field.types[row.type] || 0) + 1;
        if (!field.samples.has(row.source.eventId)) {
          field.samples.add(row.source.eventId);
          if (field.evidence.length < 3) field.evidence.push(row.source);
        }
      }
    },
    *results() {
      for (const field of fields.values()) {
        const { samples: sampleIds, ...result } = field;
        yield { ...result, observedSamples: sampleIds.size,
          sampleCounts: samples.get(groupKey(field)) || { total: 0, available: 0 },
          typeConflict: Object.keys(field.types).length > 1,
          note: "仅统计观察到的数据库记录，不推断必填或未观察字段" };
      }
    },
  };
}
