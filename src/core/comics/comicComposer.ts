import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import sharp, { type OverlayOptions } from "sharp";
import { ComicJobStore, type ComicOwner } from "./comicJobStore";
import type { ComicDeliveryScene, ComicJob, ComicJobArtifacts, ComicPanel } from "./comicTypes";

const PAGE_MARGIN = 40;
const PAGE_HEADER = 86;
const CELL_GAP = 28;
const CELL_WIDTH = 760;
const IMAGE_HEIGHT = 650;
const TEXT_HEIGHT = 190;
const CELL_HEIGHT = IMAGE_HEIGHT + TEXT_HEIGHT;

export interface ComicComposerConfig {
  uploadDir: string;
  /** 仅供修复/重排既有本地成品；正常 comic_compose 保持幂等复用。 */
  force?: boolean;
}

function xml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&apos;",
  })[char]!);
}

function codePoints(value: string): string[] {
  return Array.from(value.replace(/\s+/g, " ").trim());
}

function wrap(value: string, limit: number, maxLines: number): string[] {
  const input = codePoints(value);
  const lines: string[] = [];
  while (input.length && lines.length < maxLines) lines.push(input.splice(0, limit).join(""));
  if (input.length && lines.length) lines[lines.length - 1] = `${lines[lines.length - 1]!.slice(0, Math.max(1, limit - 1))}…`;
  return lines;
}

function panelText(panel: ComicPanel, cellWidth: number): { title: string; lines: string[] } {
  const title = panel.caption || `第 ${panel.number} 格 · ${panel.beat}`;
  const blocks = [
    ...(panel.narration ? [`旁白：${panel.narration}`] : []),
    ...panel.dialogue.map((line) => `${line.speaker}：${line.text}`),
  ];
  const lineLength = Math.max(24, Math.min(72, Math.floor(34 * (cellWidth / CELL_WIDTH))));
  const lines = blocks.flatMap((block) => wrap(block, lineLength, 2)).slice(0, 5);
  return { title, lines };
}

function compactSceneText(panel: ComicPanel): string {
  const lines = [
    ...(panel.narration ? [`旁白：${panel.narration.trim()}`] : []),
    ...panel.dialogue.map((line) => `${line.speaker.trim()}：${line.text.trim()}`),
  ].filter(Boolean);
  // 无对白格也要有一条能与图片配对的幕文字；action 是已冻结分镜的一句话，
  // 比把整段 visualDescription 回灌给用户更轻、更自然。
  return lines.length ? lines.join("\n") : panel.action.trim();
}

export function buildComicDeliveryScenes(job: ComicJob): ComicDeliveryScene[] {
  return job.panels.map((panel) => {
    if (!panel.asset) throw new Error(`第 ${panel.number} 格缺少图片资产`);
    const label = (panel.caption || panel.beat).trim();
    return {
      panelNumber: panel.number,
      title: `第 ${panel.number} 幕 · ${label}`,
      text: compactSceneText(panel),
      image: {
        url: panel.asset.url,
        width: panel.asset.width,
        height: panel.asset.height,
      },
    };
  });
}

function markdownAlt(value: string): string {
  return value.replace(/[\]\\]/g, " ").replace(/\s+/g, " ").trim();
}

/** 由确定性分镜数据生成，Main 无需自己重新组织六张图。 */
export function comicDeliveryMarkdown(scenes: ComicDeliveryScene[]): string {
  return scenes.map((scene) => [
    `### ${scene.title}`,
    scene.text,
    `![${markdownAlt(scene.title)}](${scene.image.url})`,
  ].filter(Boolean).join("\n\n")).join("\n\n");
}

async function renderCell(panel: ComicPanel, cellWidth = CELL_WIDTH): Promise<Buffer> {
  if (!panel.asset) throw new Error(`第 ${panel.number} 格缺少图片资产`);
  const image = await sharp(panel.asset.path)
    .resize({ width: cellWidth, height: IMAGE_HEIGHT, fit: "contain", background: "#17151c" })
    .png()
    .toBuffer();
  const { title, lines } = panelText(panel, cellWidth);
  const textSvg = `
    <svg width="${cellWidth}" height="${TEXT_HEIGHT}" xmlns="http://www.w3.org/2000/svg">
      <rect width="100%" height="100%" fill="#fffdf9"/>
      <text x="24" y="40" font-family="Noto Sans CJK SC, Microsoft YaHei, sans-serif" font-size="26" font-weight="700" fill="#2b2330">${xml(title)}</text>
      ${lines.map((line, index) => `<text x="24" y="${82 + index * 25}" font-family="Noto Sans CJK SC, Microsoft YaHei, sans-serif" font-size="20" fill="#554959">${xml(line)}</text>`).join("\n")}
    </svg>`;
  return sharp({
    create: { width: cellWidth, height: CELL_HEIGHT, channels: 4, background: "#fffdf9" },
  }).composite([
    { input: image, left: 0, top: 0 },
    { input: Buffer.from(textSvg), left: 0, top: IMAGE_HEIGHT },
    { input: Buffer.from(`<svg width="${cellWidth}" height="${CELL_HEIGHT}" xmlns="http://www.w3.org/2000/svg"><rect x="1" y="1" width="${cellWidth - 2}" height="${CELL_HEIGHT - 2}" rx="10" fill="none" stroke="#cfc4d2" stroke-width="2"/></svg>`) },
  ]).png().toBuffer();
}

async function atomicWrite(file: string, bytes: Buffer | string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  await fs.writeFile(temp, bytes, { flag: "wx" });
  try {
    await fs.rename(temp, file);
  } finally {
    await fs.unlink(temp).catch(() => undefined);
  }
}

async function renderPage(job: ComicJob, panels: ComicPanel[], pageNumber: number, outputDir: string): Promise<ComicJobArtifacts["pages"][number]> {
  const columns = Math.min(job.layout.columns, panels.length);
  const gridWidth = columns * CELL_WIDTH + (columns - 1) * CELL_GAP;
  const rows: Array<{ panels: ComicPanel[]; fullWidth: boolean }> = [];
  let pending: ComicPanel[] = [];
  const flushPending = () => {
    if (!pending.length) return;
    rows.push({ panels: pending, fullWidth: false });
    pending = [];
  };
  for (const panel of panels) {
    // emphasis=3 是页面的转折/高潮：独占一整行，真正影响阅读节奏而非只留在元数据里。
    if (panel.emphasis === 3 && columns > 1) {
      flushPending();
      rows.push({ panels: [panel], fullWidth: true });
      continue;
    }
    pending.push(panel);
    if (pending.length === columns) flushPending();
  }
  flushPending();
  const width = PAGE_MARGIN * 2 + gridWidth;
  const height = PAGE_MARGIN * 2 + PAGE_HEADER + rows.length * CELL_HEIGHT + (rows.length - 1) * CELL_GAP;
  const placements: Array<{ panel: ComicPanel; width: number; left: number; top: number }> = [];
  rows.forEach((row, rowIndex) => {
    if (row.fullWidth) {
      placements.push({ panel: row.panels[0]!, width: gridWidth, left: PAGE_MARGIN, top: PAGE_MARGIN + PAGE_HEADER + rowIndex * (CELL_HEIGHT + CELL_GAP) });
      return;
    }
    row.panels.forEach((panel, rawColumn) => {
      // 不完整的普通行也平均铺满整行。否则「一格普通 + 下一格 emphasis=3 独占行」
      // 会让前一格旁边留下整列空白；奇数尾格也会显得像漏图。
      const rowColumns = row.panels.length;
      const cellWidth = Math.floor((gridWidth - (rowColumns - 1) * CELL_GAP) / rowColumns);
      const column = job.readingDirection === "rtl" ? rowColumns - rawColumn - 1 : rawColumn;
      placements.push({
        panel,
        width: cellWidth,
        left: PAGE_MARGIN + column * (cellWidth + CELL_GAP),
        top: PAGE_MARGIN + PAGE_HEADER + rowIndex * (CELL_HEIGHT + CELL_GAP),
      });
    });
  });
  const rendered = await Promise.all(placements.map((placement) => renderCell(placement.panel, placement.width)));
  const composites: OverlayOptions[] = placements.map((placement, index) => ({
    input: rendered[index]!,
    left: placement.left,
    top: placement.top,
  }));
  const header = Buffer.from(`<svg width="${width}" height="${PAGE_HEADER}" xmlns="http://www.w3.org/2000/svg"><text x="${PAGE_MARGIN}" y="52" font-family="Noto Sans CJK SC, Microsoft YaHei, sans-serif" font-size="34" font-weight="700" fill="#2b2330">${xml(job.title)} · ${pageNumber}</text><text x="${width - PAGE_MARGIN}" y="50" text-anchor="end" font-family="Noto Sans CJK SC, Microsoft YaHei, sans-serif" font-size="18" fill="#817487">${job.readingDirection === "rtl" ? "← RTL" : "LTR →"}</text></svg>`);
  const bytes = await sharp({ create: { width, height, channels: 4, background: "#f5f0f6" } })
    .composite([{ input: header, left: 0, top: PAGE_MARGIN }, ...composites])
    .png({ compressionLevel: 9 })
    .toBuffer();
  const fileName = `page-${String(pageNumber).padStart(3, "0")}.png`;
  const file = path.join(outputDir, fileName);
  await atomicWrite(file, bytes);
  return {
    path: file,
    url: `/uploads/comics/${job.id}/pages/${fileName}`,
    width,
    height,
    panelNumbers: panels.map((panel) => panel.number),
  };
}

export async function composeComicJob(
  store: ComicJobStore,
  owner: ComicOwner,
  jobId: string,
  config: ComicComposerConfig
): Promise<ComicJobArtifacts> {
  const job = await store.get(owner, jobId);
  if (job.status === "completed" && job.artifacts && !config.force) {
    if (job.artifacts.scenes?.length === job.panels.length) return job.artifacts;
    // 旧漫画无需重新渲染长页；只从已有 Panel 元数据补出逐幕交付索引。
    const upgraded = { ...job.artifacts, scenes: buildComicDeliveryScenes(job) };
    await store.setArtifacts(owner, job.id, upgraded);
    return upgraded;
  }
  if (!job.panels.every((panel) => panel.status === "completed" && panel.asset)) {
    throw new Error("漫画仍有未完成 Panel，不能排版");
  }
  const projectDir = path.join(path.resolve(config.uploadDir), "comics", job.id);
  const pagesDir = path.join(projectDir, "pages");
  await fs.mkdir(pagesDir, { recursive: true });
  const pages: ComicJobArtifacts["pages"] = [];
  for (let index = 0; index < job.panels.length; index += job.layout.panelsPerPage) {
    pages.push(await renderPage(job, job.panels.slice(index, index + job.layout.panelsPerPage), pages.length + 1, pagesDir));
  }
  const scenes = buildComicDeliveryScenes(job);
  const manifestValue = {
    schemaVersion: 1,
    jobId: job.id,
    title: job.title,
    premise: job.premise,
    readingDirection: job.readingDirection,
    contentRating: job.contentRating,
    language: job.language,
    bible: job.bible,
    pages: pages.map((page) => ({ url: page.url, panelNumbers: page.panelNumbers })),
    scenes,
    panels: job.panels.map((panel) => ({
      number: panel.number,
      beat: panel.beat,
      transition: panel.transition,
      shot: panel.shot,
      angle: panel.angle,
      focalPoint: panel.focalPoint,
      action: panel.action,
      emotion: panel.emotion,
      visualDescription: panel.visualDescription,
      characters: panel.characters,
      continuity: panel.continuity,
      emphasis: panel.emphasis,
      caption: panel.caption ?? "",
      narration: panel.narration ?? "",
      dialogue: panel.dialogue,
      image: panel.asset!.url,
      sha256: panel.asset!.sha256,
    })),
    visibleSpentAnlas: job.budget.visibleSpentAnlas,
  };
  const manifestBody = `${JSON.stringify(manifestValue, null, 2)}\n`;
  const manifestPath = path.join(projectDir, "manifest.json");
  await atomicWrite(manifestPath, manifestBody);

  const artifacts: ComicJobArtifacts = {
    pages,
    manifest: { path: manifestPath, url: `/uploads/comics/${job.id}/manifest.json` },
    scenes,
  };
  await store.setArtifacts(owner, job.id, artifacts);
  return artifacts;
}
