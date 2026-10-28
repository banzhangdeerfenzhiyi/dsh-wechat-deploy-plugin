/**
 * Append-only diagnostics for the deploy plugin (`~/.dsh/wechat-deploy`).
 *
 * A failed deploy is mostly silent stages (prepare / launch / wait / health), so
 * one line per stage is what makes a support report actionable. Logging must
 * never break a deploy.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * @param {string} [subdir]
 * @returns {(line: string) => void}
 */
export function createLogger(subdir = 'wechat-deploy') {
  let file;
  try {
    const dir = join(homedir(), '.dsh', subdir);
    mkdirSync(dir, { recursive: true });
    file = join(dir, 'wechat-deploy.log');
  } catch {
    file = undefined;
  }
  return (line) => {
    const text = `${new Date().toISOString()} ${line}`;
    try {
      if (file !== undefined) appendFileSync(file, `${text}\n`);
    } catch {
      /* logging must never break a deploy */
    }
  };
}

/** @param {unknown} error */
export function messageOf(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}
