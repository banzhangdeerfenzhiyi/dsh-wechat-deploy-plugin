/**
 * Deploy actions: prepare, launch, restart, build and managed services.
 *
 * Every action owns its prerequisite checks and refuses with a Chinese sentence
 * before it touches anything. Write actions require `confirm: true`; the confirm
 * gate lives here (not in the tool wrapper) so no caller can skip it.
 *
 * Only `restart` ends processes, and only those whose executable lives inside
 * the pinned client directory. Desktop WeChat is never terminated.
 */
import { isFile, readJsonFile, SCRIPTS, scriptPath } from './settings.mjs';
import { messageOf } from './log.mjs';
import { runPowerShellCommand, runPowerShellScript, tail } from './powershell.mjs';
import {
  classifyProcesses,
  formatHookLine,
  hookHealth,
  listWeixinProcesses,
  normalizeVersion,
  readExeVersion,
  versionsMatch,
} from './status.mjs';

/** Ends every Weixin.exe whose executable is inside the pinned client dir. */
export const STOP_CLIENT_COMMAND = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$dir = [string]$env:DSH_WECHAT_DEPLOY_CLIENT_DIR
if ([string]::IsNullOrWhiteSpace($dir)) { throw 'client directory missing' }
$root = $dir.TrimEnd('\') + '\'
$items = @()
$rows = @(Get-CimInstance Win32_Process -Filter "Name='Weixin.exe'" | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($root, [StringComparison]::OrdinalIgnoreCase) })
foreach ($row in $rows) {
  $items += [int]$row.ProcessId
  try { Stop-Process -Id $row.ProcessId -Force -ErrorAction Stop } catch { }
}
[ordered]@{ stopped = @($items); count = @($items).Count } | ConvertTo-Json -Depth 3 -Compress
`;

/** Common script failures and the Chinese advice that goes with them. */
const ERROR_HINTS = [
  [/Close the matching WeChat before replacing/i, '匹配微信正在运行：先从托盘完全退出它，再重试准备。'],
  [/Another desktop WeChat is running/i, '桌面上还有其他微信在运行：先从托盘退出桌面微信；本工具不会结束它们。'],
  [/Hook port is already in use/i, '30001 端口已被占用：先确认监听进程，再重试。'],
  [/Client version mismatch/i, '匹配客户端版本不对：需要 4.1.10.27 的客户端。'],
  [/HOOK_COMPONENT_UPDATE_PENDING/i, '客户端里的 version.dll 与 build.json 不一致：退出匹配微信后重新打开。'],
  [/signature check failed/i, '客户端签名校验失败：确认 Weixin.exe 来自官方匹配版本包。'],
  [/Matching WeChat client missing/i, '匹配客户端缺失：按 docs/WECHAT_HOOK.md 准备。'],
  [/HOOK_TOKEN_MISSING/i, '令牌缺失：先执行 wechat_deploy_prepare。'],
  [/HOOK_AUTH_FAILED/i, 'Hook 拒绝令牌：退出并重开匹配客户端刷新令牌。'],
  [/HOOK_VERSION_MISMATCH/i, 'Hook 版本与期望不一致：需要重新构建/准备匹配版本。'],
  [/HOOK_CLIENT_UNHEALTHY/i, '客户端在运行但 Hook 未就绪：重启匹配客户端并重新登录。'],
  [/HOOK_PORT_OWNER_MISMATCH/i, '30001 的监听进程不是匹配客户端：先停掉占用者。'],
  [/WECHAT_LAUNCH_EXITED/i, '匹配客户端启动后自行退出：查看 state/logs/hook-init.log。'],
  [/Visual Studio C\+\+ compiler not found|vswhere/i, '缺少 VS C++ 生成工具：安装 Build Tools 或提供 -MsBuild。'],
  [/Reviewed source changed|upstream source differs/i, '源码与受审提交不一致：不要构建，先核对 components/WeChat-Hook。'],
  [/Download components\/WeChat-Hook/i, '没有获授权源码：先把 WeChat-Hook 源码放到 components/WeChat-Hook。'],
  [/Native Hook build failed/i, '原生构建失败：看输出里的 MSBuild 错误。'],
];

/** Thrown when a write action is called without `confirm: true`. */
export class ConfirmRequiredError extends Error {
  /**
   * @param {string} label
   */
  constructor(label) {
    super(`「${label}」会改动客户端或进程，必须显式传 confirm: true 才会执行（本次没有执行任何操作）。`);
    this.name = 'ConfirmRequiredError';
    this.code = 'CONFIRM_REQUIRED';
  }
}

/**
 * @param {Record<string, any>} args
 * @param {string} label
 */
export function requireConfirm(args, label) {
  if (args?.confirm === true) return;
  throw new ConfirmRequiredError(label);
}

/**
 * One script run, normalized for both the tool text and tests.
 *
 * @param {Record<string, any>} settings
 * @param {string} file
 * @param {Array<string|number>} args
 * @param {{timeoutMs: number, signal?: AbortSignal}} options
 */
async function execScript(settings, file, args, options) {
  const result = await runPowerShellScript(settings, file, args, {
    timeoutMs: options.timeoutMs,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  const combined = [result.stdout, result.stderr].filter((text) => text !== '').join('\n');
  const timedOut = result.timedOut;
  const aborted = result.aborted;
  const ok = result.code === 0 && !timedOut && !aborted;
  return {
    ok,
    code: result.code,
    stdout: result.stdout,
    stderr: result.stderr,
    tail: tail(combined, 40),
    elapsedMs: result.elapsedMs,
    timedOut,
    aborted,
    commandLabel: result.commandLabel,
    reason: ok ? '' : reasonOf(result, combined),
    hint: ok ? '' : hintFor(combined),
  };
}

/**
 * @param {{code: number, timedOut: boolean, aborted: boolean, elapsedMs: number}} result
 * @param {string} combined
 * @returns {string}
 */
function reasonOf(result, combined) {
  if (result.aborted) return '操作已取消。';
  if (result.timedOut) return `超时（${formatSeconds(result.elapsedMs)}）被终止。`;
  const line = firstErrorLine(combined);
  return line === '' ? `脚本退出码 ${result.code}。` : `${line}`;
}

/**
 * First line that looks like the real failure.
 *
 * @param {unknown} text
 * @returns {string}
 */
export function firstErrorLine(text) {
  const lines = String(text ?? '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  if (lines.length === 0) return '';
  const pattern = /error|exception|failed|failure|throw|mismatch|missing|cannot|unable|invalid|refus|HOOK_|WECHAT_|not ready/i;
  const hit = lines.find((line) => pattern.test(line));
  const chosen = hit ?? lines[lines.length - 1];
  return chosen.length > 300 ? `${chosen.slice(0, 300)}…` : chosen;
}

/**
 * Chinese advice for a known script failure.
 *
 * @param {unknown} text
 * @returns {string}
 */
export function hintFor(text) {
  const value = String(text ?? '');
  for (const [pattern, hint] of ERROR_HINTS) if (pattern.test(value)) return hint;
  return '';
}

/**
 * Pids reported by STOP_CLIENT_COMMAND.
 *
 * @param {unknown} stdout
 * @returns {number[]}
 */
export function parseStopOutput(stdout) {
  const text = String(stdout ?? '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return [];
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    const values = Array.isArray(parsed?.stopped) ? parsed.stopped : [];
    return values.map((value) => Number(value)).filter((value) => Number.isFinite(value) && value > 0);
  } catch {
    return [];
  }
}

/**
 * A refused action, in the same shape as an executed one: nothing ran, and the
 * Chinese reason is the whole payload.
 *
 * @param {string} title
 * @param {unknown} error
 * @returns {Record<string, any>}
 */
export function refusal(title, error) {
  const reason = messageOf(error);
  return {
    ok: false,
    executed: false,
    title,
    commandLabel: '',
    code: -1,
    stdout: '',
    stderr: '',
    tail: '',
    elapsedMs: 0,
    timedOut: false,
    aborted: false,
    reason,
    hint: hintFor(reason),
    summary: '前置检查未通过，未执行任何操作。',
    nextSteps: ['按下面的原因处理后重试。'],
  };
}

/**
 * Run prerequisite checks without throwing; a refusal becomes a failed result.
 *
 * @param {string} title
 * @param {() => Promise<Record<string, any>>} body
 * @returns {Promise<{ok: boolean, context: Record<string, any>, result: Record<string, any>|null}>}
 */
async function preflight(title, body) {
  try {
    return { ok: true, context: (await body()) ?? {}, result: null };
  } catch (error) {
    return { ok: false, context: {}, result: refusal(title, error) };
  }
}

/**
 * Prepare the pinned client (DLL + token), never launching it.
 *
 * @param {Record<string, any>} settings
 * @param {Record<string, any>} args
 * @param {{signal?: AbortSignal}} [options]
 * @returns {Promise<Record<string, any>>}
 */
export async function prepareHook(settings, args = {}, options = {}) {
  const title = '准备 Hook 组件';
  requireConfirm(args, title);
  const gate = await preflight(title, async () => {
    assertWorkspace(settings);
    const script = assertScript(settings, SCRIPTS.launch);
    assertClient(settings);
    assertNativeDll(settings);
    assertBuildTarget(settings);

    const version = await readExeVersion(settings, settings.clientExe, {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (!versionsMatch(version, settings.expectedVersion)) {
      throw new Error(
        `匹配客户端版本 ${version || '未知'} 与期望 ${settings.expectedVersion} 不一致：先换上匹配客户端，再准备 Hook 组件。`,
      );
    }

    const running = await classifyClientProcesses(settings, options.signal);
    if (running.hookedCount > 0) {
      throw new Error(
        `匹配微信正在运行（pid ${running.hooked.map((row) => row.pid).join('、')}）：prepare 需要先完全退出匹配微信（可从托盘退出），再重试。`,
      );
    }
    return { script };
  });
  if (!gate.ok) return gate.result;
  const { script } = gate.context;

  const run = await execScript(settings, script, ['-PrepareOnly'], {
    timeoutMs: settings.timeouts.prepareMs,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  return {
    ...run,
    executed: true,
    title,
    summary: run.ok
      ? '已把校验过的 version.dll 与本地令牌写入匹配客户端目录（没有启动客户端）。'
      : '准备失败，客户端目录可能已被部分修改；按下面的原因处理后重试。',
    nextSteps: run.ok ? ['调用 wechat_deploy_launch 打开匹配微信并等待 Hook 就绪。'] : ['修正原因后重试 wechat_deploy_prepare。'],
  };
}

/**
 * Launch the pinned client and wait for the hook to become ready.
 *
 * @param {Record<string, any>} settings
 * @param {Record<string, any>} args
 * @param {{signal?: AbortSignal}} [options]
 * @returns {Promise<Record<string, any>>}
 */
export async function launchHook(settings, args = {}, options = {}) {
  const title = '启动匹配微信';
  requireConfirm(args, title);
  const gate = await preflight(title, async () => {
    assertWorkspace(settings);
    const script = assertScript(settings, SCRIPTS.launch);
    assertClient(settings);
    assertNativeDll(settings);
    assertBuildTarget(settings);

    const running = await classifyClientProcesses(settings, options.signal);
    if (running.desktopMainRunning) {
      throw new Error(
        `桌面上还有其他微信在运行（pid ${running.otherMain.map((row) => row.pid).join('、')}）：先从托盘完全退出它们，再启动匹配客户端。`,
      );
    }
    return { script };
  });
  if (!gate.ok) return gate.result;
  const { script } = gate.context;

  const run = await execScript(settings, script, [], {
    timeoutMs: settings.timeouts.launchMs,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  const health = await hookHealth(settings, {
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  const ready = health.ok && health.health?.startupState === 'ready';
  const ok = run.ok && ready;
  return {
    ...run,
    ok,
    executed: true,
    title,
    health: healthSummary(health),
    summary: ok
      ? `匹配客户端已启动，Hook 已就绪（pid ${health.health?.pid ?? '?'}，version ${health.health?.version ?? '?'}）。在微信里完成登录后即可使用。`
      : '启动脚本返回后 Hook 仍未就绪，看下面的脚本输出与健康结论。',
    reason: ok ? '' : run.ok ? `Hook 未就绪：${health.error || health.health?.startupState || '未知'}` : run.reason,
    hint: ok ? '' : run.ok ? '等待 30 秒后重试 wechat_deploy_health；仍不 ready 用 wechat_deploy_restart。' : run.hint,
    nextSteps: ok
      ? ['在匹配微信里登录账号。', '需要完整项目时再启动 WeChatAgent 托管服务。']
      : ['查看 state/logs/hook-init.log。', '调用 wechat_deploy_restart 重试。'],
  };
}

/**
 * Restart the pinned client: stop only its processes, then launch again.
 *
 * @param {Record<string, any>} settings
 * @param {Record<string, any>} args
 * @param {{signal?: AbortSignal}} [options]
 * @returns {Promise<Record<string, any>>}
 */
export async function restartHook(settings, args = {}, options = {}) {
  const title = '重启匹配微信';
  requireConfirm(args, title);
  const gate = await preflight(title, async () => {
    assertWorkspace(settings);
    const script = assertScript(settings, SCRIPTS.launch);
    assertClient(settings);
    assertNativeDll(settings);
    assertBuildTarget(settings);

    const running = await classifyClientProcesses(settings, options.signal);
    if (running.desktopMainRunning) {
      throw new Error(
        `桌面上还有其他微信在运行（pid ${running.otherMain
          .map((row) => row.pid)
          .join('、')}）：重启后启动匹配微信会失败；先从托盘完全退出桌面微信，再重试。`,
      );
    }
    return { script, before: running };
  });
  if (!gate.ok) return gate.result;
  const { script, before } = gate.context;

  const startedAt = Date.now();
  let stopped = [];
  let stopError = '';
  if (before.hookedCount > 0) {
    const stop = await runPowerShellCommand(settings, STOP_CLIENT_COMMAND, {
      timeoutMs: 60_000,
      env: { DSH_WECHAT_DEPLOY_CLIENT_DIR: settings.clientDir },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    stopped = parseStopOutput(stop.stdout);
    if (stop.code !== 0) {
      stopError = `结束匹配客户端失败：${firstErrorLine(stop.stderr || stop.stdout) || `退出码 ${stop.code}`}`;
    } else {
      const waited = await waitForClientExit(settings, options.signal);
      if (!waited.ok) {
        stopError = `匹配客户端在 ${formatSeconds(settings.timeouts.stopWaitMs)} 内没有完全退出（剩余 pid ${waited.remaining
          .map((row) => row.pid)
          .join('、')}）。`;
      }
    }
  }
  if (stopError !== '') {
    return {
      executed: true,
      ok: false,
      title,
      code: -1,
      stdout: '',
      stderr: '',
      tail: '',
      elapsedMs: Date.now() - startedAt,
      timedOut: false,
      aborted: false,
      commandLabel: 'Stop-Process（匹配客户端目录）',
      reason: stopError,
      hint: '从托盘手动退出匹配微信后重试；本次没有执行启动。',
      stopped,
      summary: '停止阶段失败，已放弃启动。',
      nextSteps: ['手动退出匹配微信。', '再调用 wechat_deploy_restart。'],
    };
  }

  const run = await execScript(settings, script, [], {
    timeoutMs: settings.timeouts.launchMs,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  const health = await hookHealth(settings, {
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  const ready = health.ok && health.health?.startupState === 'ready';
  const ok = run.ok && ready;
  const stopNote = stopped.length > 0 ? `已结束 pid ${stopped.join('、')}。` : '匹配客户端原本没有运行。';
  return {
    ...run,
    ok,
    executed: true,
    title,
    elapsedMs: Date.now() - startedAt,
    stopped,
    health: healthSummary(health),
    summary: ok
      ? `${stopNote}已重新启动，Hook 就绪（pid ${health.health?.pid ?? '?'}，version ${health.health?.version ?? '?'}）。`
      : `${stopNote}但 Hook 未就绪。`,
    reason: ok ? '' : run.ok ? `Hook 未就绪：${health.error || health.health?.startupState || '未知'}` : run.reason,
    hint: ok ? '' : run.ok ? '查看 state/logs/hook-init.log，必要时 wechat_deploy_prepare 后重试。' : run.hint,
    nextSteps: ok ? ['需要登录时在匹配微信里登录。'] : ['查看 state/logs/hook-init.log。', '先 wechat_deploy_prepare，再 wechat_deploy_launch。'],
  };
}

/**
 * Rebuild the native hook DLL (15 minute cap).
 *
 * @param {Record<string, any>} settings
 * @param {Record<string, any>} args
 * @param {{signal?: AbortSignal}} [options]
 * @returns {Promise<Record<string, any>>}
 */
export async function buildHook(settings, args = {}, options = {}) {
  const title = '构建原生 Hook';
  requireConfirm(args, title);
  const gate = await preflight(title, async () => {
    assertWorkspace(settings);
    const script = assertScript(settings, SCRIPTS.build);
    const project = `${settings.componentsDir}/x64_Version_dll.vcxproj`;
    if (!isFile(project)) {
      throw new Error(
        `没有获授权源码：${project} 不存在。按 docs/WECHAT_HOOK.md 把 WeChat-Hook 源码准备到 components/WeChat-Hook 后再构建。`,
      );
    }
    return { script };
  });
  if (!gate.ok) return gate.result;
  const { script } = gate.context;

  const run = await execScript(settings, script, [], {
    timeoutMs: settings.timeouts.buildMs,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  const manifest = readJsonFile(`${settings.nativeDir}/build.json`);
  const sha = manifest.ok && typeof manifest.value?.sha256 === 'string' ? manifest.value.sha256 : '';
  const target = manifest.ok ? normalizeVersion(manifest.value?.targetVersion) : '';
  return {
    ...run,
    executed: true,
    title,
    summary: run.ok
      ? `构建完成，产物 state/hook/native/version.dll（sha256 ${sha || '未知'}，target ${target || '未知'}）。新产物要 prepare + launch 才生效。`
      : '构建失败，原有 state/hook/native 产物保持不变或已被备份。',
    nextSteps: run.ok
      ? ['先从托盘完全退出匹配微信。', 'wechat_deploy_prepare 部署新 DLL，再 wechat_deploy_launch。']
      : ['按输出修正源码/工具链后重试 wechat_deploy_build。'],
  };
}

/**
 * One manage.ps1 action (adapter/reader/bridge).
 *
 * @param {Record<string, any>} settings
 * @param {Record<string, any>} args
 * @param {{signal?: AbortSignal}} [options]
 * @returns {Promise<Record<string, any>>}
 */
export async function manageServices(settings, args = {}, options = {}) {
  const action = String(args?.action ?? '').trim().toLowerCase();
  const allowed = ['start', 'stop', 'restart', 'status'];
  if (!allowed.includes(action)) throw new Error('action 必须是 start、stop、restart 或 status 之一。');
  const title = `托管服务 ${action}`;
  if (action !== 'status') requireConfirm(args, title);
  const gate = await preflight(title, async () => {
    assertWorkspace(settings);
    return { script: assertScript(settings, SCRIPTS.manage) };
  });
  if (!gate.ok) return gate.result;
  const { script } = gate.context;

  const run = await execScript(settings, script, ['-Action', action], {
    timeoutMs: settings.timeouts.servicesMs,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  const descriptions = {
    start: '已请求启动 adapter / reader / bridge 托管服务。',
    stop: '已请求停止托管服务。',
    restart: '已请求重启托管服务。',
    status: '托管服务状态已读取（只读）。',
  };
  return {
    ...run,
    executed: true,
    title,
    summary: run.ok ? descriptions[action] : 'manage.ps1 返回失败，按输出处理后重试。',
    nextSteps: run.ok
      ? action === 'status'
        ? ['需要完整诊断时调用 wechat_deploy_status。']
        : ['调用 wechat_deploy_health 确认 Hook 与读取器都正常。']
      : ['查看 state/logs/shutdown.log 与脚本输出。', '修正后重试 wechat_deploy_services。'],
  };
}

/**
 * Human-readable action result (the tool's `detail`).
 *
 * @param {Record<string, any>} result
 * @returns {string}
 */
export function formatActionResult(result) {
  if (!result || typeof result !== 'object') return '没有返回结果。';
  const lines = [];
  const status = result.ok ? '✅' : '❌';
  const elapsed = Number.isFinite(result.elapsedMs) ? `（${formatSeconds(result.elapsedMs)}）` : '';
  lines.push(`${status} ${result.title ?? '部署操作'}${result.ok ? '完成' : '失败'}${elapsed}`);
  if (result.commandLabel) lines.push(`命令：${result.commandLabel}`);
  if (result.summary) lines.push(result.summary);
  if (!result.ok) {
    if (result.reason) lines.push(`原因：${result.reason}`);
    if (result.hint) lines.push(`建议：${result.hint}`);
  }
  if (result.tail) lines.push('输出（末尾）：', result.tail);
  if (result.health) lines.push(`【Hook 健康】${formatHookLine(result.health)}`);
  if (Array.isArray(result.nextSteps) && result.nextSteps.length > 0) {
    lines.push('下一步：');
    result.nextSteps.forEach((step, index) => lines.push(`${index + 1}. ${step}`));
  }
  return lines.join('\n');
}

/**
 * @param {Record<string, any>} settings
 */
function assertWorkspace(settings) {
  if (!settings?.workspaceValid) {
    throw new Error(
      `WeChatAgent 工作区无效或不存在：${settings?.workspace ?? '未知路径'}（需要 config/wechatagent.json 与 state/）。可在插件配置里用 workspace 指定。`,
    );
  }
  if (!settings.configOk) throw new Error(`config/wechatagent.json 不是合法 JSON：${settings.configError}`);
}

/**
 * @param {Record<string, any>} settings
 * @param {string} name
 * @returns {string}
 */
function assertScript(settings, name) {
  const file = scriptPath(settings, name);
  if (!isFile(file)) throw new Error(`缺少脚本 ${file}：工作区不完整，或 scriptsDir 配置不对。`);
  return file;
}

/** @param {Record<string, any>} settings */
function assertClient(settings) {
  if (!isFile(settings.clientExe)) {
    throw new Error(
      `匹配客户端不存在：${settings.clientExe}（按 docs/WECHAT_HOOK.md 准备 ${settings.expectedVersion} 客户端）。`,
    );
  }
}

/**
 * @param {Record<string, any>} settings
 * @returns {string}
 */
function assertNativeDll(settings) {
  const file = `${settings.nativeDir}/version.dll`;
  if (!isFile(file)) {
    throw new Error(`缺少原生组件 ${file}：先执行 wechat_deploy_build，或恢复构建产物。`);
  }
  return file;
}

/** @param {Record<string, any>} settings */
function assertBuildTarget(settings) {
  const manifest = readJsonFile(`${settings.nativeDir}/build.json`);
  if (!manifest.ok) throw new Error(`缺少构建清单 ${settings.nativeDir}/build.json：先执行 wechat_deploy_build。`);
  const target = normalizeVersion(manifest.value?.targetVersion);
  if (target !== '' && !versionsMatch(target, settings.expectedVersion)) {
    throw new Error(
      `构建产物 targetVersion ${target} 与期望 ${settings.expectedVersion} 不一致：先 wechat_deploy_build 重新构建。`,
    );
  }
}

/**
 * Live Weixin.exe rows classified against the pinned client dir.
 *
 * @param {Record<string, any>} settings
 * @param {AbortSignal|undefined} signal
 */
async function classifyClientProcesses(settings, signal) {
  const rows = await listWeixinProcesses(settings, signal === undefined ? {} : { signal });
  return classifyProcesses(
    rows.map((row) => ({
      name: 'Weixin.exe',
      pid: row.pid,
      executable: row.executable,
      commandLine: row.commandLine,
    })),
    settings.clientDir,
  );
}

/**
 * @param {Record<string, any>} settings
 * @param {AbortSignal|undefined} signal
 * @returns {Promise<{ok: boolean, remaining: Array<{pid: number}>}>}
 */
async function waitForClientExit(settings, signal) {
  const deadline = Date.now() + settings.timeouts.stopWaitMs;
  let remaining = [];
  while (Date.now() < deadline) {
    const classified = await classifyClientProcesses(settings, signal);
    remaining = classified.hooked;
    if (remaining.length === 0) return { ok: true, remaining: [] };
    await delay(settings.timeouts.stopPollMs, signal);
  }
  return { ok: false, remaining };
}

/**
 * @param {number} ms
 * @param {AbortSignal|undefined} signal
 * @returns {Promise<void>}
 */
function delay(ms, signal) {
  return new Promise((resolvePromise, rejectPromise) => {
    if (signal?.aborted) {
      rejectPromise(new Error('操作已取消。'));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      rejectPromise(new Error('操作已取消。'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort);
      resolvePromise();
    }, ms);
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

/**
 * @param {Awaited<ReturnType<typeof hookHealth>>} health
 * @returns {Record<string, any>}
 */
function healthSummary(health) {
  return {
    ok: health.ok,
    error: health.error,
    startupState: health.health?.startupState ?? '',
    pid: health.health?.pid ?? 0,
    version: health.health?.version ?? '',
    integration: health.health?.integration ?? '',
    backend: health.health?.backend ?? '',
    databaseAccounts: health.health?.databaseAccounts ?? [],
  };
}

/**
 * @param {number} elapsedMs
 * @returns {string}
 */
function formatSeconds(elapsedMs) {
  const value = Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0;
  return value < 1_000 ? `${Math.round(value)}ms` : `${(value / 1_000).toFixed(1)}s`;
}
