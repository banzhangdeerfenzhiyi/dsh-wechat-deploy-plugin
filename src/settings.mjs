/**
 * Settings resolution for the dsh-wechat-deploy host plugin.
 *
 * Everything the plugin touches is derived here from one workspace root, with an
 * explicit override for each value, so a deploy step never has to guess. The
 * workspace itself is auto-detected through the documented candidates; a
 * configured workspace always wins even when it does not validate, because a
 * typo must be reported instead of silently deploying another installation.
 *
 * Paths are normalized to forward slashes: Node accepts them on Windows and it
 * keeps reports, patches and tests identical everywhere.
 */
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

/** The WeChatAgent workspace known on this machine (auto-detect candidate). */
export const DEFAULT_WORKSPACE = ''; // 空 = 自动探测（WECHATAGENT_WORKSPACE / ~/Documents/data/workspace / <DSH_HOME>/wechatagent）

/** Local native hook base URL from config/wechatagent.json. */
export const DEFAULT_HOOK_URL = 'http://127.0.0.1:30001';

/** Desktop WeChat install path lives here (HKCU, no admin rights needed). */
export const DEFAULT_REGISTRY_KEY = 'HKCU:\\Software\\Tencent\\Weixin';

/** Hook/client version this deployment is pinned to. */
export const DEFAULT_EXPECTED_VERSION = '4.1.10.27';

/** Ports from config/wechatagent.json; overridable per deployment. */
export const DEFAULT_PORTS = {
  weflow: 5031,
  onebot: 11229,
  adapter: 8766,
  dshPlugin: 11230,
};

/** Script entry points, relative to the workspace scripts directory. */
export const SCRIPTS = {
  launch: 'launch-hook-wechat.ps1',
  build: 'build-hook.ps1',
  deploy: 'deploy-hook.ps1',
  manage: 'manage.ps1',
  health: 'hook-client-health.ps1',
  pin: 'pin-hook-client.ps1',
};

const DEFAULT_TIMEOUTS = {
  /** One /WeChatAgent/health request. */
  healthMs: 5_000,
  /** One read-only PowerShell probe (processes + registry + file versions). */
  probeMs: 30_000,
  prepareMs: 180_000,
  launchMs: 240_000,
  restartMs: 300_000,
  /** A native rebuild compiles the whole DLL; 15 minutes is the documented cap. */
  buildMs: 900_000,
  servicesMs: 240_000,
  /** How long a restart waits for the pinned client processes to disappear. */
  stopWaitMs: 30_000,
  stopPollMs: 800,
};

/** The persona-facing rules injected into social WeChat sessions only. */
export const DEFAULT_PROMPT = [
  '微信 Hook 部署规则：这台机器上有一套真实的部署工具（wechat_deploy_*），可以在对话里检查、准备、启动、重启和构建微信 Hook（版本 4.1.10.27）。',
  '- 用户问“hook 怎么样/为什么微信没反应/检查一下/版本对不对/能不能发消息” → 先调用 wechat_deploy_status，再用中文说结论：期望版本、Hook 是否 ready、匹配客户端版本、version.dll 校验、端口与托管服务。',
  '- 用户说“部署/准备/打开微信/修复/重启/升级 hook/编译/重新构建” → 先 status，再按 nextSteps 依次 prepare → launch（修复用 restart）；每个写操作都要带 confirm: true。',
  '- 只有 status/health 显示 startupState=ready 且 version=4.1.10.27 时才可以说“就绪”；不要凭猜测或历史记录说已经好了。',
  '- launch/restart 会真的启动匹配微信：执行前提醒对方先从托盘完全退出桌面微信（工具会拒绝在有其他微信运行时继续），并说明可能需要重新登录。',
  '- wechat_deploy_restart 只会结束匹配客户端目录下的 Weixin.exe，不会结束桌面微信；不要声称自己关了桌面微信。',
  '- 构建可能要好几分钟：先说“正在构建”，别因为慢就当作失败。',
  '- 不要编造版本号、端口、pid；失败时把工具返回的中文原因和 nextSteps 简短转述，不要自己发明命令。',
  '- 一轮最多做一次部署动作；群聊里只给结论，不要贴大段输出。',
].join('\n');

/**
 * Normalize a Windows path for reports, comparisons and file access.
 *
 * @param {unknown} value
 * @returns {string} Forward-slash path, or an empty string.
 */
export function toPosix(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (trimmed === '') return '';
  const replaced = trimmed.replace(/\\/g, '/');
  if (/^[A-Za-z]:\/?$/.test(replaced)) return `${replaced[0].toUpperCase()}:/`;
  return replaced.replace(/\/+$/, '');
}

/** @param {string} path @returns {boolean} */
export function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** @param {string} path @returns {boolean} */
export function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Read a JSON file without throwing; callers report the error instead.
 *
 * @param {string} file
 * @returns {{ok: boolean, value: unknown, error: string}}
 */
export function readJsonFile(file) {
  try {
    const text = readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    return { ok: true, value: JSON.parse(text), error: '' };
  } catch (error) {
    return { ok: false, value: undefined, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * A WeChatAgent workspace is recognized by its config file and state directory.
 *
 * @param {string} path
 * @returns {boolean}
 */
export function isWorkspace(path) {
  if (typeof path !== 'string' || path.trim() === '') return false;
  return isFile(join(path, 'config', 'wechatagent.json')) && isDirectory(join(path, 'state'));
}

/**
 * DSH home, honouring DSH_HOME (used by the installer and by tests).
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {string}
 */
export function dshHome(env = process.env) {
  const configured = typeof env?.DSH_HOME === 'string' ? env.DSH_HOME.trim() : '';
  return toPosix(configured !== '' ? configured : join(homedir(), '.dsh'));
}

/**
 * Auto-detect candidates, in priority order. The configured value is handled by
 * `resolveWorkspace` itself so a bad override is not silently replaced.
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {Array<{path: string, source: string}>}
 */
export function workspaceCandidates(env = process.env) {
  const candidates = [];
  const push = (value, source) => {
    const path = toPosix(value);
    if (path === '' || candidates.some((item) => item.path === path)) return;
    candidates.push({ path, source });
  };
  push(env?.WECHATAGENT_WORKSPACE, 'env:WECHATAGENT_WORKSPACE');
  push(DEFAULT_WORKSPACE, 'default');
  push(join(homedir(), 'Documents', 'data', 'workspace'), 'home:Documents/data/workspace');
  push(join(dshHome(env), 'wechatagent'), 'dsh-home:wechatagent');
  return candidates;
}

/**
 * Resolve the workspace: explicit config first, then the documented candidates.
 *
 * @param {unknown} configured
 * @param {Record<string, string|undefined>} [env]
 * @returns {{path: string, source: string, valid: boolean}}
 */
export function resolveWorkspace(configured, env = process.env) {
  const explicit = toPosix(configured);
  if (explicit !== '') return { path: explicit, source: 'config', valid: isWorkspace(explicit) };
  for (const candidate of workspaceCandidates(env)) {
    if (isWorkspace(candidate.path)) return { ...candidate, valid: true };
  }
  const fallback = workspaceCandidates(env)[0];
  return {
    path: fallback?.path ?? toPosix(DEFAULT_WORKSPACE),
    source: fallback?.source ?? 'default',
    valid: false,
  };
}

/**
 * Resolve every deployment setting.
 *
 * @param {Record<string, unknown>} [config] - Patch configuration.
 * @param {Record<string, string|undefined>} [env] - Process environment (tests inject one).
 * @returns {Record<string, any>} Resolved settings; see README for the field list.
 */
export function resolveSettings(config = {}, env = process.env) {
  const raw = config && typeof config === 'object' ? config : {};
  const text = (value, fallback = '') =>
    typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback;
  const flag = (value, fallback) => (typeof value === 'boolean' ? value : fallback);
  const number = (value, fallback, min, max) => {
    const parsed = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
  };

  const workspaceInfo = resolveWorkspace(raw.workspace, env);
  const workspace = workspaceInfo.path;

  const configFile = toPosix(text(raw.configFile, join(workspace, 'config', 'wechatagent.json')));
  const configRead = readJsonFile(configFile);
  const agentConfig =
    configRead.ok && configRead.value && typeof configRead.value === 'object' ? configRead.value : undefined;
  const hookConfig =
    agentConfig?.hook && typeof agentConfig.hook === 'object' ? agentConfig.hook : {};

  const expectedVersion = text(
    raw.expectedVersion,
    text(hookConfig.expectedVersion, DEFAULT_EXPECTED_VERSION),
  );
  const hookUrl = text(raw.hookUrl, text(hookConfig.baseUrl, DEFAULT_HOOK_URL)).replace(/\/+$/, '');

  // hook.wechatExecutable may be absolute or workspace-relative; the client
  // directory is whatever contains that launcher.
  const executable = text(hookConfig.wechatExecutable);
  const configuredExe = text(raw.clientExe);
  const fromAgentConfig =
    executable === ''
      ? ''
      : toPosix(isAbsolute(executable) ? executable : resolve(workspace, executable));
  const clientExe = configuredExe !== '' ? toPosix(configuredExe) : fromAgentConfig;
  const clientDir = toPosix(
    text(
      raw.clientDir,
      clientExe !== '' ? dirname(clientExe) : join(workspace, 'state', 'hook', `wechat-${expectedVersion}`),
    ),
  );

  const ports = { ...DEFAULT_PORTS };
  for (const source of [agentConfig?.ports, raw.ports]) {
    if (!source || typeof source !== 'object') continue;
    for (const key of Object.keys(DEFAULT_PORTS)) {
      if (!Object.hasOwn(source, key)) continue;
      ports[key] = Math.round(number(source[key], ports[key], 1, 65_535));
    }
  }

  const rawTimeouts = raw.timeouts && typeof raw.timeouts === 'object' ? raw.timeouts : {};
  const timeouts = {};
  for (const [key, fallback] of Object.entries(DEFAULT_TIMEOUTS)) {
    const min = key === 'stopPollMs' ? 100 : 500;
    const max = key === 'buildMs' ? 1_800_000 : 900_000;
    timeouts[key] = Math.round(number(rawTimeouts[key], fallback, min, max));
  }

  return {
    enabled: flag(raw.enabled, true),
    promptEnabled: flag(raw.promptEnabled, true),
    workspace,
    workspaceSource: workspaceInfo.source,
    workspaceValid: workspaceInfo.valid,
    configFile,
    configOk: configRead.ok,
    configError: configRead.error,
    agentConfig,
    scriptsDir: toPosix(text(raw.scriptsDir, join(workspace, 'scripts'))),
    hookUrl,
    expectedVersion,
    tokenFile: toPosix(text(raw.tokenFile, join(workspace, 'state', 'hook', 'native-token.txt'))),
    nativeDir: toPosix(text(raw.nativeDir, join(workspace, 'state', 'hook', 'native'))),
    clientDir,
    clientExe: toPosix(clientExe !== '' ? clientExe : join(clientDir, 'Weixin.exe')),
    clientTokenFile: toPosix(join(clientDir, 'wechatagent-hook.token')),
    runtimeFile: toPosix(text(raw.runtimeFile, join(workspace, 'state', 'runtime.json'))),
    ioConfigFile: toPosix(join(workspace, 'state', 'wechat-io-config.json')),
    componentsDir: toPosix(join(workspace, 'components', 'WeChat-Hook')),
    initLogFile: toPosix(join(workspace, 'state', 'logs', 'hook-init.log')),
    desktopWechatExe: toPosix(raw.desktopWechatExe),
    desktopRegistryKey: text(raw.desktopRegistryKey, DEFAULT_REGISTRY_KEY),
    powershell: text(raw.powershell, 'powershell.exe'),
    ports,
    timeouts,
    promptText: text(raw.promptText, DEFAULT_PROMPT),
  };
}

/**
 * Absolute path of one workspace script.
 *
 * @param {{scriptsDir: string}} settings
 * @param {string} name
 * @returns {string}
 */
export function scriptPath(settings, name) {
  return toPosix(join(settings.scriptsDir, name));
}


