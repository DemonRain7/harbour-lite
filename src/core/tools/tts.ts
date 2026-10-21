import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ToolDef } from "../../types";
import { readTtsGatewayConfig, synthesizeTts } from "../ttsGateway";

/**
 * speak —— 把文本合成语音，落盘到 uploads，返回可直接引用的 URL。
 *
 * 【为什么这么设计】出站管道早就通了：agent 只要在回复里引用 /uploads/xxx.wav，
 * `extractOutgoing` 就会把它抽成附件 —— web 渲染成 <audio> 播放器、Discord 作为语音文件发出。
 * 所以 TTS 只需负责「产出一个音频文件」这一件事，剩下的全是现成的。
 *
 * 【服务未接时的行为】用户 选择「先预留接口、服务后接」（2026-07-26）。
 * 没配 TTS_URL 时本工具【不假装成功】：明确返回 configured:false + 一句怎么开启，
 * 让 agent 改用文字回复。绝不返回一个不存在的音频路径 —— 那会让 agent 发出一个坏链接。
 *
 * 【接哪种服务】只要求 HTTP + 返回音频字节，因此 GPT-SoVITS / 自建 FastAPI / 云 API
 * 都能接：把地址填进 .env 的 TTS_URL 即可。请求形状用 TTS_FORMAT 选，默认是最常见的
 * 「POST JSON {text, ...} → 音频 body」。
 */

export const ttsTool: ToolDef = {
  name: "speak",
  description:
    "把一段文本合成语音，返回音频文件的 URL。想用语音回复 用户 时调它，然后在你的回复里" +
    "引用返回的 url（如 /uploads/xxx.wav）——web 会显示播放器、Discord 会发语音文件。" +
    "未配置 TTS 服务时会明确告诉你没配，那就改用文字回复。",
  // 合成可能要几十秒（尤其本地推理），给足时间。
  timeoutMs: 3 * 60 * 1000,
  readOnly: false,
  parameters: {
    type: "object",
    properties: {
      text: { type: "string", description: "要合成的文本。别太长，一两句话最自然。" },
      voice: { type: "string", description: "音色/说话人（可选，缺省用 .env 里配的默认音色）" },
    },
    required: ["text"],
  },
  async execute(args, ctx) {
    const text = String(args.text ?? "").trim();
    if (!text) throw new Error("speak: text 不能为空");

    const cfg = readTtsGatewayConfig();
    if (!cfg) {
      // 明确的「未接入」而不是假装失败——让 agent 知道该改用文字，而不是重试。
      return {
        ok: false,
        configured: false,
        reason:
          "TTS 服务尚未接入或已关闭。这次请改用文字回复。" +
          "可在 Settings → 语音合成配置主服务，或开启腾讯云备用并填写密钥。",
      };
    }

    const voice = String(args.voice ?? "").trim() || cfg.voice;
    const companionId = ctx.agent?.name?.startsWith("main-") ? ctx.agent.name.slice(5) : undefined;
    let generated;
    try {
      generated = await synthesizeTts(cfg, { text, voice, companionId, signal: ctx.signal });
    } catch (e) {
      const msg = (e as Error).message;
      return { ok: false, configured: true, reason: `调 TTS 服务失败：${msg}。这次改用文字回复。` };
    }

    // 落盘到与上传同一个目录 → /uploads/<file> 这个 URL 前端/Discord 都已能取。
    const dir = path.resolve(process.cwd(), process.env.UPLOAD_DIR ?? "./assets/uploads");
    await fs.mkdir(dir, { recursive: true });
    const fileName = `tts-${randomUUID().slice(0, 8)}.${generated.ext}`;
    await fs.writeFile(path.join(dir, fileName), generated.data);
    const url = `/uploads/${fileName}`;
    ctx.logger.info({ agent: ctx.agent?.name, bytes: generated.data.byteLength, url }, "tts:ok");

    return {
      ok: true,
      url,
      mime: generated.mime,
      bytes: generated.data.byteLength,
      provider: generated.provider,
      ...(generated.fallbackFrom ? { fallbackFrom: generated.fallbackFrom } : {}),
      note: `已生成语音。在你的回复里引用 ${url} 即可发给 用户（web 显示播放器、Discord 发语音文件）。`,
    };
  },
};
