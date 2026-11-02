/**
 * How tools map to permission points.
 *
 * Shared by the live agent and the offline rule engine so both respect the same
 * boundary — the rule engine is not a privileged path just because it does not
 * call a model.
 */

/** Read-only tools run without asking. Everything else writes. */
const READ_ONLY = /^(list_|get_|explain_|search_|preview_)/;

export const isDangerous = (name: string) => !READ_ONLY.test(name);

export function permissionFor(name: string): string | null {
  if (name.includes('api_key')) return isDangerous(name) ? 'keys.write' : 'keys.read';
  if (name.includes('webhook')) return isDangerous(name) ? 'project.write' : 'project.read';
  if (name.includes('member')) return isDangerous(name) ? 'members.write' : 'members.read';
  if (name === 'create_project') return 'project.write';
  if (name === 'list_projects') return 'project.read';
  if (name === 'execute_function') return 'functions.execute';
  if (name === 'deploy_site') return 'sites.deploy';
  if (/collection|document|index|attribute|query/.test(name)) return isDangerous(name) ? 'databases.write' : 'databases.read';
  if (/file|bucket/.test(name)) return isDangerous(name) ? 'storage.write' : 'storage.read';
  if (/function|execution|schedule|git|version/.test(name)) return isDangerous(name) ? 'functions.write' : 'functions.read';
  if (/site/.test(name)) return isDangerous(name) ? 'sites.write' : 'sites.read';
  if (/user/.test(name)) return isDangerous(name) ? 'users.write' : 'users.read';
  if (/message/.test(name)) return isDangerous(name) ? 'messaging.write' : 'messaging.read';
  if (/metric|log|setting/.test(name)) return 'project.read';
  return null;
}
