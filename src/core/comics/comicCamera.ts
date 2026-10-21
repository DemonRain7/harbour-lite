type CameraHeight = "eye" | "high" | "low";

const HEIGHTS: Readonly<Record<string, CameraHeight>> = {
  "eye-level": "eye", "high-angle": "high", "bird-eye": "high", "low-angle": "low", "worm-eye": "low",
};

/** Narrow input consistency check, NOT anatomy/occlusion or visual QA.
 * Only explicit angle names in the author's camera field count. Side/three-
 * quarter views are yaw, Dutch is roll, and POV/OTS are not camera heights.
 * Do not parse templates, rewrite prompts, or retroactively recompile jobs. */
export function comicCameraIssues(angle: unknown, camera: unknown): string[] {
  if (typeof camera !== "string") return [];
  const heights = new Set<CameraHeight>();
  for (const clause of camera.split(/[,;\n]|\bbut\b/i)) {
    const matches = clause.matchAll(/\b(eye[- ]level|high[- ]angle|low[- ]angle|bird(?:['’]s)?[- ]eye|worm(?:['’]s)?[- ]eye)\b/gi);
    for (const match of matches) {
      // Negative examples/avoidance are not positive camera instructions.
      const before = clause.slice(0, match.index);
      if (/\b(?:not|no|never|avoid|without|exclude|excluding|instead of|rather than)\b/i.test(before)) continue;
      const cue = match[1]!.toLowerCase().replace(/['’]s/g, "").replace(/ /g, "-");
      heights.add(HEIGHTS[cue]!);
    }
  }
  if (heights.size > 1) return ["同一画面包含互斥的显式俯仰机位；请保留一个机位，不会自动改写 Prompt"];
  const expected = typeof angle === "string" ? HEIGHTS[angle] : undefined;
  if (expected && heights.size === 1 && !heights.has(expected)) {
    return [`与分镜 angle=${angle} 的显式俯仰机位冲突；请由作者统一分镜与 camera`];
  }
  return [];
}
