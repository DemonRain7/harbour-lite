/* Artwork coordinates, not layout guesses. Shared by the real renderer and
 * pixel regressions; no image rewriting, network access or runtime detection. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.OrbPeekFrames = factory();
})(typeof window === "object" ? window : globalThis, function () {
  const edges = ["left", "right", "top", "bottom"];
  // The generated v5 source has its clean horizontal gutter at y=642, not
  // exactly half-height. A nominal 2x2 background cuts the upper hair tips.
  // Both blink states use the SAME explicit source rectangles.
  const layouts = {
    "aemeath-peek-v5.png": { width: 1254, height: 1254, splitX: 627, splitY: 642 },
    "aemeath-peek-blink-v5.png": { width: 1254, height: 1254, splitX: 627, splitY: 642 },
  };
  function frame(url, edge, width, height) {
    if (!edges.includes(edge) || !(width > 0 && height > 0)) return null;
    const name = String(url).split(/[\\/]/).at(-1)?.split(/[?#]/)[0];
    const layout = layouts[name];
    const known = layout?.width === width && layout?.height === height;
    const x = known ? layout.splitX : width / 2, y = known ? layout.splitY : height / 2;
    const right = edge === "right" || edge === "bottom", lower = edge === "top" || edge === "bottom";
    return { x: right ? x : 0, y: lower ? y : 0,
      width: right ? width - x : x, height: lower ? height - y : y };
  }
  function paint(url, edge, width, height, size) {
    const rect = frame(url, edge, width, height);
    if (!rect) return null;
    const scale = Math.min(size / rect.width, size / rect.height);
    const x = (size - rect.width * scale) / 2, y = (size - rect.height * scale) / 2;
    return { rect, style: {
      backgroundSize: `${width * scale}px ${height * scale}px`,
      backgroundPosition: `${x - rect.x * scale}px ${y - rect.y * scale}px`,
      // Letterboxing must not reveal a sliver of the adjacent atlas cell.
      clipPath: `inset(${y}px ${x}px)`,
    } };
  }
  return { frame, paint, layouts };
});
