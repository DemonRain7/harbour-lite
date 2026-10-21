"use strict";
const { spawn } = require("node:child_process"), path = require("node:path");
// Four isolated, hidden test processes. Do not attach to a running Harbour.
Promise.all([1, 1.25, 1.5, 2].map(scale => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [require.resolve("electron/cli.js"), path.join(__dirname, "orb-dock-smoke.js"),
    "--clipping-only", "--scale=" + scale], { stdio: "inherit", windowsHide: true });
  child.on("error", reject);
  child.on("exit", code => resolve(code === 0));
}))).then(results => {
  if (results.some(ok => !ok)) process.exitCode = 1;
  else console.log("ORB_CLIPPING_OK: 2 personas / 4 edges / 4 display scales / 1024 rendered samples including blinking; no live backend");
}).catch(error => { console.error(error); process.exitCode = 1; });
