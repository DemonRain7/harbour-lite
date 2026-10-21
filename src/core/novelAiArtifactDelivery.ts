import { execFile } from "node:child_process";
import { realpath, stat, unlink } from "node:fs/promises";
import { harbourBrowserHome } from "./storagePaths";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_IMPORT_STDOUT = 1024 * 1024;
const PROJECT_ROOT = path.resolve(__dirname, "..", "..");

export interface PublishedNovelAiArtifact {
  path: string;
  url: string;
  collection: string;
  characters: string[];
  name: string;
  size: number;
}

export interface NovelAiDeliveryResult {
  attempted: boolean;
  artifacts: PublishedNovelAiArtifact[];
  error?: string;
  failureKind?: "resolution_mismatch";
  expectedResolution?: { width: number; height: number };
  observedDimensions?: string[];
}

export function inferNovelAiExpectedResolution(input: string): { width: number; height: number } | null {
  // 明确字段优先；“必须验签目标分辨率原图”之类说明不能遮住后面的真实尺寸。
  const declared = [...input.matchAll(/^\s*(?:resolution|分辨率)\s*[:：][^\r\n]{0,200}/gmi)]
    .map((match) => match[0]);
  const mentions = [...input.matchAll(/(?:resolution|分辨率)[^\r\n]{0,160}/gi)].map((match) => match[0]);
  const lines = [...declared, ...mentions];
  for (const line of lines) {
    const explicit = /(\d{3,4})\s*[x×X]\s*(\d{3,4})/.exec(line);
    if (explicit) return { width: Number(explicit[1]), height: Number(explicit[2]) };
  }

  const structured = /["']?width["']?\s*:\s*(\d{2,4})[\s\S]{0,160}?["']?height["']?\s*:\s*(\d{2,4})/i.exec(input);
  if (structured) return { width: Number(structured[1]), height: Number(structured[2]) };

  for (const line of lines) {
    if (!/\bnormal\b/i.test(line)) continue;
    if (/(?:portrait|竖版|竖构图|人物立绘)/i.test(line)) return { width: 832, height: 1216 };
    if (/(?:landscape|横版|横构图)/i.test(line)) return { width: 1216, height: 832 };
    if (/(?:square|方形|正方形)/i.test(line)) return { width: 1024, height: 1024 };
  }
  return null;
}

export function novelAiResolutionMismatches(
  expected: { width: number; height: number } | null,
  artifacts: Array<{ width: number; height: number }>
): string[] {
  if (!expected) return [];
  return [...new Set(artifacts
    .filter((artifact) => artifact.width !== expected.width || artifact.height !== expected.height)
    .map((artifact) => `${artifact.width}x${artifact.height}`))];
}

export function browserDownloadRoot(): string {
  return path.join(harbourBrowserHome(), "downloads");
}

function pathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function novelAiTask(input: string): boolean {
  return /(?:\bNovelAI\b|\bNAI\s+Diffusion\b|\bAnlas\b)/i.test(input);
}

/**
 * Browser Controller 的 NovelAI 委派正文已经包含 Character 1..N 与 onceKey。这里仅抽取
 * 落盘路由，不把整份提示词重新交给模型，也不要求 Main 再记住一次导入脚本调用。
 */
export function inferNovelAiDeliveryMetadata(input: string): { slug: string; characters: string[] } | null {
  if (!novelAiTask(input)) return null;

  const numberedCharacters = [...input.matchAll(
    /^Character\s+\d+\s*[—–-]\s*([^\r\n(（:：]{1,120}?)(?=\s*(?:\(|（|:|：|$))/gmi
  )]
    .map((match) => match[1]?.trim() ?? "")
    .filter(Boolean);
  const promptHeaderCharacters = [...input.matchAll(
    /^Character\s+Prompt\s*[—–-]\s*([^\r\n:：]{1,120}?)\s*[:：]\s*$/gmi
  )]
    .map((match) => match[1]?.trim() ?? "")
    .filter(Boolean);
  let structuredCharacters: string[] = [];
  const structuredMatch = /["']?characterNames["']?\s*:\s*(\[[\s\S]{1,1000}?\])/i.exec(input)?.[1];
  if (structuredMatch) {
    try {
      const parsed = JSON.parse(structuredMatch) as unknown;
      if (Array.isArray(parsed)) {
        structuredCharacters = parsed
          .filter((item): item is string => typeof item === "string")
          .map((item) => item.trim())
          .filter((item) => item.length > 0 && item.length <= 120);
      }
    } catch {
      // 非 JSON 的展示文本继续走标题兼容解析；不能因为落盘元数据失败影响已生成成品。
    }
  }
  const characters = structuredCharacters.length
    ? structuredCharacters
    : [...numberedCharacters, ...promptHeaderCharacters];
  const uniqueCharacters = [...new Set(characters)];
  const onceKey = /^onceKey\s*:\s*([A-Za-z0-9][A-Za-z0-9:_-]{0,99})\s*$/mi.exec(input)?.[1];
  const slug = onceKey || (uniqueCharacters.length ? uniqueCharacters.join("-") : "novelai-result");

  return {
    slug,
    // import-artifact 要求至少一个路由项；缺少具名角色时进入 original，而不是猜角色。
    characters: uniqueCharacters.length ? uniqueCharacters : ["original"],
  };
}

async function validateBrowserArtifact(rawSource: string): Promise<{ source: string; width: number; height: number }> {
  if (!path.isAbsolute(rawSource)) throw new Error("Controller artifact 不是绝对路径");
  const [root, source] = await Promise.all([
    realpath(browserDownloadRoot()),
    realpath(path.resolve(rawSource)),
  ]);
  if (!pathInside(root, source)) {
    throw new Error("Controller artifact 不在 Harbour Browser 受控下载目录内");
  }
  const info = await stat(source);
  if (!info.isFile() || info.size <= 0) throw new Error("Controller artifact 不是有效文件");
  const sharp = (await import("sharp")).default;
  const metadata = await sharp(source, { animated: false, limitInputPixels: 50_000_000 }).metadata();
  const width = Number(metadata.width);
  const height = Number(metadata.height);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error("Controller artifact 无法解码出有效像素尺寸");
  }
  return { source, width, height };
}

function parseImportOutput(stdout: string): PublishedNovelAiArtifact {
  const line = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
  if (!line) throw new Error("NovelAI 导入脚本没有返回结果");
  const parsed = JSON.parse(line) as Record<string, unknown>;
  if (parsed.ok !== true || typeof parsed.path !== "string" || typeof parsed.url !== "string" ||
      typeof parsed.collection !== "string" || !Array.isArray(parsed.characters) ||
      typeof parsed.name !== "string" || typeof parsed.size !== "number") {
    throw new Error(`NovelAI 导入脚本回执无效：${line.slice(0, 500)}`);
  }
  return {
    path: parsed.path,
    url: parsed.url,
    collection: parsed.collection,
    characters: parsed.characters.filter((item): item is string => typeof item === "string"),
    name: parsed.name,
    size: parsed.size,
  };
}

/**
 * Main 直接委派与 novelai-image-set Workflow 共用这条导入边界。comic_generator
 * 仍把原 artifact 交给 comic job，不会在 novelai/ 与 comics/ 各复制一份。
 */
export async function publishNovelAiArtifacts(
  input: string,
  artifacts: string[],
  options: { preserveSources?: boolean; idempotencyKey?: string } = {},
): Promise<NovelAiDeliveryResult> {
  const metadata = inferNovelAiDeliveryMetadata(input);
  if (!metadata || !artifacts.length) return { attempted: false, artifacts: [] };

  const script = path.join(PROJECT_ROOT, "workflows", "novelai-generation", "scripts", "import-artifact.mjs");
  const published: PublishedNovelAiArtifact[] = [];
  try {
    // 先完整验收整批，再写 canonical uploads。这样第二张是缩略图时不会留下“半批已导入”。
    const validated = await Promise.all(artifacts.map(validateBrowserArtifact));
    const expectedResolution = inferNovelAiExpectedResolution(input);
    const observedDimensions = novelAiResolutionMismatches(expectedResolution, validated);
    if (expectedResolution && observedDimensions.length) {
      return {
        attempted: true,
        artifacts: [],
        failureKind: "resolution_mismatch",
        expectedResolution,
        observedDimensions,
        error: `拒绝交付 NovelAI 页面预览图：expected=${expectedResolution.width}x${expectedResolution.height}, actual=${observedDimensions.join("、")}`,
      };
    }
    for (const artifact of validated) {
      const source = artifact.source;
      const { stdout } = await execFileAsync(process.execPath, [
        script,
        "--source", source,
        "--slug", metadata.slug,
        "--characters", metadata.characters.join(","),
        ...(options.idempotencyKey ? ["--idempotency-key", options.idempotencyKey] : []),
      ], {
        cwd: PROJECT_ROOT,
        timeout: 30_000,
        windowsHide: true,
        maxBuffer: MAX_IMPORT_STDOUT,
      });
      published.push(parseImportOutput(stdout));
      // 导入脚本已按原字节验签写入 canonical uploads；Main 不再需要 Browser 临时副本。
      // comic_generator 不走此函数，因此它的 panel source 不受影响。
      if (!options.preserveSources) await unlink(source).catch(() => undefined);
    }
    return { attempted: true, artifacts: published };
  } catch (error) {
    return {
      attempted: true,
      artifacts: published,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Workflow 成品状态已持久化后，才回收受控下载副本；失败不影响 canonical 成品。 */
export async function discardPublishedNovelAiSources(artifacts: string[]): Promise<void> {
  for (const artifact of artifacts) {
    try {
      const { source } = await validateBrowserArtifact(artifact);
      await unlink(source);
    } catch {
      // 文件已清理或不在受控目录：不扩大删除范围，也不影响已保存的交付证据。
    }
  }
}
