// lib/attachments.ts — files attached to a line's comment.
//
// What: uploads files into the thread's project through the BB SDK, reads them
//   back for thumbnails, and holds the small text helpers built on their names.
// Why: a comment often needs a screenshot or a file, not just words. The file
//   has to reach BB when it is added: marks persist in localStorage across app
//   reloads, and a browser File cannot be kept there, only its uploaded path.
// Design notes:
//   - `useSdk()` is a React hook, and the comment box lives in a content script
//     outside React. The composer banner hands its client over with
//     `setAttachmentClient`; both halves share this module's one instance, the
//     same arrangement as `marksStore()`.
// Gotchas:
//   - The SDK can upload but not delete. A file removed from a comment before
//     sending stays in the project's attachment storage; it just never reaches
//     the agent.

import type { useSdk } from "@get-bb/plugin-sdk/app";
import type { LineAttachment } from "./marks.ts";

export type AttachmentClient = Pick<ReturnType<typeof useSdk>, "projects" | "threads">;

let client: AttachmentClient | null = null;

/** Called by the composer banner once it has an SDK client. */
export function setAttachmentClient(next: AttachmentClient) {
  client = next;
}

function requireClient(): AttachmentClient {
  if (client === null) throw new Error("The message box is not ready yet");
  return client;
}

async function projectOfThread(threadId: string): Promise<string> {
  const thread = await requireClient().threads.get({ threadId });
  return thread.projectId;
}

/**
 * Upload one file into the project that owns `threadId`.
 *
 * Post-conditions: the file is stored by BB, ready to go out with a message.
 * Returns the attachment; rejects with BB's error when the upload fails.
 */
export async function uploadAttachment(threadId: string, file: File): Promise<LineAttachment> {
  const projectId = await projectOfThread(threadId);
  const uploaded = await requireClient().projects.attachments.upload({
    projectId,
    clientFile: file,
    ...(file.type === "" ? {} : { mimeType: file.type }),
  });
  return {
    type: uploaded.type,
    path: uploaded.path,
    name: uploaded.name,
    sizeBytes: uploaded.sizeBytes,
    ...(uploaded.mimeType === undefined ? {} : { mimeType: uploaded.mimeType }),
    ...(uploaded.sourceProjectId === undefined ? {} : { sourceProjectId: uploaded.sourceProjectId }),
  };
}

/** Read an uploaded image back as a Blob, for its thumbnail. */
export async function readAttachmentBlob(threadId: string, attachment: LineAttachment): Promise<Blob> {
  const projectId = attachment.sourceProjectId ?? (await projectOfThread(threadId));
  const { bytes, mimeType } = await requireClient().projects.attachments.read({
    projectId,
    path: attachment.path,
  });
  return new Blob([bytes as BlobPart], { type: mimeType });
}

/**
 * The note shown under a line: the comment, then the attached file names.
 * Returns "" when the mark has neither.
 */
export function commentLabel(mark: {
  comment: string;
  attachments: readonly LineAttachment[];
}): string {
  const comment = mark.comment.trim();
  const files = mark.attachments.length === 0 ? "" : `📎 ${attachmentNames(mark.attachments)}`;
  return [comment, files].filter((part) => part !== "").join("\n");
}

/** "a.png, b.pdf" */
export function attachmentNames(attachments: readonly LineAttachment[]): string {
  return attachments.map((a) => a.name).join(", ");
}

/**
 * The files as the agent should read them: "a.png (a-1793-x1.png), ...".
 *
 * Both names are needed to tell the agent which file belongs to which line.
 * BB shows it an image only by its stored file name, unique and stripped of
 * non-ASCII letters ("снимок.png" becomes "-1793-x1.png"), and any other file
 * by the name the user gave it, stored under a shorter path. Observed on bb 0.48.
 */
export function attachmentReferences(attachments: readonly LineAttachment[]): string {
  return attachments.map((a) => `${a.name} (${a.path})`).join(", ");
}
