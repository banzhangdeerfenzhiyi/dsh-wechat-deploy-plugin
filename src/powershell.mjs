/**
 * PowerShell spawn helper for deploy actions and read-only probes.
 *
 * Two call shapes, both argument-array based (no shell string is ever built from
 * caller data):
 *
 *   - `-File script.ps1 <args…>` for the workspace scripts;
 *   - `-EncodedCommand <base64>` for the short inline probes whose text is a
 *     constant in this repo. Dynamic values travel through environment
 *     variables, never through the command text, so quotes and Chinese paths
 *     cannot break or inject anything.
 *
 * Every child gets a timeout; on expiry the process tree is terminated (a build
 * spawns MSBuild, so killing only PowerShell would leak the compiler).
 */
import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { homedir } from 'node:os';

/** Arguments shared by every invocation. */
const BASE_ARGS = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass'];

/** How long to wait for a killed process before giving up on its exit event. */
const KILL_GRACE_MS = 5_000;

/**
 * Encode a script for `-EncodedCommand` (UTF-16LE base64, the PowerShell wire
 * format). Pure, used by tests to prove the command text round-trips.
 *
 * @param {string} script
 * @returns {string}
 */
export function encodeCommand(script) {
  return Buffer.from(String(script), 'utf16le').toString('base64');
}

/**
 * Build the argv for one invocation.
 *
 * @param {{file?: string, args?: Array<string|number>, command?: string}} spec
 * @returns {string[]}
 */
export function buildPowerShellArgs(spec = {}) {
  const command = typeof spec.command === 'string' ? spec.command : '';
  if (command !== '') return [...BASE_ARGS, '-EncodedCommand', encodeCommand(command)];
  const file = typeof spec.file === 'string' ? spec.file : '';
  if (file === '') throw new Error('执行 PowerShell 需要 file 或 command。');
  const args = Array.isArray(spec.args) ? spec.args.map((value) => String(value)) : [];
  return [...BASE_ARGS, '-File', file, ...args];
}

/**
 * Run one PowerShell invocation.
 *
 * @param {Record<string, any>} settings - Resolved plugin settings.
 * @param {{file?: string, args?: Array<string|number>, command?: string, label?: string}} spec
 * @param {{timeoutMs?: number, env?: Record<string, string>, cwd?: string, signal?: AbortSignal}} [options]
 * @returns {Promise<{code: number, stdout: string, stderr: string, elapsedMs: number, timedOut: boolean, aborted: boolean, commandLabel: string}>}
 */
export async function runPowerShell(settings, spec, options = {}) {
  const args = buildPowerShellArgs(spec);
  const defaultTimeout = Number.isFinite(settings?.timeouts?.probeMs) ? settings.timeouts.probeMs : 30_000;
  const timeoutMs = Number.isFinite(options.timeoutMs)
    ? Math.max(500, Number(options.timeoutMs))
    : defaultTimeout;
  const executable = typeof settings?.powershell === 'string' && settings.powershell !== ''
    ? settings.powershell
    : 'powershell.exe';
  const commandLabel = spec.label ?? (spec.file ? `${executable} -File ${spec.file}` : `${executable} -Command <inline>`);
  const cwd = options.cwd ?? (isDirectory(settings?.workspace) ? settings.workspace : homedir());
  const env = mergeEnv(options.env);

  if (options.signal?.aborted) throw new Error('操作已取消。');

  return await new Promise((resolvePromise, rejectPromise) => {
    const startedAt = Date.now();
    const stdout = [];
    const stderr = [];
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let timer;
    let graceTimer;

    const child = spawn(executable, args, { cwd, env, windowsHide: true });

    /** @param {boolean} byTimeout @param {boolean} byAbort */
    const terminate = (byTimeout, byAbort) => {
      timedOut = timedOut || byTimeout;
      aborted = aborted || byAbort;
      killTree(child);
      if (graceTimer === undefined) {
        graceTimer = setTimeout(() => settle(-1), KILL_GRACE_MS);
        graceTimer.unref?.();
      }
    };

    /**
     * @param {number} code
     */
    const settle = (code) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      if (graceTimer !== undefined) clearTimeout(graceTimer);
      options.signal?.removeEventListener?.('abort', onAbort);
      resolvePromise({
        code,
        stdout: cleanStream(decodeOutput(Buffer.concat(stdout))),
        stderr: cleanStream(decodeOutput(Buffer.concat(stderr))),
        elapsedMs: Date.now() - startedAt,
        timedOut,
        aborted,
        commandLabel,
      });
    };

    /** AbortSignal handler. */
    function onAbort() {
      terminate(false, true);
    }

    timer = setTimeout(() => terminate(true, false), timeoutMs);
    timer.unref?.();
    options.signal?.addEventListener?.('abort', onAbort, { once: true });

    child.stdout?.on('data', (chunk) => stdout.push(chunk));
    child.stderr?.on('data', (chunk) => stderr.push(chunk));
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      if (graceTimer !== undefined) clearTimeout(graceTimer);
      options.signal?.removeEventListener?.('abort', onAbort);
      rejectPromise(new Error(`无法启动 PowerShell（${executable}）：${error.message}`));
    });
    child.once('close', (code) => settle(typeof code === 'number' ? code : -1));
  });
}

/**
 * Run a workspace script with explicit arguments.
 *
 * @param {Record<string, any>} settings
 * @param {string} file
 * @param {Array<string|number>} [args]
 * @param {{timeoutMs?: number, env?: Record<string, string>, signal?: AbortSignal}} [options]
 */
export function runPowerShellScript(settings, file, args = [], options = {}) {
  return runPowerShell(settings, { file, args }, options);
}

/**
 * Run a constant inline probe. Dynamic values must go through `options.env`.
 *
 * @param {Record<string, any>} settings
 * @param {string} command
 * @param {{timeoutMs?: number, env?: Record<string, string>, signal?: AbortSignal, label?: string}} [options]
 */
export function runPowerShellCommand(settings, command, options = {}) {
  return runPowerShell(settings, { command, label: options.label ?? 'inline probe' }, options);
}

/**
 * Last lines of command output, capped by lines and characters.
 *
 * @param {unknown} text
 * @param {number} [lineCount]
 * @param {number} [maxChars]
 * @returns {string}
 */
export function tail(text, lineCount = 40, maxChars = 6_000) {
  const value = String(text ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trimEnd();
  if (value === '') return '';
  let lines = value.split('\n');
  let truncated = false;
  if (lines.length > lineCount) {
    lines = lines.slice(-lineCount);
    truncated = true;
  }
  let joined = lines.join('\n');
  if (joined.length > maxChars) {
    joined = joined.slice(-maxChars);
    truncated = true;
  }
  return truncated ? `…（输出已截断）\n${joined}` : joined;
}

/**
 * Decode process output: PowerShell 5.1 may still emit the console code page
 * (GBK on this machine) even though probes request UTF-8, so fall back when the
 * UTF-8 decode is clearly wrong.
 *
 * @param {Buffer} buffer
 * @returns {string}
 */
export function decodeOutput(buffer) {
  if (!buffer || buffer.length === 0) return '';
  const utf8 = buffer.toString('utf8');
  if (!utf8.includes('\uFFFD')) return stripBom(utf8);
  try {
    const gbk = new TextDecoder('gbk').decode(buffer);
    if (replacementCount(gbk) < replacementCount(utf8)) return stripBom(gbk);
  } catch {
    /* no GBK decoder in this Node build */
  }
  return stripBom(utf8);
}

/**
 * Clean one captured stream: drop the CLIXML progress envelope PowerShell writes
 * to stderr when redirected, keeping any real error text inside it.
 *
 * @param {unknown} text
 * @returns {string}
 */
export function cleanStream(text) {
  const value = String(text ?? '');
  const marker = value.indexOf('#< CLIXML');
  if (marker < 0) return value.trim();
  const head = value.slice(0, marker).trim();
  const xml = value.slice(marker);
  const messages = [];
  for (const match of xml.matchAll(/<S S="(?:Error|Warning)">([^<]*)<\/S>/g)) {
    const message = decodeClixmlText(match[1]).trim();
    if (message !== '') messages.push(message);
  }
  return [head, ...messages].filter(Boolean).join('\n');
}

/**
 * @param {unknown} path
 * @returns {boolean}
 */
function isDirectory(path) {
  if (typeof path !== 'string' || path === '') return false;
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Merge child environment, dropping undefined values (spawn rejects them).
 *
 * @param {Record<string, string>} [overrides]
 * @returns {Record<string, string>}
 */
function mergeEnv(overrides) {
  const merged = {};
  for (const [key, value] of Object.entries({ ...process.env, ...(overrides ?? {}) })) {
    if (typeof value === 'string') merged[key] = value;
  }
  return merged;
}

/**
 * Terminate a child and its descendants (Windows). Only ever used on processes
 * this module started.
 *
 * @param {import('node:child_process').ChildProcess} child
 */
function killTree(child) {
  try {
    child.kill();
  } catch {
    /* already gone */
  }
  const pid = child.pid;
  if (!Number.isFinite(pid) || pid <= 0) return;
  try {
    const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    killer.once('error', () => {});
  } catch {
    /* best effort */
  }
}

/** @param {string} text @returns {string} */
function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** @param {string} text @returns {number} */
function replacementCount(text) {
  let count = 0;
  for (const char of text) if (char === '\uFFFD') count += 1;
  return count;
}

/**
 * Decode CLIXML character escapes (`_x000D_`) and the five XML entities.
 *
 * @param {string} text
 * @returns {string}
 */
function decodeClixmlText(text) {
  return text
    .replace(/_x([0-9A-Fa-f]{4})_/g, (_match, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}
