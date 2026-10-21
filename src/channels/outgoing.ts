import type { Attachment, AttachmentKind } from "../types";

/**
 * 出站多模态 seam —— 让 Harbour 也能「发」图片/视频/语音/文件给用户。
 *
 * agent 的最终回答是一段文本。约定：文本里只要出现
 *   - Markdown 图片： ![alt](路径或URL)
 *   - 裸引用：       /uploads/xxx.png 、 assets/yyy.png 、 https://.../z.mp3
 * 且扩展名是已知媒体类型，就把它抽成 Attachment，渠道据此真正发出去
 *（Discord 作为文件附件；web 在气泡内渲染）。其余文本原样保留。
 *
 * 这是「适配层」：当前靠工具产出文件 + agent 在回答里引用其路径即可触发；
 * 真正的「模型直接生成图片/语音」待接入（届时在工具侧产出文件再走这套即可）。
 */

const MEDIA_EXT: Record<string, AttachmentKind> = {
  png: "image", jpg: "image", jpeg: "image", webp: "image", gif: "image",
  webm: "audio", ogg: "audio", mp3: "audio", wav: "audio", m4a: "audio",
  mp4: "video", mov: "video", m4v: "video", mkv: "video", avi: "video",
  pdf: "file", txt: "file", md: "file", json: "file", csv: "file", log: "file", zip: "file",
};

function kindOf(ref: string): AttachmentKind | null {
  if (/\.video\.webm(?:[?#].*)?$/i.test(ref)) return "video";
  const m = ref.toLowerCase().match(/\.([a-z0-9]+)(?:[?#].*)?$/);
  if (!m) return null;
  return MEDIA_EXT[m[1]!] ?? null;
}

function toAttachment(ref: string): Attachment | null {
  const kind = kindOf(ref);
  if (!kind) return null;
  const name = ref.split(/[\\/]/).pop()?.split(/[?#]/)[0] || "attachment";
  const isUrl = /^https?:\/\//i.test(ref);
  const isWebPath = ref.startsWith("/uploads/");
  return {
    kind,
    url: isUrl || isWebPath ? ref : "",
    ...(isUrl || isWebPath ? {} : { path: ref.replace(/^\.\//, "") }),
    mime: "application/octet-stream",
    name,
  };
}

/**
 * 模型常把媒体路径放进粗体，或紧跟在中文标点后面，例如：
 *   **🗝️ /uploads/novelai/result.png**。
 * 抽取候选时允许这种自然排版，但不能把 Markdown/句末标点并进文件名。
 */
function cleanMediaRef(raw: string): string {
  let value = raw.trim();
  let previous = "";
  while (value !== previous) {
    previous = value;
    value = value
      .replace(/[，。；;：:！？!?、]+$/u, "")
      .replace(/[*_~`]+$/, "");
  }
  return value;
}

/**
 * 从 agent 回答里抽出站附件。返回去重后的附件列表 + 原文本（文本不删，避免丢上下文）。
 */
export function extractOutgoing(text: string): { text: string; attachments: Attachment[] } {
  const found = new Map<string, Attachment>();
  const push = (raw: string) => {
    const ref = cleanMediaRef(raw);
    const att = toAttachment(ref);
    if (att) found.set(ref, att);
  };

  // 1) Markdown 图片/链接 ![..](ref) 与 [..](ref)
  for (const m of text.matchAll(/!?\[[^\]]*\]\(([^)\s]+)\)/g)) push(m[1]!);
  // 2) 裸引用：/uploads/、assets/、http(s) 且带已知媒体扩展名。
  // 不要求前面必须有空格；中文常写成“成图：/uploads/x.png”。
  for (const m of text.matchAll(/((?:\/uploads\/|\.?assets\/|https?:\/\/)[^\s)<>"']+)/gi)) push(m[1]!);

  return { text, attachments: [...found.values()] };
}

export interface OutgoingSegment {
  text: string;
  attachments: Attachment[];
}

function attachmentKey(attachment: Attachment): string {
  return attachment.path || attachment.url || attachment.name;
}

/**
 * 多张 Markdown 图片按原文位置拆成“文字 + 单图”片段。Web 仍保留原 Markdown；
 * QQ/Discord 用此顺序逐幕发送，避免六段标题先发完、六张图再堆到末尾。
 * 单张 Markdown 图前后都有文字时也拆分，避免尾注跑到实际图片之前；
 * 其余单图及裸路径保持原有一次发送行为，不扩大普通回复的消息数。
 */
export function extractOutgoingSegments(text: string): OutgoingSegment[] {
  const fallback = extractOutgoing(text);
  const matches = [...text.matchAll(/!\[([^\]]*)\]\(([^)\s]+)\)/g)]
    .map((match) => ({
      index: match.index ?? -1,
      end: (match.index ?? -1) + match[0].length,
      alt: match[1]?.trim() || "图片",
      attachment: toAttachment(cleanMediaRef(match[2]!)),
    }))
    .filter((item): item is typeof item & { attachment: Attachment } =>
      item.index >= 0 && item.attachment?.kind === "image"
    );
  const single = matches.length === 1 ? matches[0] : undefined;
  // 句号、Markdown 收尾标记不算尾注，普通 caption + 单图仍只发送一次。
  const hasSurroundingText = !!single
    && /[\p{L}\p{N}]/u.test(text.slice(0, single.index))
    && /[\p{L}\p{N}]/u.test(text.slice(single.end));
  if (matches.length < 2 && !hasSurroundingText) return fallback.text.trim() || fallback.attachments.length
    ? [{ text: fallback.text, attachments: fallback.attachments }]
    : [];

  const segments: OutgoingSegment[] = [];
  const used = new Set<string>();
  let cursor = 0;
  for (const match of matches) {
    const prefix = text.slice(cursor, match.index).trim();
    segments.push({
      text: prefix || match.alt,
      attachments: [match.attachment],
    });
    used.add(attachmentKey(match.attachment));
    cursor = match.end;
  }

  const trailing = text.slice(cursor).trim();
  const extras = fallback.attachments.filter((attachment) => !used.has(attachmentKey(attachment)));
  if (trailing || extras.length) segments.push({ text: trailing, attachments: extras });
  return segments;
}

export async function sendOutgoingSegments(
  text: string,
  send: (cleanText: string, attachments?: Attachment[]) => Promise<void>,
  journal?: { skip(index: number): boolean; before(index: number): Promise<void>; after(index: number): Promise<void> },
): Promise<void> {
  for (const [index, segment] of extractOutgoingSegments(text).entries()) {
    if (journal?.skip(index)) continue;
    await journal?.before(index);
    await send(segment.text, segment.attachments.length ? segment.attachments : undefined);
    await journal?.after(index);
  }
}
