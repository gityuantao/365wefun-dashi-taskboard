import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DomainError } from "../domain/errors.mjs";

const IMAGE_TYPES = [
  { contentType: "image/png", extension: ".png", matches: (body) => startsWith(body, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
  { contentType: "image/jpeg", extension: ".jpg", matches: (body) => startsWith(body, [0xff, 0xd8, 0xff]) },
  { contentType: "image/webp", extension: ".webp", matches: (body) => startsWith(body, [0x52, 0x49, 0x46, 0x46]) && startsWith(body, [0x57, 0x45, 0x42, 0x50], 8) },
  { contentType: "image/gif", extension: ".gif", matches: (body) => startsWith(body, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) || startsWith(body, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]) },
];

function startsWith(body, signature, offset = 0) {
  return body.length >= offset + signature.length
    && signature.every((byte, index) => body[offset + index] === byte);
}

function recentComments(comments, limit) {
  if (!Array.isArray(comments) || comments.length === 0) return [];
  const allHaveDates = comments.every((comment) => Number.isFinite(Number(comment?.date)));
  return allHaveDates
    ? [...comments].sort((left, right) => Number(right.date) - Number(left.date)).slice(0, limit)
    : comments.slice(-limit);
}

function attachmentValues(comment) {
  return [comment?.attachments, comment?.images, comment?.image]
    .flatMap((value) => Array.isArray(value) ? value : value ? [value] : []);
}

function attachmentUrl(attachment) {
  if (typeof attachment === "string") return attachment;
  return attachment?.url ?? attachment?.image_url ?? attachment?.download_url ?? null;
}

function attachmentFilename(attachment, ordinal) {
  if (typeof attachment === "object" && attachment !== null) {
    for (const value of [attachment.title, attachment.filename, attachment.name]) {
      if (typeof value === "string" && value.trim() !== "") return value.trim();
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
    if (text) lines.push(`- ${text}`);
    lines.push(...(labelsByComment.get(comment) ?? []));
  }
  return lines.length > 0 ? lines.join("\n") : null;
}

function omittedImageLabel(commentId, filename, code) {
  return `- 评论 ${commentId} 图片未读取：${filename}（${code}）`;
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
  const candidates = selected.flatMap((comment) => attachmentValues(comment).map((attachment) => ({
    comment,
    attachment,
  }))).map((candidate, index) => ({ ...candidate, ordinal: index + 1 }));
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
    for (const candidate of candidates) {
      const filename = attachmentFilename(candidate.attachment, candidate.ordinal);
      const commentId = String(candidate.comment?.id ?? "unknown");
      if (images.length >= maxImages) {
        diagnostics.push({ code: "IMAGE_LIMIT", commentId, filename });
        labelsByComment.get(candidate.comment).push(omittedImageLabel(commentId, filename, "IMAGE_LIMIT"));
        continue;
      }
      const url = attachmentUrl(candidate.attachment);
      if (!url) {
        throw new DomainError("IMAGE_UNAVAILABLE", `Attachment ${filename} has no usable URL`, { commentId, filename });
      }
      const downloaded = await client.downloadAttachment(url);
      const body = downloaded.body;
      const imageType = detectedImageType(body);
      if (!imageType) {
        throw new DomainError("INVALID_IMAGE", `Attachment ${filename} is not a supported image`, { commentId, filename });
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
