/**
 * Status values arrive from the API in English (`ready`, `completed`, `blocked`).
 * They are data, but in a Chinese console they read as untranslated UI, so each
 * known value gets a label; anything unknown falls through untouched.
 */
const LABELS: Record<string, string> = {
  // users
  active: 'Active',
  unverified: 'Unverified',
  blocked: 'Blocked',
  // sites & deployments
  ready: 'Ready',
  draft: 'Draft',
  building: 'Building',
  deployed: 'Deployed',
  published: 'Published',
  // executions
  completed: 'Completed',
  failed: 'Failed',
  running: 'Running',
  queued: 'Queued',
  timeout: 'Timed out',
  // messages
  sent: 'Sent',
  delivered: 'Delivered',
};

export const statusLabel = (value: string) => LABELS[value] ?? value;
