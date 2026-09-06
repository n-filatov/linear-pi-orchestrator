import type { WorkflowJobStatus } from "@task-relay/domain";

export interface WorkflowJobOutcome {
  status: WorkflowJobStatus;
  outputs?: Record<string, unknown>;
  operation?: Record<string, unknown>;
  retryAt?: string;
  error?: string;
  message?: string;
}
