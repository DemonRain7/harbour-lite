import os from "node:os";
import type { CoworkTarget } from "../../types";
import type { CoworkDeviceInfo } from "./protocol";
import { currentCommandShell } from "../commandShell";

export function normalizeCoworkTarget(raw: unknown): CoworkTarget | undefined {
  if (raw == null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error("Cowork 目标格式无效");
  const row = raw as Record<string, unknown>;
  const deviceId = typeof row.deviceId === "string" ? row.deviceId.trim() : "";
  if (!/^[\w:.-]{1,128}$/.test(deviceId)) throw new Error("Cowork deviceId 无效");
  const cwd = row.cwd == null ? "" : String(row.cwd).trim();
  if (cwd.length > 4096 || /[\x00-\x1f]/.test(cwd)) throw new Error("Cowork 工作目录无效");
  const originDeviceId = row.originDeviceId == null ? "" : String(row.originDeviceId).trim();
  if (originDeviceId && !/^[\w:.-]{1,128}$/.test(originDeviceId)) throw new Error("Cowork 来源设备无效");
  return { deviceId, ...(cwd ? { cwd } : {}), ...(originDeviceId ? { originDeviceId } : {}) };
}

/** @label 只在 Cowork 的消息起始处解释；普通聊天中的 @昵称不改变执行设备。 */
export function resolveCoworkRequest(input: string, defaultTarget: CoworkTarget | undefined, devices: CoworkDeviceInfo[]): CoworkTarget | undefined {
  if (!defaultTarget) return undefined;
  let target = { ...defaultTarget };
  const mention = input.replace(/^\s*\[skill:[a-z0-9-]+\]\s*/i, "").match(/^\s*@(?:"([^"\r\n]+)"|([^\s，,：:]+))(?=\s|[，,：:]|$)/u);
  if (mention) {
    const name = (mention[1] || mention[2] || "").toLowerCase();
    const matches = devices.filter((device) => [device.id, device.label, device.hostname].some((value) => value.toLowerCase() === name));
    if (matches.length !== 1) throw new Error(matches.length ? `设备名称 ${name} 不唯一，请使用设备 ID` : `未找到设备 ${name}，未执行`);
    // 另一设备不能沿用前一机器的目录路径。
    target = { deviceId: matches[0]!.id, ...(target.originDeviceId ? { originDeviceId: target.originDeviceId } : {}) };
    if (target.deviceId === defaultTarget.deviceId && defaultTarget.cwd) target.cwd = defaultTarget.cwd;
  }
  const device = devices.find((entry) => entry.id === target.deviceId);
  if (!device || !device.online) throw new Error(`执行设备 ${device?.label || target.deviceId} 离线或未注册；不会切换到其他设备`);
  return target;
}

export function serverDeviceInfo(): CoworkDeviceInfo {
  return { id: "server", label: "Harbour 服务端", hostname: os.hostname(), platform: process.platform,
    arch: process.arch, cwd: process.cwd(), tools: ["list_files", "read_file", "bash", "opencli_adapter", "opencli_browser"],
    online: true, lastSeenAt: Date.now(),
    environment: { osRelease: os.release(), nodeVersion: process.versions.node, shell: currentCommandShell() } };
}
