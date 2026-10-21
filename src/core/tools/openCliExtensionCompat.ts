import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

const FUNCTION_START = "async function setFileInputFiles(tabId, files, selector) {";
const FUNCTION_END = "function matchesDownloadPattern(item, pattern) {";
// Audited OpenCLI Bridge 1.0.23 function, normalized to LF. Never fuzzy-patch a
// newer/custom build or an unrelated Runtime.evaluate call in the same bundle.
const ORIGINAL_FUNCTION_SHA256 = "dfa8b64e51cdd961df136db36d44e3d82482c585c7b19c350f3d17fb39872fd0";
const GESTURE_V1_FUNCTION_SHA256 = "ce4c573d4d1c9450c272a3df68a0d9207d6ee59f39beedec8fe64ae4363d4f7d";
// Keep the permitted chooser flow: chrome.debugger cannot attach files directly
// to an arbitrary queried node. Native showPicker avoids page click handlers;
// both its response and the chooser's exact target must agree before one write.
const NATIVE_PICKER_FUNCTION = [
  'async function setFileInputFiles(tabId, files, selector) {',
  '  const pending = setFileInputFiles.harbourPendingTabs ??= new Set();',
  '  if (pending.has(tabId)) throw new Error("File upload already in progress for this tab");',
  '  pending.add(tabId);',
  '  let objectId;',
  '  let listener;',
  '  let timer;',
  '  let rejectChooser;',
  '  let interceptAttempted = false;',
  '  const checkResult = (result) => {',
  '    if (result?.exceptionDetails) {',
  '      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || "File picker evaluation failed");',
  '    }',
  '    return result?.result;',
  '  };',
  '  try {',
  '    await ensureAttached(tabId);',
  '    await sendDebuggerCommand({ tabId }, "DOM.enable");',
  '    await sendDebuggerCommand({ tabId }, "Page.enable");',
  '    const query = selector || \'input[type="file"]\';',
  '    const resolveInput = `const inputs = document.querySelectorAll(${JSON.stringify(query)});',
  '      if (inputs.length !== 1) throw new Error("File picker requires exactly one input");',
  '      const target = inputs[0];',
  '      if (!(target instanceof HTMLInputElement) || target.type !== "file" || !target.isConnected || target.matches(":disabled"))',
  '        throw new Error("File picker target must be a connected, enabled input[type=file]");',
  '      if (typeof HTMLInputElement.prototype.showPicker !== "function") throw new Error("Native file picker is unavailable");`;',
  '    const found = checkResult(await sendDebuggerCommand({ tabId }, "Runtime.evaluate", {',
  '      expression: `(() => { ${resolveInput} return target; })()`',
  '    }));',
  '    objectId = found?.objectId;',
  '    if (typeof objectId !== "string" || !objectId) throw new Error("File picker target object was not resolved");',
  '    const described = await sendDebuggerCommand({ tabId }, "DOM.describeNode", { objectId });',
  '    const expectedBackend = described?.node?.backendNodeId;',
  '    if (!Number.isSafeInteger(expectedBackend) || expectedBackend <= 0) throw new Error("File picker target identity was not resolved");',
  '    const chooser = new Promise((resolve, reject) => {',
  '      rejectChooser = reject;',
  '      timer = setTimeout(() => reject(new Error("Page.fileChooserOpened not received within 5s; upload outcome requires inspection")), 5e3);',
  '      listener = (source, method, params) => {',
  '        if (source.tabId !== tabId || method !== "Page.fileChooserOpened") return;',
  '        if (source.sessionId || params?.backendNodeId !== expectedBackend) {',
  '          reject(new Error("File chooser target does not match the authorized input"));',
  '        } else if (params.mode === "selectSingle" && files.length > 1) {',
  '          reject(new Error("File chooser does not allow multiple files"));',
  '        } else {',
  '          resolve(expectedBackend);',
  '        }',
  '      };',
  '      chrome.debugger.onEvent.addListener(listener);',
  '    });',
  '    const invoke = (async () => {',
  '      interceptAttempted = true;',
  '      await sendDebuggerCommand({ tabId }, "Page.setInterceptFileChooserDialog", { enabled: true });',
  '      const response = checkResult(await sendDebuggerCommand({ tabId }, "Runtime.evaluate", {',
  '        expression: `(() => { ${resolveInput} HTMLInputElement.prototype.showPicker.call(target); return { pickerInvoked: true }; })()`,',
  '        userGesture: true,',
  '        returnByValue: true',
  '      }));',
  '      if (response?.value?.pickerInvoked !== true) throw new Error("Native file picker invocation was not confirmed");',
  '    })().catch((error) => { rejectChooser(error); throw error; });',
  '    // Wait for the invocation to settle even if the chooser times out: cleanup',
  '    // must not race a still-pending command that can open the picker later.',
  '    const [chosen, invoked] = await Promise.allSettled([chooser, invoke]);',
  '    if (invoked.status === "rejected") throw invoked.reason;',
  '    if (chosen.status === "rejected") throw chosen.reason;',
  '    await sendDebuggerCommand({ tabId }, "DOM.setFileInputFiles", { files, backendNodeId: chosen.value });',
  '  } finally {',
  '    if (timer !== undefined) clearTimeout(timer);',
  '    if (listener) chrome.debugger.onEvent.removeListener(listener);',
  '    if (interceptAttempted) await sendDebuggerCommand({ tabId }, "Page.setInterceptFileChooserDialog", { enabled: false }).catch(() => {});',
  '    if (objectId) await sendDebuggerCommand({ tabId }, "Runtime.releaseObject", { objectId }).catch(() => {});',
  '    pending.delete(tabId);',
  '  }',
  '}',
  '',
].join("\n");
const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

/** Read-only exact recognition shared by the disk patcher and startup verifier. */
export function classifyOpenCliUploadFunction(source: string): "original" | "gesture-v1" | "picker-v2" | "unknown" {
  const start = source.indexOf(FUNCTION_START);
  if (start < 0 || source.indexOf(FUNCTION_START, start + FUNCTION_START.length) !== -1) return "unknown";
  const end = source.indexOf(FUNCTION_END, start + FUNCTION_START.length);
  if (end < 0) return "unknown";
  const hash = sha256(source.slice(start, end).replace(/\r\n/g, "\n"));
  if (hash === ORIGINAL_FUNCTION_SHA256) return "original";
  if (hash === GESTURE_V1_FUNCTION_SHA256) return "gesture-v1";
  return hash === sha256(NATIVE_PICKER_FUNCTION) ? "picker-v2" : "unknown";
}

/** Exact, reversible local compatibility patch, called before Chrome startup.
 * true = this call wrote and verified the patch; false = already patched,
 * unrecognized input/version, or a conflicting backup (nothing overwritten).
 * Other I/O failures throw so the caller can report a precise startup warning.
 * The byte-identical pre-upgrade bundle is retained next to background.js as
 * background.js.harbour-upload-picker-v2-v1.0.23.bak. Older v1 backups are untouched.
 */
export function ensureOpenCliUploadGesture(extensionDir: string): boolean {
  const root = path.resolve(extensionDir);
  let realRoot: string;
  try { realRoot = realpathSync(root); }
  catch { return false; }
  let manifest: { name?: unknown; version?: unknown; background?: { service_worker?: unknown } };
  try { manifest = JSON.parse(readFileSync(path.join(root, "manifest.json"), "utf8")); }
  catch { return false; }
  if (manifest?.name !== "OpenCLI" || manifest.version !== "1.0.23" || manifest.background?.service_worker !== "dist/background.js") return false;
  const requestedTarget = path.join(root, "dist", "background.js");
  let target: string;
  let original: Buffer;
  try {
    if (!lstatSync(requestedTarget).isFile()) return false;
    target = realpathSync(requestedTarget);
    const relative = path.relative(realRoot, target);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return false;
    original = readFileSync(target);
  } catch { return false; }
  const source = original.toString("utf8");
  if (!Buffer.from(source, "utf8").equals(original)) return false;
  const start = source.indexOf(FUNCTION_START);
  if (start < 0 || source.indexOf(FUNCTION_START, start + FUNCTION_START.length) !== -1) return false;
  const end = source.indexOf(FUNCTION_END, start + FUNCTION_START.length);
  if (end < 0) return false;
  const currentFunction = source.slice(start, end);
  const normalized = currentFunction.replace(/\r\n/g, "\n");
  if (![ORIGINAL_FUNCTION_SHA256, GESTURE_V1_FUNCTION_SHA256].includes(sha256(normalized))) return false;
  const eol = currentFunction.includes("\r\n") ? "\r\n" : "\n";
  // Preserve every byte outside the single audited function, including EOLs.
  const updatedFunction = NATIVE_PICKER_FUNCTION.replace(/\n/g, eol);
  const patched = Buffer.from(source.slice(0, start) + updatedFunction + source.slice(end), "utf8");
  const originalHash = sha256(original);
  const backup = target + ".harbour-upload-picker-v2-v1.0.23.bak";
  try {
    if (!lstatSync(backup).isFile() || sha256(readFileSync(backup)) !== originalHash) return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
    try { writeFileSync(backup, original, { flag: "wx", mode: 0o600 }); }
    catch (writeError) {
      if ((writeError as NodeJS.ErrnoException).code !== "EEXIST") throw writeError;
      // Another startup may have won exclusive creation. Never overwrite its backup.
      if (!lstatSync(backup).isFile() || sha256(readFileSync(backup)) !== originalHash) return false;
    }
  }
  if (sha256(readFileSync(backup)) !== originalHash) return false;
  if (sha256(readFileSync(target)) !== originalHash) return false;
  const temporary = target + `.harbour-upload-picker-v2-${process.pid}-${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, patched, { flag: "wx", mode: 0o600 });
    if (sha256(readFileSync(temporary)) !== sha256(patched)) throw new Error("OpenCLI upload gesture patch temporary-file SHA256 verification failed");
    // Refuse to clobber a changed build between backup creation and replacement.
    if (sha256(readFileSync(target)) !== originalHash) return false;
    renameSync(temporary, target);
    if (sha256(readFileSync(target)) !== sha256(patched)) throw new Error("OpenCLI upload gesture patch SHA256 verification failed; original backup preserved");
    return true;
  } finally {
    try { unlinkSync(temporary); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}
