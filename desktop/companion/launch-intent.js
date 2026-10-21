"use strict";

function parseDesktopLaunchIntent(argv = []) {
  const args = Array.isArray(argv) ? argv.map((value) => String(value)) : [];
  const petArgument = args.find((value) => value.startsWith("--harbour-show-pet="));
  if (petArgument) {
    const petId = petArgument.slice("--harbour-show-pet=".length).trim().toLowerCase();
    if (/^[a-z0-9_-]+$/.test(petId)) return { kind: "pet", petId };
  }
  if (args.includes("--harbour-show-pets")) return { kind: "pets" };
  if (args.includes("--harbour-open-dashboard")) return { kind: "dashboard" };
  return { kind: "default" };
}

// Follow Windows' CommandLineToArgvW quoting rules so a development checkout whose
// path contains spaces still reaches Electron as one argv entry.
function quoteWindowsArgument(value) {
  const input = String(value);
  if (input && !/[\s"]/u.test(input)) return input;
  let output = '"';
  let slashes = 0;
  for (const character of input) {
    if (character === "\\") {
      slashes += 1;
      continue;
    }
    if (character === '"') {
      output += "\\".repeat(slashes * 2 + 1) + '"';
      slashes = 0;
      continue;
    }
    output += "\\".repeat(slashes) + character;
    slashes = 0;
  }
  return output + "\\".repeat(slashes * 2) + '"';
}

function buildDesktopLaunchArguments({ isPackaged, appDirectory, flags = [] }) {
  const args = [];
  if (!isPackaged) args.push(appDirectory);
  args.push(...flags);
  return args.map(quoteWindowsArgument).join(" ");
}

module.exports = {
  buildDesktopLaunchArguments,
  parseDesktopLaunchIntent,
  quoteWindowsArgument,
};
