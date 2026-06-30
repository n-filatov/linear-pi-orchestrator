import type { LinearIssue, ListIssuesArgs, SaveIssueArgs, ExtractedImage } from "../types.js";

export interface LinearClient {
  listIssues(args: ListIssuesArgs): Promise<LinearIssue[]>;
  getIssue(id: string): Promise<LinearIssue>;
  saveIssue(args: SaveIssueArgs): Promise<void>;
  saveComment(issueId: string, body: string): Promise<void>;
  getAttachment(id: string): Promise<unknown>;
  extractImages(markdown: string): Promise<ExtractedImage[]>;
  shutdown(): Promise<void>;
}
