import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ToolDef } from "../../types";

/**
 * desktop-control —— 控制本机桌面（鼠标/键盘/截屏），最重最危险的一类能力。
 * 工具：desktop_screenshot / desktop_click / desktop_type。
 *
 * 安全护栏（多重审批位）：
 *  1) 总开关：环境变量 ENABLE_DESKTOP_CONTROL=true 才允许任何桌面动作（默认关）。
 *  2) 写动作（click/type）必须显式带 confirm:true（每次审批），只读 screenshot 不要求。
 *  3) failsafe：动作有节流；要紧急中止，把鼠标甩到屏幕角落 / 切到安全窗口即可打断后续。
 *
 * 依赖 nut.js（原生模块，可能装不动）：用动态 import，未启用/未安装一律给清晰错误，
 * 绝不伪装成功、绝不卡死 server。
 */

const importEsm = new Function("s", "return import(s)") as (s: string) => Promise<any>;

function enabled(): boolean {
  const v = String(process.env.ENABLE_DESKTOP_CONTROL ?? "").toLowerCase();
  return ["true", "1", "yes", "on"].includes(v);
}

function assertEnabled(): void {
  if (!enabled()) {
    throw new Error(
      "desktop-control 未启用（安全护栏）：需要环境变量 ENABLE_DESKTOP_CONTROL=true 才能控制桌面。"
    );
  }
}

let nutPromise: Promise<any> | undefined;
async function loadNut(): Promise<any> {
  // 优先 fork 维护版，回退原始包名。
  nutPromise ??= importEsm("@nut-tree-fork/nut-js")
    .catch(() => importEsm("@nut-tree/nut-js"))
    .catch((e: Error) => {
      nutPromise = undefined;
      throw new Error(
        `desktop-control 需要 nut.js，但未能加载（${e.message}）。请 \`npm i @nut-tree-fork/nut-js\`（原生依赖，装不动则该能力降级不可用）。`
      );
    });
  return nutPromise;
}

const SHOTS_DIR = path.resolve(process.cwd(), "assets", "sessions", "shots");

export const desktopScreenshotTool: ToolDef = {
  name: "desktop_screenshot",
  description: "截当前桌面屏幕，保存到 assets/sessions/shots/（只读动作）。需 ENABLE_DESKTOP_CONTROL=true。",
  parameters: { type: "object", properties: {}, required: [] },
  async execute(_args, ctx) {
    assertEnabled();
    const nut = await loadNut();
    const { screen, FileType } = nut;
    const fs = await import("node:fs/promises");
    await fs.mkdir(SHOTS_DIR, { recursive: true });
    const name = `desktop-${randomUUID().slice(0, 8)}`;
    const saved = await screen.capture(name, FileType.PNG, SHOTS_DIR);
    ctx.logger.info({ saved }, "desktop_screenshot");
    return { saved: String(saved).replace(/\\/g, "/") };
  },
};

export const desktopClickTool: ToolDef = {
  name: "desktop_click",
  description: "把鼠标移动到 (x,y) 并左键单击。危险动作：必须带 confirm:true，且需 ENABLE_DESKTOP_CONTROL=true。",
  parameters: {
    type: "object",
    properties: {
      x: { type: "number", description: "屏幕横坐标" },
      y: { type: "number", description: "屏幕纵坐标" },
      confirm: { type: "boolean", description: "审批位：必须为 true 才真的点击" },
    },
    required: ["x", "y", "confirm"],
  },
  async execute(args, ctx) {
    assertEnabled();
    if (args.confirm !== true) throw new Error("desktop_click: 需要 confirm:true（审批位）才执行");
    const x = Number(args.x);
    const y = Number(args.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("desktop_click: x/y 非法");
    const nut = await loadNut();
    const { mouse, Point, Button } = nut;
    await mouse.setPosition(new Point(x, y));
    await mouse.click(Button.LEFT);
    ctx.logger.warn({ x, y }, "desktop_click（已执行桌面点击）");
    return { clicked: { x, y } };
  },
};

export const desktopTypeTool: ToolDef = {
  name: "desktop_type",
  description: "用键盘输入一段文本到当前焦点。危险动作：必须带 confirm:true，且需 ENABLE_DESKTOP_CONTROL=true。",
  parameters: {
    type: "object",
    properties: {
      text: { type: "string", description: "要输入的文本" },
      confirm: { type: "boolean", description: "审批位：必须为 true 才真的输入" },
    },
    required: ["text", "confirm"],
  },
  async execute(args, ctx) {
    assertEnabled();
    if (args.confirm !== true) throw new Error("desktop_type: 需要 confirm:true（审批位）才执行");
    const text = String(args.text ?? "");
    const nut = await loadNut();
    const { keyboard } = nut;
    await keyboard.type(text);
    ctx.logger.warn({ length: text.length }, "desktop_type（已执行桌面输入）");
    return { typed: text.length };
  },
};

export const desktopTools: ToolDef[] = [desktopScreenshotTool, desktopClickTool, desktopTypeTool];
