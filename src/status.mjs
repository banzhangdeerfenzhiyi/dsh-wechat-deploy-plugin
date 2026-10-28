/**
 * Diagnostic collector for the WeChat hook deployment.
 *
 * `collectStatus` performs exactly one read-only PowerShell probe (processes,
 * desktop install path, file versions, managed-service liveness), then combines
 * it with Node-side facts: file hashes, token format, hook health over HTTP and
 * TCP port checks. Every derived judgement lives in a pure helper (`compareSha`,
 * `buildNextSteps`, …) so the important logic is unit-testable without touching
 * the machine.
 *
 * Nothing in this module writes, stops or starts anything.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';
import { messageOf } from './log.mjs';
import { runPowerShellCommand, tail } from './powershell.mjs';
import { isFile, readJsonFile, toPosix } from './settings.mjs';

const PROBE_TIMEOUT_MS = 30_000;
const PORT_TIMEOUT_MS = 800;

/**
 * The one probe script. Constant text; every dynamic value arrives through the
 * environment (`DSH_WECHAT_DEPLOY_*`) so nothing can be injected into it.
 */
export const PROBE_COMMAND = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$result = [ordered]@{ processes = @(); services = @(); desktop = $null; client = $null; errors = @() }
try {
  $rows = @(Get-CimInstance Win32_Process -Filter "Name='Weixin.exe' OR Name='WeChatAgent.exe'" | Select-Object Name, ProcessId, ExecutablePath, CommandLine)
  foreach ($row in $rows) {
    $result.processes += [ordered]@{
      name = [string]$row.Name
      pid = [int]$row.ProcessId
      executable = [string]$row.ExecutablePath
      commandLine = [string]$row.CommandLine
    }
  }
} catch { $result.errors += ('processes: ' + $_.Exception.Message) }
try {
  $key = [string]$env:DSH_WECHAT_DEPLOY_REGISTRY
  $override = [string]$env:DSH_WECHAT_DEPLOY_DESKTOP_EXE
  $installPath = ''
  $registryError = ''
  try {
    $item = Get-ItemProperty -Path $key -ErrorAction Stop
    $installPath = [string]$item.InstallPath
  } catch { $registryError = $_.Exception.Message }
  $exe = ''
  if ($override -ne '') {
    $exe = $override
  } elseif ($installPath -ne '') {
    if ($installPath.ToLowerInvariant().EndsWith('.exe')) { $exe = $installPath } else { $exe = Join-Path $installPath 'Weixin.exe' }
  }
  $exists = $false
  $version = ''
  if ($exe -ne '') {
    $exists = [bool](Test-Path -LiteralPath $exe)
    if ($exists) { $version = [string](Get-Item -LiteralPath $exe).VersionInfo.FileVersion }
  }
  $result.desktop = [ordered]@{
    registryKey = $key
    installPath = $installPath
    exe = $exe
    exists = $exists
    version = $version
    overridden = ($override -ne '')
    error = $registryError
  }
} catch { $result.errors += ('desktop: ' + $_.Exception.Message) }
try {
  $clientExe = [string]$env:DSH_WECHAT_DEPLOY_CLIENT_EXE
  $clientExists = $false
  $clientVersion = ''
  if ($clientExe -ne '') {
    $clientExists = [bool](Test-Path -LiteralPath $clientExe)
    if ($clientExists) { $clientVersion = [string](Get-Item -LiteralPath $clientExe).VersionInfo.FileVersion }
  }
  $result.client = [ordered]@{ exe = $clientExe; exists = $clientExists; version = $clientVersion }
} catch { $result.errors += ('client: ' + $_.Exception.Message) }
try {
  $ids = @([string]$env:DSH_WECHAT_DEPLOY_PIDS -split ',')
  foreach ($procId in $ids) {
    if ([string]::IsNullOrWhiteSpace($procId)) { continue }
    $process = Get-Process -Id ([int]$procId) -ErrorAction SilentlyContinue
    if ($process) {
      $path = ''
      try { $path = [string]$process.Path } catch { $path = '' }
      $result.services += [ordered]@{ pid = [int]$procId; alive = $true; executable = $path }
    } else {
      $result.services += [ordered]@{ pid = [int]$procId; alive = $false; executable = '' }
    }
  }
} catch { $result.errors += ('services: ' + $_.Exception.Message) }
$result | ConvertTo-Json -Depth 6 -Compress
`;

/** Weixin.exe rows only; used by the restart pre-check and its stop wait. */
export const LIST_WEIXIN_COMMAND = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$items = @()
$rows = @(Get-CimInstance Win32_Process -Filter "Name='Weixin.exe'" | Select-Object ProcessId, ExecutablePath, CommandLine)
foreach ($row in $rows) {
  $items += [ordered]@{ pid = [int]$row.ProcessId; executable = [string]$row.ExecutablePath; commandLine = [string]$row.CommandLine }
}
ConvertTo-Json -InputObject @($items) -Depth 3 -Compress
`;

/** FileVersion of one executable; the path travels through the environment. */
export const FILE_VERSION_COMMAND = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$exe = [string]$env:DSH_WECHAT_DEPLOY_EXE
if ([string]::IsNullOrWhiteSpace($exe)) { throw 'executable path missing' }
if (-not (Test-Path -LiteralPath $exe)) { throw ('file missing: ' + $exe) }
[string](Get-Item -LiteralPath $exe).VersionInfo.FileVersion
`;

/**
 * Read one executable's FileVersion through PowerShell.
 *
 * @param {Record<string, any>} settings
 * @param {string} exe
 * @param {{signal?: AbortSignal}} [options]
 * @returns {Promise<string>}
 */
export async function readExeVersion(settings, exe, options = {}) {
  const result = await runPowerShellCommand(settings, FILE_VERSION_COMMAND, {
    timeoutMs: 20_000,
    env: { DSH_WECHAT_DEPLOY_EXE: exe },
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  if (result.code !== 0) {
    throw new Error(`读不到 ${exe} 的版本号：${tail(result.stderr || result.stdout, 3) || 'PowerShell 无输出'}`);
  }
  return normalizeVersion(result.stdout);
}

/**
 * Live Weixin.exe process rows.
 *
 * @param {Record<string, any>} settings
 * @param {{signal?: AbortSignal}} [options]
 * @returns {Promise<Array<{pid: number, executable: string, commandLine: string}>>}
 */
export async function listWeixinProcesses(settings, options = {}) {
  const result = await runPowerShellCommand(settings, LIST_WEIXIN_COMMAND, {
    timeoutMs: 20_000,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  if (result.code !== 0) {
    throw new Error(`读取 Weixin.exe 进程列表失败：${tail(result.stderr || result.stdout, 3) || 'PowerShell 无输出'}`);
  }
  return parseProcessList(result.stdout);
}

/** @returns {{processes: Array<Record<string, any>>, services: Array<Record<string, any>>, desktop: Record<string, any>|null, client: Record<string, any>|null, errors: string[]}} */
export function emptyProbe() {
  return { processes: [], services: [], desktop: null, client: null, errors: [] };
}

/**
 * Parse the probe JSON, tolerating PowerShell banners around it.
 *
 * @param {unknown} stdout
 * @returns {ReturnType<typeof emptyProbe>}
 */
export function parseProbeOutput(stdout) {
  const text = String(stdout ?? '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) {
    throw new Error(`无法解析 PowerShell 探测输出：${tail(text, 3, 300) || '（空）'}`);
  }
  const parsed = JSON.parse(text.slice(start, end + 1));
  const asArray = (value) => (Array.isArray(value) ? value : value ? [value] : []);
  return {
    processes: asArray(parsed?.processes).filter((row) => row && typeof row === 'object'),
    services: asArray(parsed?.services).filter((row) => row && typeof row === 'object'),
    desktop: parsed?.desktop && typeof parsed.desktop === 'object' ? parsed.desktop : null,
    client: parsed?.client && typeof parsed.client === 'object' ? parsed.client : null,
    errors: asArray(parsed?.errors).map((value) => String(value)),
  };
}

/**
 * Parse the Weixin-only process list.
 *
 * @param {unknown} stdout
 * @returns {Array<{pid: number, executable: string, commandLine: string}>}
 */
export function parseProcessList(stdout) {
  const text = String(stdout ?? '').trim();
  if (text === '' || text === 'null') return [];
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  const raw = start >= 0 && end > start ? text.slice(start, end + 1) : text;
  const parsed = JSON.parse(raw);
  const rows = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
  return rows
    .filter((row) => row && typeof row === 'object')
    .map((row) => ({
      pid: Number(row.pid),
      executable: toPosix(row.executable),
      commandLine: String(row.commandLine ?? ''),
    }))
    .filter((row) => Number.isFinite(row.pid) && row.pid > 0);
}

/**
 * Normalize a version string ("4.1.10.27", "v4.1.10.27 (123)", 4065599496).
 *
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeVersion(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  const text = String(value ?? '').trim();
  if (text === '') return '';
  const match = text.match(/\d+(?:\.\d+){0,3}/);
  return match ? match[0] : text;
}

/**
 * Whether two versions describe the same client build.
 *
 * @param {unknown} left
 * @param {unknown} right
 * @returns {boolean}
 */
export function versionsMatch(left, right) {
  const a = normalizeVersion(left);
  const b = normalizeVersion(right);
  return a !== '' && b !== '' && a === b;
}

/**
 * Compare an expected SHA256 with an actual one.
 *
 * @param {unknown} expected
 * @param {unknown} actual
 * @returns {'match'|'mismatch'|'missing'|'unknown'}
 */
export function compareSha(expected, actual) {
  const want = typeof expected === 'string' ? expected.trim().toLowerCase() : '';
  const have = typeof actual === 'string' ? actual.trim().toLowerCase() : '';
  if (want === '') return 'unknown';
  if (have === '') return 'missing';
  return want === have ? 'match' : 'mismatch';
}

/**
 * SHA256 of a file, reported as state instead of throwing.
 *
 * @param {string} file
 * @returns {{state: 'ok'|'missing', sha256: string, error: string}}
 */
export function sha256File(file) {
  try {
    const hash = createHash('sha256');
    hash.update(readFileSync(file));
    return { state: 'ok', sha256: hash.digest('hex'), error: '' };
  } catch (error) {
    return { state: 'missing', sha256: '', error: messageOf(error) };
  }
}

/**
 * Whether an executable lives inside a directory (or is that directory's exe).
 *
 * @param {unknown} executable
 * @param {unknown} directory
 * @returns {boolean}
 */
export function isAppUnderDir(executable, directory) {
  const exe = toPosix(executable).toLowerCase();
  const dir = toPosix(directory).toLowerCase();
  if (exe === '' || dir === '') return false;
  return exe === dir || exe.startsWith(`${dir}/`);
}

/**
 * Chromium helper processes (`--type=…`, crashpad) are not a second client.
 *
 * @param {Record<string, any>} process
 * @returns {boolean}
 */
export function isHelperProcess(process) {
  return /--type=|--crashpad-handler/i.test(String(process?.commandLine ?? ''));
}

/**
 * Split a process list into the pinned client and everything else.
 *
 * @param {Array<Record<string, any>>} processes
 * @param {string} clientDir
 * @returns {{hooked: Array<Record<string, any>>, other: Array<Record<string, any>>, otherMain: Array<Record<string, any>>, wechatAgent: Array<Record<string, any>>, hookedCount: number, otherCount: number, wechatAgentCount: number, desktopMainRunning: boolean}}
 */
export function classifyProcesses(processes, clientDir) {
  const rows = Array.isArray(processes) ? processes.filter((row) => row && typeof row === 'object') : [];
  const weixin = rows.filter((row) => String(row.name ?? '').toLowerCase() === 'weixin.exe');
  const agent = rows.filter((row) => String(row.name ?? '').toLowerCase() === 'wechatagent.exe');
  const hooked = weixin.filter((row) => isAppUnderDir(row.executable, clientDir));
  const other = weixin.filter((row) => !isAppUnderDir(row.executable, clientDir));
  const otherMain = other.filter((row) => !isHelperProcess(row));
  const pick = (row) => ({
    pid: Number(row.pid),
    executable: toPosix(row.executable),
    helper: isHelperProcess(row),
  });
  return {
    hooked: hooked.map(pick),
    other: other.map(pick),
    otherMain: otherMain.map(pick),
    wechatAgent: agent.map((row) => ({ pid: Number(row.pid), executable: toPosix(row.executable) })),
    hookedCount: hooked.length,
    otherCount: other.length,
    wechatAgentCount: agent.length,
    desktopMainRunning: otherMain.length > 0,
  };
}

/**
 * Managed services from state/runtime.json, joined with the live probe.
 *
 * @param {Record<string, any>|undefined} runtime
 * @param {{ok: boolean, error: string}} runtimeRead
 * @param {Array<Record<string, any>>} probeServices
 * @returns {{ok: boolean, error: string, entries: Array<Record<string, any>>}}
 */
export function evaluateServices(runtime, runtimeRead, probeServices) {
  if (!runtime || typeof runtime !== 'object') {
    return {
      ok: false,
      error: runtimeRead?.ok === false ? runtimeRead.error : '缺少 state/runtime.json',
      entries: [],
    };
  }
  const probes = Array.isArray(probeServices) ? probeServices : [];
  const entries = [];
  for (const [name, value] of Object.entries(runtime)) {
    if (!value || typeof value !== 'object') continue;
    const pid = Number(value.pid);
    const marker = toPosix(value.marker);
    const expectedExe = toPosix(value.exe);
    const probe = probes.find((row) => Number(row.pid) === pid);
    const alive = Boolean(probe?.alive);
    const executable = probe?.executable ? toPosix(probe.executable) : '';
    entries.push({
      name,
      pid: Number.isFinite(pid) ? pid : 0,
      alive,
      executable,
      expectedExe,
      exeMatches:
        expectedExe === '' || executable === ''
          ? null
          : executable.toLowerCase() === expectedExe.toLowerCase(),
      marker,
      markerExists: marker !== '' && isFile(marker),
    });
  }
  const ok =
    entries.length > 0 &&
    entries.every((entry) => entry.pid > 0 && entry.alive && entry.markerExists && entry.exeMatches !== false);
  return { ok, error: '', entries };
}

/**
 * One TCP reachability check.
 *
 * @param {number} port
 * @param {{host?: string, timeoutMs?: number}} [options]
 * @returns {Promise<boolean>}
 */
export function probePort(port, options = {}) {
  const host = options.host ?? '127.0.0.1';
  const timeoutMs = options.timeoutMs ?? PORT_TIMEOUT_MS;
  return new Promise((resolvePromise) => {
    if (!Number.isFinite(port) || port <= 0) {
      resolvePromise(false);
      return;
    }
    let settled = false;
    const socket = connect({ host, port });
    const finish = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolvePromise(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

/**
 * Ports the deployment depends on, with human labels.
 *
 * @param {Record<string, any>} settings
 * @returns {Array<{name: string, label: string, port: number}>}
 */
export function portDefinitions(settings) {
  return [
    { name: 'weflow', label: '读取器', port: settings.ports.weflow },
    { name: 'onebot', label: 'OneBot', port: settings.ports.onebot },
    { name: 'adapter', label: '适配器', port: settings.ports.adapter },
    { name: 'dshPlugin', label: 'DSH 插件', port: settings.ports.dshPlugin },
  ];
}

/**
 * @param {Record<string, any>} settings
 * @param {(port: number) => Promise<boolean>} [probe]
 * @returns {Promise<Array<{name: string, label: string, port: number, listening: boolean}>>}
 */
export async function checkPorts(settings, probe = probePort) {
  const definitions = portDefinitions(settings);
  return await Promise.all(
    definitions.map(async (definition) => ({
      ...definition,
      listening: await probe(definition.port),
    })),
  );
}

/**
 * Read and validate the local hook token.
 *
 * @param {string} file
 * @returns {{ok: boolean, token: string, error: string}}
 */
export function readToken(file) {
  try {
    const token = readFileSync(file, 'utf8').replace(/^\uFEFF/, '').trim();
    if (!/^[a-f0-9]{64}$/i.test(token)) {
      return { ok: false, token: '', error: `令牌格式不对（应为 64 位十六进制）：${file}` };
    }
    return { ok: true, token, error: '' };
  } catch (error) {
    return { ok: false, token: '', error: `读不到令牌文件 ${file}：${messageOf(error)}` };
  }
}

/**
 * Normalize the hook health payload.
 *
 * @param {Record<string, any>} payload
 * @returns {Record<string, any>}
 */
export function normalizeHealth(payload) {
  const raw = payload && typeof payload === 'object' ? payload : {};
  const pid = Number(raw.pid);
  return {
    startupState: String(raw.startupState ?? ''),
    pid: Number.isFinite(pid) ? pid : 0,
    version: String(raw.version ?? ''),
    integration: String(raw.integration ?? ''),
    backend: String(raw.backend ?? ''),
    databaseAccounts: Array.isArray(raw.databaseAccounts) ? raw.databaseAccounts.map(String) : [],
    raw,
  };
}

/**
 * GET {hookUrl}/WeChatAgent/health with the local bearer token.
 *
 * @param {Record<string, any>} settings
 * @param {{fetchImpl?: typeof fetch, signal?: AbortSignal}} [options]
 * @returns {Promise<{ok: boolean, url: string, health: Record<string, any>|null, httpStatus: number, error: string, body: string, elapsedMs: number}>}
 */
export async function hookHealth(settings, options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const url = `${settings.hookUrl}/WeChatAgent/health`;
  const startedAt = Date.now();
  const use = (fields) => ({
    ok: false,
    url,
    health: null,
    httpStatus: 0,
    error: '',
    body: '',
    elapsedMs: Date.now() - startedAt,
    ...fields,
  });
  const token = readToken(settings.tokenFile);
  if (!token.ok) return use({ error: token.error });
  if (typeof fetchImpl !== 'function') return use({ error: '当前 Node 环境没有 fetch。' });

  const timeoutMs = Number.isFinite(settings?.timeouts?.healthMs) ? settings.timeouts.healthMs : 5_000;
  try {
    const response = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${token.token}` },
      signal: options.signal ?? AbortSignal.timeout(timeoutMs),
    });
    const body = await response.text();
    if (!response.ok) {
      const hint =
        response.status === 401
          ? '令牌不匹配：匹配客户端的令牌与 native-token.txt 不一致，需要重启客户端刷新。'
          : response.status === 404
            ? '接口不存在：确认端口上跑的是 WeChatAgent hook。'
            : '';
      return use({
        httpStatus: response.status,
        error: `HTTP ${response.status}${hint === '' ? '' : `（${hint}）`}`,
        body: tail(body, 4, 400),
      });
    }
    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      payload = undefined;
    }
    if (!payload || typeof payload !== 'object') {
      return use({ httpStatus: response.status, error: '健康接口返回的不是 JSON。', body: tail(body, 4, 400) });
    }
    return {
      ok: true,
      url,
      health: normalizeHealth(payload),
      httpStatus: response.status,
      error: '',
      body,
      elapsedMs: Date.now() - startedAt,
    };
  } catch (error) {
    const cause = error?.cause?.code ?? error?.code ?? '';
    return use({ error: `连不上 ${url}${cause === '' ? '' : `（${cause}）`}：${messageOf(error)}` });
  }
}

/**
 * Desktop WeChat facts from the probe.
 *
 * @param {Record<string, any>} settings
 * @param {Record<string, any>|null} raw
 */
export function buildDesktop(settings, raw) {
  const info = raw && typeof raw === 'object' ? raw : {};
  const installPath = toPosix(info.installPath);
  const configured = settings.desktopWechatExe;
  const exe = toPosix(info.exe) || (configured !== '' ? configured : installPath === '' ? '' : toPosix(join(installPath, 'Weixin.exe')));
  const version = normalizeVersion(info.version);
  return {
    registryKey: settings.desktopRegistryKey,
    installPath,
    exe,
    exists: Boolean(info.exists) || (exe !== '' && isFile(exe)),
    version,
    matchesExpected: versionsMatch(version, settings.expectedVersion),
    overridden: Boolean(info.overridden) || configured !== '',
    error: typeof info.error === 'string' ? info.error : '',
  };
}

/**
 * Pinned client facts: files, versions, DLL hashes.
 *
 * @param {Record<string, any>} settings
 * @param {Record<string, any>|null} raw
 */
export function buildClient(settings, raw) {
  const info = raw && typeof raw === 'object' ? raw : {};
  const version = normalizeVersion(info.version);
  const nativeDll = sha256File(join(settings.nativeDir, 'version.dll'));
  const installedDll = sha256File(join(settings.clientDir, 'version.dll'));
  const manifestRead = readJsonFile(join(settings.nativeDir, 'build.json'));
  const manifest = manifestRead.ok && manifestRead.value && typeof manifestRead.value === 'object' ? manifestRead.value : undefined;
  const expectedSha = typeof manifest?.sha256 === 'string' ? manifest.sha256.trim().toLowerCase() : '';
  const state = compareSha(expectedSha, installedDll.sha256);
  const tokenFile = settings.clientTokenFile;
  return {
    dir: settings.clientDir,
    exe: settings.clientExe,
    exists: isFile(settings.clientExe),
    version,
    versionMatches: versionsMatch(version, settings.expectedVersion),
    dll: {
      state,
      expectedSha256: expectedSha,
      installed: { path: toPosix(join(settings.clientDir, 'version.dll')), sha256: installedDll.sha256, state: installedDll.state },
      native: { path: toPosix(join(settings.nativeDir, 'version.dll')), sha256: nativeDll.sha256, state: nativeDll.state },
      manifest: {
        ok: manifestRead.ok,
        error: manifestRead.error,
        targetVersion: normalizeVersion(manifest?.targetVersion),
        sha256: expectedSha,
        commit: typeof manifest?.commit === 'string' ? manifest.commit : '',
      },
    },
    token: {
      file: toPosix(tokenFile),
      present: isFile(tokenFile),
    },
  };
}

/**
 * Full read-only diagnostic report.
 *
 * @param {Record<string, any>} settings
 * @param {{runCommand?: typeof runPowerShellCommand, fetchImpl?: typeof fetch, probePort?: typeof probePort, signal?: AbortSignal}} [deps]
 * @returns {Promise<Record<string, any>>}
 */
export async function collectStatus(settings, deps = {}) {
  const runCommand = deps.runCommand ?? runPowerShellCommand;
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const portProbe = deps.probePort ?? probePort;
  const generatedAt = new Date().toISOString();

  const runtimeRead = readJsonFile(settings.runtimeFile);
  const runtime =
    runtimeRead.ok && runtimeRead.value && typeof runtimeRead.value === 'object'
      ? runtimeRead.value
      : undefined;
  const servicePids = runtime
    ? Object.values(runtime)
        .map((entry) => Number(entry?.pid))
        .filter((pid) => Number.isFinite(pid) && pid > 0)
    : [];

  let probe = emptyProbe();
  let probeError = '';
  const probeTimeoutMs = Number.isFinite(settings?.timeouts?.probeMs) ? settings.timeouts.probeMs : PROBE_TIMEOUT_MS;
  if (!settings.workspaceValid) {
    probeError = '工作区无效，跳过系统探测。';
  } else {
    try {
      const result = await runCommand(settings, PROBE_COMMAND, {
        timeoutMs: probeTimeoutMs,
        env: {
          DSH_WECHAT_DEPLOY_REGISTRY: settings.desktopRegistryKey,
          DSH_WECHAT_DEPLOY_DESKTOP_EXE: settings.desktopWechatExe,
          DSH_WECHAT_DEPLOY_CLIENT_EXE: settings.clientExe,
          DSH_WECHAT_DEPLOY_PIDS: servicePids.join(','),
        },
        ...(deps.signal === undefined ? {} : { signal: deps.signal }),
      });
      if (result.code !== 0) {
        probeError = `只读探测失败（退出码 ${result.code}）：${tail(result.stderr || result.stdout, 4)}`;
      } else {
        probe = parseProbeOutput(result.stdout);
      }
    } catch (error) {
      probeError = `只读探测失败：${messageOf(error)}`;
    }
  }

  const desktop = buildDesktop(settings, probe.desktop);
  const client = buildClient(settings, probe.client);
  const processes = classifyProcesses(probe.processes, settings.clientDir);
  const services = evaluateServices(runtime, runtimeRead, probe.services);
  const token = readToken(settings.tokenFile);
  const hook = await hookHealth(settings, { fetchImpl, ...(deps.signal === undefined ? {} : { signal: deps.signal }) });
  const ports = await checkPorts(settings, (port) => portProbe(port));

  const checks = {
    workspace: settings.workspaceValid && settings.configOk,
    client: client.exists && client.versionMatches,
    dll: client.dll.state === 'match',
    token: token.ok,
    hook:
      hook.ok &&
      hook.health?.startupState === 'ready' &&
      versionsMatch(hook.health?.version, settings.expectedVersion),
    processes: processes.hookedCount > 0,
    ports: ports.every((port) => port.listening),
    services: services.ok,
  };
  const ok = Object.values(checks).every(Boolean);

  const warnings = [];
  if (probeError !== '') warnings.push(probeError);
  for (const error of probe.errors) if (error !== '') warnings.push(`探测告警：${error}`);
  if (desktop.error !== '') warnings.push(`桌面微信注册表读取失败：${desktop.error}`);
  if (settings.configError !== '') warnings.push(`config/wechatagent.json 读取失败：${settings.configError}`);
  if (desktop.exists && desktop.version === '') warnings.push('读到了桌面微信路径，但取不到版本号。');
  if (!desktop.exists) warnings.push('没找到桌面微信安装路径（注册表 HKCU\\Software\\Tencent\\Weixin）。');
  if (desktop.exists && desktop.version !== '' && !desktop.matchesExpected) {
    warnings.push(
      `桌面微信版本 ${desktop.version} 与 Hook 期望 ${settings.expectedVersion} 不同：Hook 只匹配 ${settings.expectedVersion}，桌面版不参与部署。`,
    );
  }
  if (client.dll.state === 'mismatch') {
    warnings.push('客户端 version.dll 与 native/build.json 记录的 SHA256 不一致。');
  }
  if (processes.desktopMainRunning) {
    warnings.push(
      `桌面微信正在运行（pid ${processes.otherMain.map((row) => row.pid).join('、')}）：launch/restart 会拒绝执行，先从托盘退出。`,
    );
  }
  if (
    hook.ok &&
    hook.health?.pid > 0 &&
    processes.hookedCount > 0 &&
    !processes.hooked.some((row) => row.pid === hook.health.pid)
  ) {
    warnings.push(`Hook 报告的 pid ${hook.health.pid} 不在匹配客户端进程列表里，可能端口被别的进程占用。`);
  }

  const report = {
    ok,
    generatedAt,
    workspace: {
      path: settings.workspace,
      source: settings.workspaceSource,
      valid: settings.workspaceValid,
      configFile: settings.configFile,
      configOk: settings.configOk,
      configError: settings.configError,
    },
    expectedVersion: settings.expectedVersion,
    desktop,
    client,
    processes,
    hook: {
      url: hook.url,
      ok: hook.ok,
      httpStatus: hook.httpStatus,
      error: hook.error,
      elapsedMs: hook.elapsedMs,
      startupState: hook.health?.startupState ?? '',
      pid: hook.health?.pid ?? 0,
      version: hook.health?.version ?? '',
      integration: hook.health?.integration ?? '',
      backend: hook.health?.backend ?? '',
      databaseAccounts: hook.health?.databaseAccounts ?? [],
      raw: hook.health?.raw ?? null,
    },
    ports,
    services: { ok: services.ok, error: services.error, entries: services.entries },
    token: { file: toPosix(settings.tokenFile), ok: token.ok, error: token.error },
    checks,
    warnings: dedupe(warnings),
    probeError,
  };
  report.nextSteps = buildNextSteps(report);
  report.summary = formatSummary(report);
  return report;
}

/**
 * Light read-only health check: hook JSON + reader reachability + services.
 *
 * @param {Record<string, any>} settings
 * @param {{runCommand?: typeof runPowerShellCommand, fetchImpl?: typeof fetch, probePort?: typeof probePort, signal?: AbortSignal}} [deps]
 * @returns {Promise<Record<string, any>>}
 */
export async function collectHealth(settings, deps = {}) {
  const runCommand = deps.runCommand ?? runPowerShellCommand;
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const portProbe = deps.probePort ?? probePort;
  const generatedAt = new Date().toISOString();

  const runtimeRead = readJsonFile(settings.runtimeFile);
  const runtime =
    runtimeRead.ok && runtimeRead.value && typeof runtimeRead.value === 'object'
      ? runtimeRead.value
      : undefined;
  const servicePids = runtime
    ? Object.values(runtime)
        .map((entry) => Number(entry?.pid))
        .filter((pid) => Number.isFinite(pid) && pid > 0)
    : [];

  let probe = emptyProbe();
  let probeError = '';
  const probeTimeoutMs = Number.isFinite(settings?.timeouts?.probeMs) ? settings.timeouts.probeMs : PROBE_TIMEOUT_MS;
  if (settings.workspaceValid) {
    try {
      const result = await runCommand(settings, PROBE_COMMAND, {
        timeoutMs: probeTimeoutMs,
        env: {
          DSH_WECHAT_DEPLOY_REGISTRY: settings.desktopRegistryKey,
          DSH_WECHAT_DEPLOY_DESKTOP_EXE: settings.desktopWechatExe,
          DSH_WECHAT_DEPLOY_CLIENT_EXE: settings.clientExe,
          DSH_WECHAT_DEPLOY_PIDS: servicePids.join(','),
        },
        ...(deps.signal === undefined ? {} : { signal: deps.signal }),
      });
      if (result.code !== 0) probeError = `服务探测失败（退出码 ${result.code}）`;
      else probe = parseProbeOutput(result.stdout);
    } catch (error) {
      probeError = `服务探测失败：${messageOf(error)}`;
    }
  }

  const services = evaluateServices(runtime, runtimeRead, probe.services);
  const hook = await hookHealth(settings, { fetchImpl, ...(deps.signal === undefined ? {} : { signal: deps.signal }) });
  const reader = readReaderEndpoint(settings);
  reader.listening = await portProbe(reader.port);

  const checks = {
    hook: hook.ok && hook.health?.startupState === 'ready',
    reader: reader.listening,
    services: services.ok,
  };
  const ok = checks.hook && checks.reader && checks.services;

  const report = {
    ok,
    generatedAt,
    workspace: settings.workspace,
    checks,
    hook: {
      url: hook.url,
      ok: hook.ok,
      httpStatus: hook.httpStatus,
      error: hook.error,
      elapsedMs: hook.elapsedMs,
      startupState: hook.health?.startupState ?? '',
      pid: hook.health?.pid ?? 0,
      version: hook.health?.version ?? '',
      integration: hook.health?.integration ?? '',
      backend: hook.health?.backend ?? '',
      databaseAccounts: hook.health?.databaseAccounts ?? [],
      raw: hook.health?.raw ?? null,
    },
    reader,
    services: { ok: services.ok, error: services.error, entries: services.entries },
    probeError,
  };
  report.nextSteps = buildHealthNextSteps(report);
  report.summary = formatHealthSummary(report);
  return report;
}

/**
 * Reader endpoint from state/wechat-io-config.json, falling back to the port map.
 *
 * @param {Record<string, any>} settings
 * @returns {{baseUrl: string, port: number, listening: boolean}}
 */
export function readReaderEndpoint(settings) {
  const ioRead = readJsonFile(settings.ioConfigFile);
  const baseUrl = ioRead.ok && typeof ioRead.value?.reader_base_url === 'string'
    ? ioRead.value.reader_base_url.trim()
    : '';
  let port = settings.ports.weflow;
  if (baseUrl !== '') {
    try {
      const parsed = new URL(baseUrl);
      if (parsed.port !== '') port = Number(parsed.port);
      else port = parsed.protocol === 'https:' ? 443 : 80;
    } catch {
      /* keep the configured port */
    }
  }
  return { baseUrl: baseUrl === '' ? `http://127.0.0.1:${port}` : baseUrl, port, listening: false };
}

/**
 * Concrete next actions for the health report.
 *
 * @param {Record<string, any>} report
 * @returns {string[]}
 */
export function buildHealthNextSteps(report) {
  const steps = [];
  if (!report.checks?.hook) {
    if (report.hook?.error) steps.push('Hook 健康接口不可用：wechat_deploy_status 看完整原因，必要时 wechat_deploy_launch / restart。');
    else steps.push('Hook 不是 ready：调用 wechat_deploy_health 复查，仍失败用 wechat_deploy_restart。');
  }
  if (!report.checks?.reader) {
    steps.push(`读取器端口 ${report.reader?.port} 不通：wechat_deploy_services action=start 启动托管服务。`);
  }
  if (!report.checks?.services) {
    steps.push('托管服务没有全部存活：wechat_deploy_services action=restart。');
  }
  if (steps.length === 0) steps.push('一切正常，无需操作。');
  return steps;
}

/**
 * Readable Chinese summary of a full status report.
 *
 * @param {Record<string, any>} report
 * @returns {string}
 */
export function formatSummary(report) {
  const mark = (value) => (value ? '✅' : '❌');
  const lines = [];
  lines.push(`微信 Hook 部署状态（${formatTime(report.generatedAt)}）`);
  lines.push(`总体：${report.ok ? '✅ 正常' : '❌ 异常'}${report.ok && report.warnings.length > 0 ? '（有告警）' : ''}`);
  lines.push('');
  lines.push(`【工作区】${report.workspace.path}（来源 ${report.workspace.source}）${mark(report.checks.workspace)}`);
  lines.push(
    `【版本】期望 ${report.expectedVersion} · 匹配客户端 ${report.client.version || '未知'} ${mark(report.client.versionMatches)} · ` +
      `桌面微信 ${report.desktop.version || '未知'} ${report.desktop.matchesExpected ? '✅ 一致' : '⚠️ 不同（仅信息）'}`,
  );
  lines.push(`【匹配客户端】${report.client.exe} ${mark(report.client.exists)}`);
  lines.push(`【version.dll】${formatDllLine(report.client.dll)}`);
  lines.push(`【令牌】${report.token.file} ${mark(report.token.ok)}${report.token.ok ? '' : ` ${report.token.error}`}`);
  lines.push(`【Hook 健康】${formatHookLine(report.hook)}`);
  const otherMain = report.processes.otherMain ?? [];
  lines.push(
    `【进程】匹配客户端 ${report.processes.hookedCount} 个${formatPids(report.processes.hooked)} · ` +
      `其他 Weixin.exe ${report.processes.otherCount} 个${otherMain.length === 0 ? '' : `（主进程 ${otherMain.length} 个：pid ${otherMain.map((row) => row.pid).join('、')}）`} · ` +
      `WeChatAgent.exe ${report.processes.wechatAgentCount} 个`,
  );  lines.push(
    `【端口】${report.ports
      .map((port) => `${port.label} ${port.port} ${port.listening ? '✅' : '❌'}`)
      .join(' · ')}`,
  );
  lines.push(`【托管服务】${formatServicesLine(report.services)}`);
  if (report.warnings.length > 0) {
    lines.push('');
    for (const warning of report.warnings) lines.push(`⚠️ ${warning}`);
  }
  lines.push('');
  lines.push('【下一步】');
  report.nextSteps.forEach((step, index) => lines.push(`${index + 1}. ${step}`));
  return lines.join('\n');
}

/**
 * Readable Chinese summary of the light health report.
 *
 * @param {Record<string, any>} report
 * @returns {string}
 */
export function formatHealthSummary(report) {
  const mark = (value) => (value ? '✅' : '❌');
  const lines = [];
  lines.push(`微信 Hook 健康（${formatTime(report.generatedAt)}）`);
  lines.push(`总体：${report.ok ? '✅ 正常' : '❌ 异常'}`);
  lines.push('');
  lines.push(`【Hook】${formatHookLine(report.hook)}`);
  lines.push(`【读取器】${report.reader.baseUrl} ${mark(report.reader.listening)}`);
  lines.push(`【托管服务】${formatServicesLine(report.services)}`);
  if (report.probeError !== '') lines.push(`【探测】⚠️ ${report.probeError}`);
  lines.push('');
  lines.push('【下一步】');
  report.nextSteps.forEach((step, index) => lines.push(`${index + 1}. ${step}`));
  return lines.join('\n');
}

/**
 * Summary + fenced JSON, the exact text both the tool and the CLI print.
 *
 * @param {Record<string, any>} report
 * @returns {string}
 */
export function formatStatusReport(report) {
  const { summary, ...rest } = report;
  return `${summary ?? formatSummary(report)}\n\n完整报告（JSON）：\n${jsonBlock(rest)}`;
}

/**
 * @param {Record<string, any>} report
 * @returns {string}
 */
export function formatHealthReport(report) {
  const { summary, ...rest } = report;
  return `${summary ?? formatHealthSummary(report)}\n\nHook JSON：\n${jsonBlock(report.hook?.raw ?? null)}`;
}

/**
 * Concrete next actions for a status report.
 *
 * @param {Record<string, any>} report
 * @returns {string[]}
 */
export function buildNextSteps(report) {
  const steps = [];
  const checks = report.checks ?? {};
  const client = report.client ?? {};
  const desktop = report.desktop ?? {};
  const hook = report.hook ?? {};
  const processes = report.processes ?? {};
  const services = report.services ?? {};

  if (!checks.workspace) {
    steps.push('工作区无效：检查 workspace 配置（需包含 config/wechatagent.json 与 state/），或安装/修复 WeChatAgent。');
  }
  if (report.workspace?.configOk === false) {
    steps.push('config/wechatagent.json 不是合法 JSON：修正后再重试。');
  }
  if (checks.workspace && !client.exists) {
    steps.push(
      `匹配客户端不存在（${client.exe || '未知路径'}）：按 docs/WECHAT_HOOK.md 准备 ${report.expectedVersion} 客户端，再调用 wechat_deploy_prepare。`,
    );
  } else if (client.exists && client.versionMatches === false) {
    steps.push(
      `匹配客户端版本 ${client.version || '未知'} 与期望 ${report.expectedVersion} 不一致：换成匹配客户端后调用 wechat_deploy_prepare。`,
    );
  }
  if (client.dll?.state === 'missing') {
    steps.push('客户端里还没有 version.dll：先 wechat_deploy_prepare（没有构建产物时先 wechat_deploy_build）。');
  }
  if (client.dll?.state === 'mismatch') {
    steps.push('客户端 version.dll 与 native/build.json 的 SHA256 不一致：退出匹配微信后重新 wechat_deploy_prepare；构建清单过期则先 wechat_deploy_build。');
  }
  if (client.dll?.state === 'unknown') {
    steps.push('native/build.json 缺少 sha256：先 wechat_deploy_build 生成可信构建清单。');
  }
  if (!checks.token) {
    steps.push('Hook 令牌缺失或格式不对：执行 wechat_deploy_prepare 重新写入本地令牌。');
  }
  if (!checks.hook) {
    if (processes.hookedCount === 0) {
      steps.push('匹配客户端没有在运行：调用 wechat_deploy_launch 准备并启动它。');
    } else {
      steps.push('匹配客户端在运行但 Hook 未就绪：调用 wechat_deploy_restart 重启，并查看 state/logs/hook-init.log。');
    }
    if (typeof hook.error === 'string' && hook.error.includes('HTTP 401')) {
      steps.push('Hook 拒绝令牌（401）：重启匹配客户端刷新令牌后再试。');
    }
    if (hook.startupState && hook.startupState !== 'ready') {
      steps.push(`Hook 当前状态 ${hook.startupState}：初始化最多需要 30 秒，稍后重试 wechat_deploy_health。`);
    }
    if (hook.version && !versionsMatch(hook.version, report.expectedVersion)) {
      steps.push(`Hook 返回版本 ${hook.version}，期望 ${report.expectedVersion}：wechat_deploy_build 重新构建，再 prepare/launch。`);
    }
  }
  if (!checks.ports) {
    const down = (report.ports ?? [])
      .filter((port) => !port.listening)
      .map((port) => `${port.label} ${port.port}`);
    steps.push(`端口未监听（${down.join('、')}）：调用 wechat_deploy_services action=start 启动托管服务。`);
  }
  if (!checks.services) {
    const broken = (services.entries ?? [])
      .filter((entry) => !entry.alive || entry.exeMatches === false)
      .map((entry) => entry.name);
    if (broken.length > 0) steps.push(`托管服务异常（${broken.join('、')}）：调用 wechat_deploy_services action=restart。`);
    else steps.push('state/runtime.json 缺少可用的托管服务记录：启动 WeChatAgent，或 wechat_deploy_services action=start。');
  }
  if (processes.desktopMainRunning && !checks.hook) {
    steps.push('桌面微信正在运行：launch/restart 前先从托盘完全退出它（本工具不会结束桌面微信）。');
  }
  if (steps.length === 0) {
    steps.push(
      processes.desktopMainRunning
        ? `当前无需操作；需要 launch/restart 时先从托盘退出桌面微信（pid ${processes.otherMain.map((row) => row.pid).join('、')}）。`
        : '一切正常，无需操作。',
    );
  }
  return dedupe(steps);
}

/**
 * @param {string} iso
 * @returns {string}
 */
export function formatTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso ?? '');
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(
    date.getMinutes(),
  )}:${pad(date.getSeconds())}`;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
export function jsonBlock(value) {
  return ['```json', JSON.stringify(value, null, 2), '```'].join('\n');
}

/**
 * @param {string} sha
 * @returns {string}
 */
export function shortSha(sha) {
  const value = typeof sha === 'string' ? sha : '';
  if (value.length <= 16) return value;
  return `${value.slice(0, 8)}…${value.slice(-6)}`;
}

/**
 * @param {string[]} values
 * @returns {string[]}
 */
export function dedupe(values) {
  return [...new Set(values.filter((value) => typeof value === 'string' && value.trim() !== ''))];
}

/**
 * @param {Record<string, any>} dll
 * @returns {string}
 */
function formatDllLine(dll) {
  if (!dll) return '未知';
  const state =
    dll.state === 'match' ? '✅ 与 build.json 一致' : dll.state === 'mismatch' ? '❌ 与 build.json 不一致' : dll.state === 'missing' ? '❌ 客户端缺失 version.dll' : '⚠️ build.json 无 sha256';
  const installed = dll.installed?.sha256 ? shortSha(dll.installed.sha256) : '缺失';
  const expected = dll.expectedSha256 ? shortSha(dll.expectedSha256) : '缺失';
  return `客户端 ${installed} · build.json ${expected} → ${state}`;
}

/**
 * One-line hook summary reused by the action reports.
 *
 * @param {Record<string, any>} hook
 * @returns {string}
 */
export function formatHookLine(hook) {
  if (!hook || !hook.ok) return `❌ ${hook?.error || '不可用'}`;
  const accounts = hook.databaseAccounts ?? [];
  return [
    `✅ ${hook.startupState || '未知状态'}`,
    `pid ${hook.pid || '?'}`,
    `version ${hook.version || '?'}`,
    `backend ${hook.backend || '?'}`,
    `integration ${hook.integration || '?'}`,
    `账号 ${accounts.length} 个`,
  ].join(' · ');
}

/**
 * @param {{entries?: Array<Record<string, any>>, ok?: boolean, error?: string}} services
 * @returns {string}
 */
function formatServicesLine(services) {
  const entries = services?.entries ?? [];
  if (entries.length === 0) return `❌ ${services?.error || '没有托管服务记录'}`;
  const text = entries
    .map((entry) => {
      const state = entry.alive && entry.exeMatches !== false && entry.markerExists ? '✅' : '❌';
      return `${entry.name} ${entry.pid} ${state}`;
    })
    .join(' · ');
  return services.ok ? text : `${text}（有异常）`;
}

/**
 * @param {Array<{pid: number}>} rows
 * @returns {string}
 */
function formatPids(rows) {
  const pids = (Array.isArray(rows) ? rows : []).map((row) => row.pid).filter((pid) => Number.isFinite(pid));
  if (pids.length === 0) return '';
  const shown = pids.slice(0, 6).join('、');
  return `（pid ${shown}${pids.length > 6 ? '…' : ''}）`;
}
