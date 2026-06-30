import * as path from "node:path";
import type { LinearIssue, WorkerPromptAttachment } from "../types.js";

export function extractMarkdownImageUrls(markdown?: string): string[] {
  if (!markdown) return [];
  const urls = new Set<string>();
  const imagePattern = /!\[[^\]]*\]\(([^)\s]+)[^)]*\)/g;
  for (const match of markdown.matchAll(imagePattern)) urls.add(match[1].replace(/^<|>$/g, ""));
  return Array.from(urls);
}

export function extensionForMimeType(mimeType?: string): string {
  if (mimeType === "image/jpeg") return ".jpg";
  if (mimeType === "image/gif") return ".gif";
  if (mimeType === "image/webp") return ".webp";
  if (mimeType === "image/svg+xml") return ".svg";
  return ".png";
}

export function extensionForAttachmentContent(content: string): string {
  const trimmed = content.trimStart().toLowerCase();
  if (trimmed.startsWith("<!doctype html") || trimmed.startsWith("<html")) return ".html";
  if (trimmed.startsWith("#") || trimmed.includes("\n## ")) return ".md";
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return ".json";
  return ".txt";
}

function pathForPrompt(filePath: string, worktree: string): string {
  const relativePath = path.relative(worktree, filePath);
  return relativePath.startsWith("..") ? filePath : relativePath;
}

function markdownWithLocalImageReferences(
  markdown: string | undefined,
  attachments: WorkerPromptAttachment[],
  worktree: string,
): string {
  if (!markdown) return "(no description)";

  const imageAttachmentsByUrl = new Map(
    attachments
      .filter((a) => a.url && a.localPath && a.localPath.match(/\.(png|jpe?g|gif|webp|svg)$/i))
      .map((a) => [a.url!, a]),
  );
  if (!imageAttachmentsByUrl.size) return markdown;

  const imagePattern = /!\[([^\]]*)\]\((<[^>]+>|[^\s)]+)([^)]*)\)/g;
  return markdown.replace(imagePattern, (fullMatch, _alt: string, rawUrl: string) => {
    const url = rawUrl.replace(/^<|>$/g, "");
    const attachment = imageAttachmentsByUrl.get(url);
    if (!attachment?.localPath) return fullMatch;
    return `${fullMatch}\n\n> Local image file: \`${pathForPrompt(attachment.localPath, worktree)}\` (${attachment.id})\n`;
  });
}

function formatWorkerPromptAttachments(attachments: WorkerPromptAttachment[], worktree: string): string {
  if (!attachments.length) return "No separate Linear attachments returned by Linear MCP.";
  return attachments.map((attachment, index) => {
    const lines = [
      `### Attachment ${index + 1}: ${attachment.title || attachment.id}`,
      `- id: ${attachment.id}`,
      attachment.subtitle ? `- subtitle: ${attachment.subtitle}` : undefined,
      attachment.url ? `- url: ${attachment.url}` : undefined,
      attachment.localPath ? `- saved file: ${pathForPrompt(attachment.localPath, worktree)}` : undefined,
      attachment.error ? `- fetch error: ${attachment.error}` : undefined,
    ].filter(Boolean) as string[];
    if (attachment.contentPreview) {
      lines.push(
        "",
        "Content preview:",
        "```",
        attachment.contentPreview,
        attachment.contentPreview.length >= 12_000 ? "\n[truncated; read the saved file for full content]" : "",
        "```",
      );
    }
    return lines.join("\n");
  }).join("\n\n");
}

export function buildWorkerPrompt(
  issue: LinearIssue,
  branch: string,
  worktree: string,
  attachments: WorkerPromptAttachment[] = [],
): string {
  const inlineImageUrls = extractMarkdownImageUrls(issue.description);
  const description = markdownWithLocalImageReferences(issue.description, attachments, worktree);
  return `You are implementing Linear issue ${issue.id}.

Title:
${issue.title}

Description:
${description}

URL:
${issue.url || "(no url)"}

Inline image URLs found in the description:
${inlineImageUrls.length ? inlineImageUrls.map((url) => `- ${url}`).join("\n") : "(none)"}

Linear attachments:
${formatWorkerPromptAttachments(attachments, worktree)}

Branch:
${branch}

Worktree:
${worktree}

Instructions:
- You are running in a dedicated git worktree. Keep changes scoped to this issue.
- Inspect existing code patterns before editing.
- Add or update tests when appropriate.
- Run relevant formatting, linting, typecheck, and tests for affected packages before finishing.
- Read the Linear attachments saved above before implementing when they are relevant.
- Inspect inline image URLs from the description when matching UI screenshots.
- Use Linear MCP tools if you need to reread or update the issue.
- If blocked, comment on the Linear issue with the blocker and stop.
`;
}
