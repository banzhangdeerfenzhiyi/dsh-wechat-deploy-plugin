/**
 * Profile-patch helpers for the dsh-wechat-deploy installer.
 *
 * The patch is a YAML array of loader entries; this plugin owns exactly one
 * `- insert:` block, fenced by two comment markers. Pure functions so the
 * installer's round-trip (insert → replace → remove) is unit-testable without
 * touching a real profile.
 */

/** First marker line of the managed block (compared trimmed). */
export const BLOCK_BEGIN = '# >>> dsh-wechat-deploy (managed) >>>';

/** Last marker line of the managed block (compared trimmed). */
export const BLOCK_END = '# <<< dsh-wechat-deploy <<<';

/** Loader entry id. */
export const PLUGIN_ID = 'dsh-wechat-deploy';

/**
 * `file:///…` URL for a Windows path, as the loader expects.
 *
 * @param {string} installDir
 * @returns {string}
 */
export function fileUrl(installDir) {
  const posix = String(installDir).replace(/\\/g, '/').replace(/^\/+/, '');
  return `file:///${posix}`;
}

/**
 * Build the managed block (markers included, no trailing newline).
 *
 * @param {{installDir: string, workspace: string, hookUrl: string, expectedVersion: string, powershell?: string}} options
 * @returns {string}
 */
export function buildManagedBlock(options) {
  const lines = [
    BLOCK_BEGIN,
    '- insert:',
    `    - id: ${PLUGIN_ID}`,
    `      name: "${fileUrl(options.installDir)}/index.mjs"`,
    '      config:',
    '        enabled: true',
    '        promptEnabled: true',
    `        workspace: "${options.workspace}"`,
    `        hookUrl: "${options.hookUrl}"`,
    `        expectedVersion: "${options.expectedVersion}"`,
  ];
  if (typeof options.powershell === 'string' && options.powershell.trim() !== '') {
    lines.push(`        powershell: "${options.powershell.trim()}"`);
  }
  lines.push(BLOCK_END);
  return lines.join('\n');
}

/**
 * Remove every managed block (including a trailing reload-touch comment).
 *
 * @param {string} text
 * @returns {{text: string, removed: number, unterminated: boolean}}
 */
export function stripManagedBlock(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const kept = [];
  let inside = false;
  let removed = 0;
  let sawEnd = true;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === BLOCK_BEGIN) {
      inside = true;
      removed += 1;
      sawEnd = false;
      continue;
    }
    if (inside && trimmed === BLOCK_END) {
      inside = false;
      sawEnd = true;
      continue;
    }
    if (inside) continue;
    if (trimmed.startsWith('# reload touch ')) continue;
    kept.push(line);
  }
  return { text: kept.join('\n'), removed, unterminated: removed > 0 && !sawEnd };
}

/**
 * Remove a standalone empty-array document (`[]`) so appending a sequence entry
 * cannot create the invalid mix `[]` + `- insert:` at the top level. A profile
 * patch that is still `[]` means "no entries yet".
 *
 * @param {string} text
 * @returns {string}
 */
function dropEmptyDocumentMarker(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .filter((line) => !/^\s*\[\s*\]\s*$/.test(line))
    .join('\n');
}

/**
 * Insert the managed block, replacing any previous one. The user's own entries
 * stay untouched and keep their order.
 *
 * @param {string} text
 * @param {string} block
 * @returns {{text: string, replaced: boolean, removed: number, unterminated: boolean}}
 */
export function upsertManagedBlock(text, block) {
  const stripped = stripManagedBlock(dropEmptyDocumentMarker(text));
  const base = stripped.text.replace(/\s+$/, '');
  const header = base === '' ? '' : `${base}\n\n`;
  return {
    text: `${header}${block}\n`,
    replaced: stripped.removed > 0,
    removed: stripped.removed,
    unterminated: stripped.unterminated,
  };
}

/**
 * Count managed blocks in a patch text (installer self-check).
 *
 * @param {string} text
 * @returns {number}
 */
export function countManagedBlocks(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .filter((line) => line.trim() === BLOCK_BEGIN).length;
}
