#!/usr/bin/env node
/**
 * Read-only status CLI for the dsh-wechat-deploy plugin.
 *
 *   node tools/status-cli.mjs                 # full Chinese report + JSON
 *   node tools/status-cli.mjs --json          # JSON only
 *   node tools/status-cli.mjs --workspace DIR # explicit workspace
 *
 * Safe on a live machine: it only runs read-only PowerShell probes, hashes two
 * files, reads JSON, does one authenticated GET and four TCP connects.
 * Exit code: 0 when the deployment is healthy, 1 when it is not, 2 on setup
 * errors (no workspace).
 */
import { collectStatus, formatStatusReport } from '../src/status.mjs';
import { resolveSettings } from '../src/settings.mjs';

const argv = process.argv.slice(2);
const jsonOnly = argv.includes('--json');
const workspace = valueOf('--workspace');

let settings;
try {
  settings = resolveSettings(workspace === undefined ? {} : { workspace });
} catch (error) {
  console.error(`✗ 读取配置失败：${messageOf(error)}`);
  process.exit(2);
}

let report;
try {
  report = await collectStatus(settings);
} catch (error) {
  console.error(`✗ 体检执行失败：${messageOf(error)}`);
  process.exit(2);
}

if (jsonOnly) {
  const { summary, ...rest } = report;
  console.log(JSON.stringify(rest, null, 2));
} else {
  console.log(formatStatusReport(report));
}
process.exitCode = report.ok ? 0 : 1;

/** @param {string} flag @returns {string|undefined} */
function valueOf(flag) {
  const index = argv.indexOf(flag);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) return undefined;
  return value;
}

/** @param {unknown} error */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}
