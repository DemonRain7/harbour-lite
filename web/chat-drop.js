/* Composer-only attachment drops. No clipboard access, filesystem paths, or HTML execution. */
(function () {
  "use strict";

  function hasFiles(transfer) {
    return !!transfer && (Array.from(transfer.types || []).includes("Files") || transfer.files?.length > 0
      || Array.from(transfer.items || []).some(item => item.kind === "file"));
  }

  function imageSource(transfer, draggedImage, document) {
    if (draggedImage) return draggedImage;
    // A template is inert: never append dropped HTML or load its scripts/resources.
    const html = transfer?.getData("text/html") || "";
    if (html && html.length <= 65536) {
      const template = document.createElement("template");
      template.innerHTML = html;
      const image = template.content.querySelector("img[src]");
      if (image) return { src: image.getAttribute("src"), name: image.getAttribute("alt") || "" };
    }
    const uri = (transfer?.getData("text/uri-list") || "").split(/\r?\n/).find(line => line.trim() && !line.startsWith("#"));
    if (uri && (/\.(?:png|jpe?g|webp|gif|avif|bmp)(?:[?#]|$)/i.test(uri) || /^data:image\//i.test(uri))) {
      return { src: uri.trim(), name: "" };
    }
    return null;
  }

  function mount({ composer, input, filesFromTransfer, imageFromElement, blockedReason, onFiles, onImage, toast }) {
    if (!composer) return () => {};
    const document = composer.ownerDocument, window = document.defaultView;
    let depth = 0, draggedImage = null, disposed = false;
    const listeners = [];
    const listen = (target, type, fn) => { target.addEventListener(type, fn); listeners.push(() => target.removeEventListener(type, fn)); };
    const reset = () => { depth = 0; composer.classList.remove("is-drag-over"); };
    const candidate = transfer => hasFiles(transfer) || !!draggedImage
      || Array.from(transfer?.types || []).some(type => type === "text/html" || type === "text/uri-list");
    const accept = event => {
      if (!candidate(event.dataTransfer)) return false;
      event.preventDefault();
      const blocked = blockedReason();
      if (event.dataTransfer) event.dataTransfer.dropEffect = blocked ? "none" : "copy";
      composer.classList.toggle("is-drag-over", !blocked);
      return !blocked;
    };
    listen(document, "dragstart", event => { draggedImage = imageFromElement(event.target); });
    listen(composer, "dragenter", event => { if (accept(event)) depth++; });
    listen(composer, "dragover", accept);
    listen(composer, "dragleave", event => {
      depth = Math.max(0, depth - 1);
      if (!depth || (event.relatedTarget && !composer.contains(event.relatedTarget))) reset();
    });
    listen(composer, "drop", async event => {
      // DataTransfer becomes protected once the event returns. Read it before awaiting anything.
      const transfer = event.dataTransfer;
      const files = filesFromTransfer(transfer);
      const image = files.length ? null : imageSource(transfer, draggedImage, document);
      reset();
      if (!files.length && !image && !hasFiles(transfer)) return; // ordinary text keeps native behavior
      event.preventDefault();
      event.stopPropagation();
      draggedImage = null;
      const blocked = blockedReason();
      if (blocked) { toast(blocked, true); return; }
      const directory = Array.from(transfer?.items || []).some(item => item.webkitGetAsEntry?.()?.isDirectory);
      if (directory) { toast("请拖入具体文件，暂不支持文件夹。", true); return; }
      if (!files.length && !image) { toast("请拖入具体文件，暂不支持文件夹。", true); return; }
      try {
        // Reserve the draft's pending-upload lock synchronously, before another UI event.
        await (files.length ? onFiles(files) : onImage(image));
      } catch (error) {
        toast(error?.message || "附件添加失败，请重试。", true);
      } finally { if (!disposed && !blockedReason()) input?.focus({ preventScroll: true }); }
    });
    // A misplaced file/image drop must not navigate Electron away from the conversation.
    listen(document, "dragover", event => { if (hasFiles(event.dataTransfer) || draggedImage) event.preventDefault(); });
    listen(document, "drop", event => {
      if (hasFiles(event.dataTransfer) || imageSource(event.dataTransfer, draggedImage, document)) event.preventDefault();
      draggedImage = null; reset();
    });
    listen(document, "dragend", () => { draggedImage = null; reset(); });
    listen(window, "blur", reset);
    return () => { disposed = true; listeners.forEach(remove => remove()); draggedImage = null; reset(); };
  }

  window.HarbourChatDrop = { mount };
})();
