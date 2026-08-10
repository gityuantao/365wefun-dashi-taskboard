import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DomainError } from "../domain/errors.mjs";

const IMAGE_TYPES = [
  { contentType: "image/png", extension: ".png", matches: (body) => startsWith(body, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), valid: validPng },
  { contentType: "image/jpeg", extension: ".jpg", matches: (body) => startsWith(body, [0xff, 0xd8, 0xff]), valid: validJpeg },
  { contentType: "image/webp", extension: ".webp", matches: (body) => startsWith(body, [0x52, 0x49, 0x46, 0x46]) && startsWith(body, [0x57, 0x45, 0x42, 0x50], 8), valid: validWebp },
  { contentType: "image/gif", extension: ".gif", matches: (body) => startsWith(body, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) || startsWith(body, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]), valid: validGif },
];

function startsWith(body, signature, offset = 0) {
  return body.length >= offset + signature.length
    && signature.every((byte, index) => body[offset + index] === byte);
}

function uint32BigEndian(body, offset) {
  return (
    body[offset] * 0x1000000
    + body[offset + 1] * 0x10000
    + body[offset + 2] * 0x100
    + body[offset + 3]
  );
}

function uint32LittleEndian(body, offset) {
  return (
    body[offset]
    + body[offset + 1] * 0x100
    + body[offset + 2] * 0x10000
    + body[offset + 3] * 0x1000000
  );
}

function ascii(body, offset, length) {
  return String.fromCharCode(...body.subarray(offset, offset + length));
}

function validPng(body) {
  if (body.length < 45) return false;
  let offset = 8;
  let chunkIndex = 0;
  let sawIdat = false;
  while (offset + 12 <= body.length) {
    const length = uint32BigEndian(body, offset);
    const type = ascii(body, offset + 4, 4);
    const chunkEnd = offset + 12 + length;
    if (!Number.isSafeInteger(chunkEnd) || chunkEnd > body.length) return false;
    if (chunkIndex === 0 && (type !== "IHDR" || length !== 13)) return false;
    if (type === "IDAT") sawIdat = true;
    if (type === "IEND") {
      return length === 0 && sawIdat && chunkEnd === body.length;
    }
    offset = chunkEnd;
    chunkIndex += 1;
  }
  return false;
}

function jpegFrameMarker(marker) {
  return (marker >= 0xc0 && marker <= 0xc3)
    || (marker >= 0xc5 && marker <= 0xc7)
    || (marker >= 0xc9 && marker <= 0xcb)
    || (marker >= 0xcd && marker <= 0xcf);
}

function validJpeg(body) {
  if (body.length < 8 || body[0] !== 0xff || body[1] !== 0xd8) return false;
  let offset = 2;
  let sawFrame = false;
  let sawScan = false;
  while (offset < body.length) {
    if (body[offset] !== 0xff) return false;
    while (offset < body.length && body[offset] === 0xff) offset += 1;
    if (offset >= body.length) return false;
    const marker = body[offset];
    offset += 1;
    if (marker === 0xd9) return sawFrame && sawScan && offset === body.length;
    if (marker === 0x00 || marker === 0xd8) return false;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > body.length) return false;
    const segmentLength = body[offset] * 0x100 + body[offset + 1];
    if (segmentLength < 2 || offset + segmentLength > body.length) return false;
    if (jpegFrameMarker(marker)) sawFrame = true;
    const segmentEnd = offset + segmentLength;
    offset = segmentEnd;
    if (marker !== 0xda) continue;
    sawScan = true;
    while (offset < body.length) {
      if (body[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      let markerOffset = offset + 1;
      while (markerOffset < body.length && body[markerOffset] === 0xff) markerOffset += 1;
      if (markerOffset >= body.length) return false;
      const scanMarker = body[markerOffset];
      if (scanMarker === 0x00 || (scanMarker >= 0xd0 && scanMarker <= 0xd7)) {
        offset = markerOffset + 1;
        continue;
      }
      break;
    }
  }
  return false;
}

function validWebp(body) {
  if (body.length < 20) return false;
  if (uint32LittleEndian(body, 4) + 8 !== body.length) return false;
  let offset = 12;
  let sawImageData = false;
  while (offset < body.length) {
    if (offset + 8 > body.length) return false;
    const type = ascii(body, offset, 4);
    const length = uint32LittleEndian(body, offset + 4);
    const chunkEnd = offset + 8 + length;
    if (!Number.isSafeInteger(chunkEnd) || chunkEnd > body.length) return false;
    if (type === "VP8 " || type === "VP8L" || type === "ANMF") sawImageData = true;
    offset = chunkEnd + (length % 2);
    if (offset > body.length) return false;
  }
  return sawImageData && offset === body.length;
}

function gifSubBlocksEnd(body, start) {
  let offset = start;
  while (offset < body.length) {
    const length = body[offset];
    offset += 1;
    if (length === 0) return offset;
    if (offset + length > body.length) return -1;
    offset += length;
  }
  return -1;
}

function validGif(body) {
  if (body.length < 14) return false;
  let offset = 13;
  const globalTable = (body[10] & 0x80) !== 0;
  if (globalTable) offset += 3 * (2 ** ((body[10] & 0x07) + 1));
  if (offset > body.length) return false;
  let sawImage = false;
  while (offset < body.length) {
    const blockType = body[offset];
    offset += 1;
    if (blockType === 0x3b) return sawImage && offset === body.length;
    if (blockType === 0x21) {
      if (offset >= body.length) return false;
      offset = gifSubBlocksEnd(body, offset + 1);
      if (offset < 0) return false;
      continue;
    }
    if (blockType !== 0x2c || offset + 9 > body.length) return false;
    const packed = body[offset + 8];
    offset += 9;
    if ((packed & 0x80) !== 0) offset += 3 * (2 ** ((packed & 0x07) + 1));
    if (offset >= body.length) return false;
    offset = gifSubBlocksEnd(body, offset + 1);
    if (offset < 0) return false;
    sawImage = true;
  }
  return false;
}

function recentComments(comments, limit) {
  if (!Array.isArray(comments) || comments.length === 0) return [];
  const allHaveDates = comments.every((comment) => Number.isFinite(Number(comment?.date)));
  return allHaveDates
    ? [...comments].sort((left, right) => Number(right.date) - Number(left.date)).slice(0, limit)
    : comments.slice(-limit);
}

const SUPPORTED_IMAGE_MIME_TYPES = new Set(IMAGE_TYPES.map((type) => type.contentType));
const SUPPORTED_IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
const KNOWN_NON_IMAGE_EXTENSIONS = new Set([
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".txt", ".zip",
]);

function supportedImageHint(attachment) {
  if (typeof attachment === "string") {
    try {
      return SUPPORTED_IMAGE_EXTENSIONS.has(path.extname(new URL(attachment).pathname).toLowerCase());
    } catch {
      return false;
    }
  }
  if (typeof attachment !== "object" || attachment === null) return false;
  const typeHints = [
    attachment.contentType,
    attachment.content_type,
    attachment.mimeType,
    attachment.mime_type,
    attachment.extension,
    attachment.type,
  ].filter((value) => typeof value === "string").map((value) => value.trim().toLowerCase());
  if (typeHints.some((value) => SUPPORTED_IMAGE_MIME_TYPES.has(value))) return true;
  if (typeHints.some((value) => SUPPORTED_IMAGE_EXTENSIONS.has(`.${value.replace(/^\./, "")}`))) {
    return true;
  }
  if (typeHints.some((value) => value.startsWith("application/") || value.startsWith("text/"))) {
    return false;
  }
  for (const value of [attachment.title, attachment.filename, attachment.name, attachment.url]) {
    if (typeof value !== "string" || value.trim() === "") continue;
    try {
      const pathname = value.includes("://") ? new URL(value).pathname : value;
      const extension = path.extname(pathname).toLowerCase();
      if (SUPPORTED_IMAGE_EXTENSIONS.has(extension)) return true;
      if (KNOWN_NON_IMAGE_EXTENSIONS.has(extension)) return false;
    } catch {
      // Malformed generic attachment URLs are not image candidates.
    }
  }
  return true;
}

function attachmentValues(comment) {
  const nested = Array.isArray(comment?.comment)
    ? comment.comment
      .filter((segment) => segment?.type === "image" && segment.image)
      .map((segment) => ({ attachment: segment.image, filename: segment.text }))
    : [];
  const explicit = [comment?.images, comment?.image]
    .flatMap((value) => Array.isArray(value) ? value : value ? [value] : [])
    .map((attachment) => ({ attachment }));
  const generic = (Array.isArray(comment?.attachments)
    ? comment.attachments
    : comment?.attachments ? [comment.attachments] : [])
    .filter(supportedImageHint)
    .map((attachment) => ({ attachment }));
  return [...nested, ...explicit, ...generic];
}

function attachmentUrl(attachment) {
  if (typeof attachment === "string") return attachment;
  return attachment?.url ?? attachment?.image_url ?? attachment?.download_url ?? null;
}

function safeLabel(value, fallback) {
  const sanitized = String(value ?? "")
    .replace(/[\r\n]/g, " ")
    .split(/[\\/]/)
    .at(-1)
    .split(/[?#]/, 1)[0]
    .trim()
    .slice(0, 120);
  return sanitized || fallback;
}

function attachmentFilename(attachment, ordinal, preferredFilename) {
  if (typeof preferredFilename === "string" && preferredFilename.trim() !== "") {
    return safeLabel(preferredFilename, `attachment-${ordinal}`);
  }
  if (typeof attachment === "object" && attachment !== null) {
    for (const value of [attachment.title, attachment.filename, attachment.name]) {
      if (typeof value === "string" && value.trim() !== "") {
        return safeLabel(value, `attachment-${ordinal}`);
      }
    }
  }
  return `attachment-${ordinal}`;
}

function detectedImageType(body) {
  return IMAGE_TYPES.find((type) => type.matches(body)) ?? null;
}

function textForComment(comment) {
  const text = String(comment?.comment_text ?? comment?.text ?? "").trim();
  return text === "" ? null : text;
}

function contextFor(comments, labelsByComment) {
  const lines = [];
  for (const comment of comments) {
    const text = textForComment(comment);
    if (text) lines.push(`- 评论 ${String(comment?.id ?? "unknown")}：${text}`);
    lines.push(...(labelsByComment.get(comment) ?? []));
  }
  return lines.length > 0 ? lines.join("\n") : null;
}

function omittedImageLabel(commentId, filename, code) {
  return `- 评论 ${commentId} 图片未读取：${filename}（${code}）`;
}

function downloadError(error, commentId, filename) {
  const originalCode = typeof error?.code === "string" ? error.code : "";
  const code = /^[A-Z][A-Z0-9_]{1,39}$/.test(originalCode)
    ? originalCode
    : "IMAGE_UNAVAILABLE";
  const originalName = typeof error?.name === "string" ? error.name : "";
  const name = /^[A-Za-z][A-Za-z0-9]*Error$/.test(originalName) ? originalName : "Error";
  return new DomainError(
    code,
    `Attachment ${filename} download failed`,
    { commentId, filename, cause: { name, code } },
  );
}

/**
 * Downloads supported image attachments from the same recent comment window used in AI prompts.
 */
export async function collectCommentMedia({
  comments,
  client,
  taskId: _taskId,
  tempRoot,
  maxComments = 12,
  maxImages = 8,
  maxImageBytes = 10_000_000,
  maxTotalBytes = 30_000_000,
} = {}) {
  const selected = recentComments(comments, maxComments);
  const candidates = [];
  const seenUrls = new Set();
  let discoveredOrdinal = 0;
  for (const comment of selected) {
    for (const value of attachmentValues(comment)) {
      discoveredOrdinal += 1;
      const url = attachmentUrl(value.attachment);
      if (url && seenUrls.has(url)) continue;
      if (url) seenUrls.add(url);
      candidates.push({
        comment,
        attachment: value.attachment,
        filename: value.filename,
        ordinal: discoveredOrdinal,
      });
    }
  }
  const labelsByComment = new Map(selected.map((comment) => [comment, []]));
  const diagnostics = [];
  const images = [];
  let directory;
  let totalBytes = 0;
  let ordinal = 0;

  const cleanup = async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
  };

  try {
    for (const [candidateIndex, candidate] of candidates.entries()) {
      const filename = attachmentFilename(
        candidate.attachment,
        candidate.ordinal,
        candidate.filename,
      );
      const commentId = String(candidate.comment?.id ?? "unknown");
      if (candidateIndex >= maxImages) {
        diagnostics.push({ code: "IMAGE_LIMIT", commentId, filename });
        labelsByComment.get(candidate.comment).push(omittedImageLabel(commentId, filename, "IMAGE_LIMIT"));
        continue;
      }
      const remainingBytes = Math.min(maxImageBytes, maxTotalBytes - totalBytes);
      if (remainingBytes <= 0) {
        diagnostics.push({ code: "IMAGE_LIMIT", commentId, filename });
        labelsByComment.get(candidate.comment).push(omittedImageLabel(commentId, filename, "IMAGE_LIMIT"));
        continue;
      }
      const url = attachmentUrl(candidate.attachment);
      if (!url) {
        throw new DomainError("IMAGE_UNAVAILABLE", `Attachment ${filename} has no usable URL`, { commentId, filename });
      }
      let downloaded;
      try {
        downloaded = await client.downloadAttachment(url, { maxBytes: remainingBytes });
      } catch (error) {
        if (error?.code === "IMAGE_TOO_LARGE") {
          diagnostics.push({ code: "IMAGE_LIMIT", commentId, filename });
          labelsByComment.get(candidate.comment).push(omittedImageLabel(commentId, filename, "IMAGE_LIMIT"));
          continue;
        }
        throw downloadError(error, commentId, filename);
      }
      const body = downloaded.body;
      const imageType = detectedImageType(body);
      if (!imageType) {
        throw new DomainError("INVALID_IMAGE", `Attachment ${filename} is not a supported image`, { commentId, filename });
      }
      if (!imageType.valid(body)) {
        throw new DomainError("INVALID_IMAGE", `Attachment ${filename} is structurally invalid`, { commentId, filename });
      }
      if (downloaded.contentType !== imageType.contentType) {
        throw new DomainError("IMAGE_TYPE_MISMATCH", `Attachment ${filename} content type does not match its bytes`, { commentId, filename });
      }
      if (body.byteLength > maxImageBytes || totalBytes + body.byteLength > maxTotalBytes) {
        diagnostics.push({ code: "IMAGE_LIMIT", commentId, filename });
        labelsByComment.get(candidate.comment).push(omittedImageLabel(commentId, filename, "IMAGE_LIMIT"));
        continue;
      }
      if (!directory) {
        directory = await mkdtemp(path.join(tempRoot ?? tmpdir(), "taskboard-clickup-images-"));
        await chmod(directory, 0o700);
      }
      ordinal += 1;
      const localPath = path.join(directory, `${String(ordinal).padStart(3, "0")}${imageType.extension}`);
      await writeFile(localPath, body, { mode: 0o600 });
      images.push({
        commentId,
        date: candidate.comment?.date,
        filename,
        contentType: imageType.contentType,
        localPath,
      });
      labelsByComment.get(candidate.comment).push(`- 评论 ${commentId} 图片：${filename}`);
      totalBytes += body.byteLength;
    }

    return {
      textContext: contextFor(selected, labelsByComment),
      images,
      diagnostics,
      cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
