"use strict";

const revision = value => Number.isSafeInteger(value) && value >= 0;
const validReceipt = value => !!value && typeof value.id === "string" && /^[\w-]{1,128}$/.test(value.id)
  && revision(value.replyRevision) && revision(value.readReplyRevision) && value.readReplyRevision <= value.replyRevision;

// Read metadata, never task status. Keep receipt order independent from WS/HTTP
// arrival order, and never advance the revision of the history being displayed.
function rememberReceipt(known, value) {
  if (!validReceipt(value)) return false;
  const before = known.get(value.id);
  known.set(value.id, { replyRevision: Math.max(before?.replyRevision || 0, value.replyRevision),
    readReplyRevision: Math.max(before?.readReplyRevision || 0, value.readReplyRevision),
    replyRunId: value.replyRevision >= (before?.replyRevision || 0) && typeof value.replyRunId === "string"
      ? value.replyRunId : value.replyRevision > (before?.replyRevision || 0) ? undefined : before?.replyRunId });
  if (known.size > 512) known.delete(known.keys().next().value);
  return true;
}

module.exports = { revision, validReceipt, rememberReceipt };
