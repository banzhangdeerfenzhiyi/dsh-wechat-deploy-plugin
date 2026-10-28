#!/usr/bin/env node
/**
 * Install / uninstall the dsh-wechat-deploy host plugin.
 *
 *   node tools/install.mjs                     # copy to <DSH_HOME>/dsh-wechat-deploy-plugin + patch profiles
 *   node tools/install.mjs --remove            # drop the managed block (files stay)
 *   node tools/install.mjs --patch-only        # only patch; assume the files are in place
 *   node tools/install.mjs --target DIR        # custom install directory
 *   node tools/install.mjs --dsh-home DIR      # test a different DSH home
 *   node tools/install.mjs --profile DIR       # patch one profile instead of all
 *   node tools/install.mjs --workspace DIR     # explicit WeChatAgent workspace
 *
 * The managed block is one `- insert:` entry wrapped in marker comments, so a
 * re-run replaces it instead of stacking duplicates. Every touched patch file
 * gets a timestamped backup first.
 *
 * This tool is intentionally safe by default: it never touches packages, never
 * starts DSH and never edits entries it does not own.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BLOCK_BEGIN, buildManagedBlock, countManagedBlocks, stripManagedBlock, upsertManagedBlock } from '../src/patch.mjs';
import { resolveSettings, resolveWorkspace, toPosix } from '../src/settings.mjs';

const PLUGIN_ROOT = toPosix(dirname(dirname(fileURLToPath(import.meta.url))));
const argv = process.argv.slice(2);

const options = {
  remove: argv.includes('--remove'),
  patchOnly: argv.includes('--patch-only'),
  help: argv.includes('--help') || argv.includes('-h'),
  target: valueOf('--target'),
  dshHome: valueOf('--dsh-home'),
  profile: valueOf('--profile'),
  workspace: valueOf('--workspace'),
};

if (options.help) {
  printUsage();
  process.exit(0);
}

const dshHome = toPosix(options.dshHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh'));
const installDir = toPosix(options.target !== undefined ? resolve(options.target) : join(dshHome, 'dsh-wechat-deploy-plugin'));
const profiles = resolveProfiles(dshHome, options.profile);

if (profiles.length === 0) {
  console.error(`没找到任何 profile 的 cordis.patch.yml（DSH_HOME=${dshHome}）。`);
  process.exit(1);
}

if (options.remove) {
  let failures = 0;
  for (const patchFile of profiles) {
    try {
      const before = readFileSync(patchFile, 'utf8');
      const stripped = stripManagedBlock(before);
      if (stripped.removed === 0) {
        console.log(`· ${patchFile}：没有本插件的托管块，跳过。`);
        continue;
      }
      writeWithBackup(patchFile, normalizePatchAfterRemove(stripped.text));
      console.log(`✓ ${patchFile}：已移除托管块（${stripped.removed} 处）${stripped.unterminated ? '（原文件缺少结束标记，已清理到文件末尾）' : ''}`);
    } catch (error) {
      failures += 1;
      console.error(`✗ ${patchFile}：${messageOf(error)}`);
    }
  }
  console.log('');
  console.log(failures === 0 ? '卸载完成：插件文件保留，重启 DeepSeek Harness 后生效。' : `有 ${failures} 个 patch 处理失败。`);
  process.exit(failures === 0 ? 0 : 1);
}

// ---- workspace + config -----------------------------------------------------
const detected = resolveWorkspace(options.workspace ?? '', process.env);
if (!detected.valid) {
  console.warn(`⚠️ 没有检测到有效的 WeChatAgent 工作区，先写入候选路径：${detected.path}`);
  console.warn('   安装后请在 profile patch 里把 workspace 改成真实路径。');
}
const settings = resolveSettings({
  workspace: options.workspace ?? detected.path,
});

if (!options.patchOnly) {
  try {
    copyPlugin(installDir);
  } catch (error) {
    console.error(`✗ 复制插件失败：${messageOf(error)}`);
    process.exit(1);
  }
}

const block = buildManagedBlock({
  installDir,
  workspace: settings.workspace,
  hookUrl: settings.hookUrl,
  expectedVersion: settings.expectedVersion,
  powershell: settings.powershell,
});

let failures = 0;
for (const patchFile of profiles) {
  try {
    const before = readFileSync(patchFile, 'utf8');
    const next = upsertManagedBlock(before, block);
    writeWithBackup(patchFile, next.text);
    const count = countManagedBlocks(next.text);
    if (count !== 1) throw new Error(`写入后托管块数量为 ${count}，预期 1。请检查文件。`);
    console.log(`✓ ${patchFile}：${next.replaced ? '已替换' : '已插入'}托管块。`);
  } catch (error) {
    failures += 1;
    console.error(`✗ ${patchFile}：${messageOf(error)}`);
  }
}

console.log('');
console.log(`插件目录：${installDir}`);
console.log(`工作区：${settings.workspace}（来源 ${detected.source}）`);
console.log(`期望版本：${settings.expectedVersion} · Hook：${settings.hookUrl}`);
console.log('');
console.log('下一步：重启 DeepSeek Harness 让 host 插件加载（无需热重载）。');
console.log('验证：node tools/status-cli.mjs；或在 DSH 里调用 wechat_deploy_status。');
console.log(`回滚：node tools/install.mjs --remove${options.dshHome ? ` --dsh-home "${dshHome}"` : ''}`);
process.exit(failures === 0 ? 0 : 1);

// ---- helpers ----------------------------------------------------------------

/** @param {string} flag @returns {string|undefined} */
function valueOf(flag) {
  const index = argv.indexOf(flag);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) return undefined;
  return value;
}

/** @param {string} dshHomePath @param {string|undefined} only */
function resolveProfiles(dshHomePath, only) {
  if (typeof only === 'string' && only.trim() !== '') {
    const file = join(resolve(only), 'cordis.patch.yml');
    return existsSync(file) ? [toPosix(file)] : [];
  }
  const root = join(dshHomePath, 'profiles');
  let entries = [];
  try {
    entries = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => toPosix(join(root, entry.name, 'cordis.patch.yml')))
      .filter((file) => existsSync(file))
      .sort();
  } catch {
    return [];
  }
  return entries;
}

/** @param {string} target */
function copyPlugin(target) {
  const source = resolve(PLUGIN_ROOT);
  const destination = resolve(target);
  if (source === destination) {
    console.log(`插件就地在 ${target}，跳过复制。`);
    return;
  }
  if (destination.startsWith(`${source}${sep}`)) {
    throw new Error(`目标目录不能放在插件源码里面：${target}`);
  }
  console.log(`复制插件：${PLUGIN_ROOT} -> ${target}`);
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(destination, { recursive: true });
  cpSync(source, destination, {
    recursive: true,
    filter: (entry) => {
      const normalized = toPosix(entry);
      if (normalized.includes('/node_modules')) return false;
      if (normalized.includes('/.git/')) return false;
      if (normalized.includes('/.work')) return false;
      return true;
    },
  });
  if (!statSync(join(destination, 'index.mjs')).isFile()) throw new Error('复制后缺少 index.mjs。');
}

/** @param {string} file @param {string} content */
function writeWithBackup(file, content) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  writeFileSync(`${file}.bak-${stamp}`, readFileSync(file));
  writeFileSync(file, content);
}

/** @param {unknown} error */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Keep a patch file valid after removing our block: a top-level array document
 * that no longer has entries must be `[]`, never a comment-only file.
 *
 * @param {string} text
 * @returns {string}
 */
function normalizePatchAfterRemove(text) {
  const lines = String(text ?? '')
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '[]');
  const body = lines.join('\n').replace(/\s+$/, '');
  const hasEntries = body.split(/\r?\n/).some((line) => /^\s*-\s/.test(line));
  if (!hasEntries) return `${body === '' ? '' : `${body}\n\n`}[]\n`;
  return `${body}\n`;
}

function printUsage() {
  console.log(
    [
      'dsh-wechat-deploy 安装器',
      '',
      '用法：node tools/install.mjs [选项]',
      '',
      '  --target DIR      安装到指定目录（默认 <DSH_HOME>/dsh-wechat-deploy-plugin）',
      '  --dsh-home DIR    使用指定的 DSH_HOME（测试用，默认环境变量 DSH_HOME 或 ~/.dsh）',
      '  --profile DIR     只修改一个 profile 目录（默认所有含 cordis.patch.yml 的 profile）',
      '  --workspace DIR   显式指定 WeChatAgent 工作区（默认自动检测）',
      '  --patch-only      只改 patch，不复制文件',
      '  --remove          只移除托管块（插件文件保留）',
      '  --help            显示本说明',
      '',
      `托管块标记：${BLOCK_BEGIN}`,
    ].join('\n'),
  );
}
