const MAX_BYTES = 8000000;

export async function packComputedEntries(entries) {
  try {
    if (typeof CompressionStream !== "function") return { entries, packingStatus: "unavailable" };
    const json = JSON.stringify(entries), blob = new Blob([json], { type: "application/json" });
    if (blob.size > MAX_BYTES) return { entries };
    const stream = blob.stream().pipeThrough(new CompressionStream("gzip"));
    const compressed = new Uint8Array(await new Response(stream).arrayBuffer());
    const chunks = [];
    for (let offset = 0; offset < compressed.length; offset += 49152)
      chunks.push(String.fromCharCode(...compressed.subarray(offset, offset + 49152)));
    const data = btoa(chunks.join(""));
    if (data.length >= json.length) return { entries };
    return { entriesEncoding: "gzip-base64-json-v1", entriesData: data, entriesBytes: blob.size, entryCount: entries.length };
  } catch (error) {
    return { entries, packingStatus: "unavailable", packingReason: String(error) };
  }
}
