// Shared display clock. Epoch/ISO values remain untouched; no browser/system TZ mutation.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.HarbourTime = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  const defaultTimeZone = "America/New_York";
  const defaultOptions = [
    { value: "America/New_York", label: "纽约 · 美东时间（自动夏令时）" },
    { value: "Asia/Shanghai", label: "上海 · 中国标准时间（UTC+08:00）" },
    { value: "Etc/GMT+5", label: "固定 EST · UTC−05:00（不切夏令时）" },
    { value: "UTC", label: "UTC · 协调世界时" },
  ];
  let timeZone = defaultTimeZone;
  const cache = new Map();
  function validTimeZone(value) {
    if (typeof value !== "string" || !value.trim()) return false;
    try { new Intl.DateTimeFormat("en", { timeZone: value }).format(0); return true; } catch { return false; }
  }
  function setTimeZone(value) {
    if (!validTimeZone(value)) return false;
    timeZone = value; return true;
  }
  function date(value) {
    if (value == null || value === "") return null;
    const input = typeof value === "string" && /^-?\d+$/.test(value) ? Number(value) : value;
    const result = new Date(input);
    return Number.isFinite(result.getTime()) ? result : null;
  }
  function parts(value, zone = timeZone) {
    const instant = date(value);
    if (!instant) return null;
    const safeZone = validTimeZone(zone) ? zone : defaultTimeZone;
    if (!cache.has(safeZone)) cache.set(safeZone, new Intl.DateTimeFormat("en-US", {
      timeZone: safeZone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", timeZoneName: "short",
    }));
    return Object.fromEntries(cache.get(safeZone).formatToParts(instant).map((part) => [part.type, part.value]));
  }
  function format(value, style = "full", zone = timeZone) {
    const p = parts(value, zone);
    if (!p) return value == null || value === "" ? (style === "time" ? "" : "—") : String(value);
    const dateOnly = `${p.year}-${p.month}-${p.day}`;
    const clock = `${p.hour}:${p.minute}:${p.second}`;
    if (style === "date") return dateOnly;
    if (style === "time") return clock;
    if (style === "short") return `${p.month}/${p.day} ${p.hour}:${p.minute}`;
    if (style === "filename") return `${p.year}${p.month}${p.day}-${p.hour}${p.minute}${p.second}`;
    return `${dateOnly} ${clock} ${zone === "Etc/GMT+5" ? "EST" : p.timeZoneName}`;
  }
  return { defaultTimeZone, defaultOptions, validTimeZone, setTimeZone, getTimeZone: () => timeZone, date, parts, format };
});
