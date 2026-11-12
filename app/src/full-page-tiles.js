export function planFullPageTiles(width, height, dpr, maxPixelEdge = 4096) {
  if (![width, height, dpr, maxPixelEdge].every((value) => Number.isFinite(value) && value > 0))
    throw new Error("页面分片尺寸无效");
  const edge = Math.floor(maxPixelEdge / dpr);
  if (edge < 1) throw new Error("设备像素比超过分片能力");
  const columns = Math.ceil(width / edge), rows = Math.ceil(height / edge);
  if (!Number.isSafeInteger(columns * rows)) throw new Error("页面分片数量超出可表示范围");
  return { columns, rows, total: columns * rows, edge,
    tile(index) {
      if (!Number.isSafeInteger(index) || index < 0 || index >= columns * rows) throw new Error("页面分片序号无效");
      const x = (index % columns) * edge, y = Math.floor(index / columns) * edge;
      return { x, y, width: Math.min(edge, width - x), height: Math.min(edge, height - y) };
    } };
}
