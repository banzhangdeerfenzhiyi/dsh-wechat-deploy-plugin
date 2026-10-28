/**
 * Offline unit tests for the deploy plugin.
 *
 *   node test/unit.test.mjs        (or: npm test)
 *
 * No network, no PowerShell, no processes: settings resolution runs on temp
 * fixtures, the status collector is fed an injected probe/fetch/port probe, and
 * every judgement helper is tested directly.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildNextSteps,
  checkPorts,
  classifyProcesses,
  collectStatus,
  compareSha,
  evaluateServices,
  formatHealthReport,
  formatHookLine,
  formatStatusReport,
  formatSummary,
  hookHealth,
  isAppUnderDir,
  normalizeVersion,
  parseProcessList,
  parseProbeOutput,
  portDefinitions,
  readReaderEndpoint,
  readToken,
  sha256File,
  versionsMatch,
} from '../src/status.mjs';
import {
  DEFAULT_EXPECTED_VERSION,
  DEFAULT_HOOK_URL,
  DEFAULT_PORTS,
  DEFAULT_WORKSPACE,
  dshHome,
  isWorkspace,
  readJsonFile,
  resolveSettings,
  resolveWorkspace,
  toPosix,
  workspaceCandidates,
} from '../src/settings.mjs';
import {
  ConfirmRequiredError,
  firstErrorLine,
  formatActionResult,
  hintFor,
  parseStopOutput,
  prepareHook,
  refusal,
  requireConfirm,
} from '../src/actions.mjs';
import {
  buildManagedBlock,
  countManagedBlocks,
  fileUrl,
  stripManagedBlock,
  upsertManagedBlock,
} from '../src/patch.mjs';
import { apply as pluginApply, inject as pluginInject, name as pluginName } from '../index.mjs';
import {
  buildPowerShellArgs,
  cleanStream,
  decodeOutput,
  encodeCommand,
  tail,
} from '../src/powershell.mjs';

let passed = 0;
let failed = 0;

/** @param {string} label @param {() => void} body */
function test(label, body) {
  try {
    body();
    passed += 1;
    console.log(`ok   ${label}`);
  } catch (error) {
    failed += 1;
    process.exitCode = 1;
    console.error(`FAIL ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** @param {string} label @param {() => Promise<void>} body */
async function testAsync(label, body) {
  try {
    await body();
    passed += 1;
    console.log(`ok   ${label}`);
  } catch (error) {
    failed += 1;
    process.exitCode = 1;
    console.error(`FAIL ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const ROOT = mkdtempSync(join(tmpdir(), 'dsh-wechat-deploy-'));
const SHA = 'de9e8149135a460469707b64c90d3b9bf458f78ab3c94c67798a401dc1408433';

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

/**
 * @param {string} name
 * @param {{absoluteExecutable?: boolean}} [options]
 * @returns {{root: string, workspace: string}}
 */
function createWorkspace(name, options = {}) {
  const workspace = toPosix(join(ROOT, name));
  const clientDir = join(workspace, 'state', 'hook', 'wechat-4.1.10.27');
  mkdirSync(join(workspace, 'config'), { recursive: true });
  mkdirSync(join(workspace, 'state', 'hook', 'native'), { recursive: true });
  mkdirSync(clientDir, { recursive: true });
  mkdirSync(join(workspace, 'scripts'), { recursive: true });

  const executable = options.absoluteExecutable
    ? toPosix(join(ROOT, `${name}-client`, 'Weixin.exe'))
    : 'state/hook/wechat-4.1.10.27/Weixin.exe';
  if (options.absoluteExecutable) mkdirSync(join(ROOT, `${name}-client`), { recursive: true });

  writeFileSync(
    join(workspace, 'config', 'wechatagent.json'),
    JSON.stringify(
      {
        version: 1,
        hook: {
          baseUrl: 'http://127.0.0.1:31111',
          expectedVersion: '4.1.10.27',
          wechatExecutable: executable,
        },
        ports: { weflow: 6031, onebot: 21229, adapter: 18766, dshPlugin: 21230 },
      },
      null,
      2,
    ),
  );
  const dllSha = createHash('sha256').update('installed-dll-stub').digest('hex');
  writeFileSync(join(workspace, 'state', 'hook', 'native', 'build.json'), JSON.stringify({ targetVersion: '4.1.10.27', sha256: dllSha }));
  writeFileSync(join(workspace, 'state', 'hook', 'native', 'version.dll'), 'installed-dll-stub');
  writeFileSync(join(workspace, 'state', 'hook', 'native-token.txt'), 'a'.repeat(64));
  writeFileSync(join(clientDir, 'Weixin.exe'), 'client-stub');
  writeFileSync(join(clientDir, 'version.dll'), 'installed-dll-stub');
  writeFileSync(join(workspace, 'scripts', 'hook-onebot.mjs'), '// marker stub\n');
  writeFileSync(join(workspace, 'state', 'wechat-io-config.json'), JSON.stringify({ reader_base_url: 'http://127.0.0.1:6031', reader_token: 'b'.repeat(64) }));
  writeFileSync(
    join(workspace, 'state', 'runtime.json'),
    JSON.stringify({
      adapter: { pid: 1234, marker: toPosix(join(workspace, 'scripts', 'hook-onebot.mjs')), exe: 'C:/runtimes/node.exe' },
      reader: { pid: 4321, marker: toPosix(join(workspace, 'scripts', 'hook-onebot.mjs')), exe: 'C:/runtimes/python.exe' },
    }),
  );
  return { root: workspace, workspace };
}

/** @param {Record<string, any>} base @param {Record<string, any>} extra */
function deepMerge(base, extra) {
  if (!extra || typeof extra !== 'object') return base;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [key, value] of Object.entries(extra)) {
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      out[key] &&
      typeof out[key] === 'object' &&
      !Array.isArray(out[key])
    ) {
      out[key] = deepMerge(out[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** A healthy report with overridable fields. */
function makeReport(extra = {}) {
  const base = {
    ok: true,
    generatedAt: '2026-10-28T10:00:00.000Z',
    workspace: {
      path: 'D:/ws',
      source: 'config',
      valid: true,
      configFile: 'D:/ws/config/wechatagent.json',
      configOk: true,
      configError: '',
    },
    expectedVersion: '4.1.10.27',
    desktop: {
      registryKey: 'HKCU:\\Software\\Tencent\\Weixin',
      installPath: 'D:/wx',
      exe: 'D:/wx/Weixin.exe',
      exists: true,
      version: '4.1.10.27',
      matchesExpected: true,
      overridden: false,
      error: '',
    },
    client: {
      dir: 'D:/ws/state/hook/wechat-4.1.10.27',
      exe: 'D:/ws/state/hook/wechat-4.1.10.27/Weixin.exe',
      exists: true,
      version: '4.1.10.27',
      versionMatches: true,
      dll: {
        state: 'match',
        expectedSha256: SHA,
        installed: { path: 'D:/ws/state/hook/wechat-4.1.10.27/version.dll', sha256: SHA, state: 'ok' },
        native: { path: 'D:/ws/state/hook/native/version.dll', sha256: SHA, state: 'ok' },
        manifest: { ok: true, error: '', targetVersion: '4.1.10.27', sha256: SHA, commit: 'abc' },
      },
      token: { file: 'D:/ws/state/hook/wechat-4.1.10.27/wechatagent-hook.token', present: true },
    },
    processes: {
      hooked: [{ pid: 100, executable: 'D:/ws/state/hook/wechat-4.1.10.27/Weixin.exe', helper: false }],
      other: [],
      otherMain: [],
      wechatAgent: [],
      hookedCount: 1,
      otherCount: 0,
      wechatAgentCount: 0,
      desktopMainRunning: false,
    },
    hook: {
      url: 'http://127.0.0.1:30001/WeChatAgent/health',
      ok: true,
      httpStatus: 200,
      error: '',
      elapsedMs: 40,
      startupState: 'ready',
      pid: 100,
      version: '4.1.10.27',
      integration: 'WeChatAgent-1',
      backend: 'wechat-hook',
      databaseAccounts: ['wxid_x'],
      raw: {},
    },
    ports: [
      { name: 'weflow', label: '读取器', port: 5031, listening: true },
      { name: 'onebot', label: 'OneBot', port: 11229, listening: true },
      { name: 'adapter', label: '适配器', port: 8766, listening: true },
      { name: 'dshPlugin', label: 'DSH 插件', port: 11230, listening: true },
    ],
    services: {
      ok: true,
      error: '',
      entries: [
        {
          name: 'adapter',
          pid: 1234,
          alive: true,
          executable: 'C:/runtimes/node.exe',
          expectedExe: 'C:/runtimes/node.exe',
          exeMatches: true,
          marker: 'D:/ws/scripts/hook-onebot.mjs',
          markerExists: true,
        },
      ],
    },
    token: { file: 'D:/ws/state/hook/native-token.txt', ok: true, error: '' },
    checks: {
      workspace: true,
      client: true,
      dll: true,
      token: true,
      hook: true,
      processes: true,
      ports: true,
      services: true,
    },
    warnings: [],
    probeError: '',
  };
  const merged = deepMerge(base, extra);
  merged.nextSteps = extra.nextSteps ?? buildNextSteps(merged);
  merged.summary = extra.summary ?? formatSummary(merged);
  return merged;
}

// ---------------------------------------------------------------------------
// plugin entry shape
// ---------------------------------------------------------------------------

test('plugin entry exports name/inject/apply', () => {
  assert.equal(pluginName, 'dsh-wechat-deploy');
  assert.deepEqual(pluginInject, ['tools']);
  assert.equal(typeof pluginApply, 'function');
});

// ---------------------------------------------------------------------------
// settings resolution
// ---------------------------------------------------------------------------

const fixture = createWorkspace('ws-main');

test('resolveSettings derives every path from config/wechatagent.json', () => {
  const settings = resolveSettings({ workspace: fixture.workspace });
  assert.equal(settings.workspace, fixture.workspace);
  assert.equal(settings.workspaceSource, 'config');
  assert.equal(settings.workspaceValid, true);
  assert.equal(settings.configOk, true);
  assert.equal(settings.expectedVersion, '4.1.10.27');
  assert.equal(settings.hookUrl, 'http://127.0.0.1:31111');
  assert.equal(settings.clientDir, toPosix(join(fixture.workspace, 'state/hook/wechat-4.1.10.27')));
  assert.equal(settings.clientExe, toPosix(join(settings.clientDir, 'Weixin.exe')));
  assert.equal(settings.clientTokenFile, toPosix(join(settings.clientDir, 'wechatagent-hook.token')));
  assert.equal(settings.scriptsDir, toPosix(join(fixture.workspace, 'scripts')));
  assert.equal(settings.tokenFile, toPosix(join(fixture.workspace, 'state/hook/native-token.txt')));
  assert.equal(settings.nativeDir, toPosix(join(fixture.workspace, 'state/hook/native')));
  assert.equal(settings.runtimeFile, toPosix(join(fixture.workspace, 'state/runtime.json')));
  assert.equal(settings.ioConfigFile, toPosix(join(fixture.workspace, 'state/wechat-io-config.json')));
  assert.equal(settings.ports.weflow, 6031);
  assert.equal(settings.ports.onebot, 21229);
  assert.equal(settings.ports.adapter, 18766);
  assert.equal(settings.ports.dshPlugin, 21230);
  assert.equal(settings.timeouts.buildMs, 900_000);
});

test('resolveSettings honours an absolute hook.wechatExecutable', () => {
  const other = createWorkspace('ws-abs', { absoluteExecutable: true });
  const settings = resolveSettings({ workspace: other.workspace });
  assert.equal(settings.clientDir, toPosix(join(ROOT, 'ws-abs-client')));
  assert.equal(settings.clientExe, toPosix(join(ROOT, 'ws-abs-client', 'Weixin.exe')));
});

test('patch config overrides ports, hookUrl, expectedVersion and directories', () => {
  const settings = resolveSettings({
    workspace: fixture.workspace,
    hookUrl: 'http://127.0.0.1:39999/',
    expectedVersion: '9.9.9.9',
    ports: { adapter: 9999 },
    scriptsDir: 'D:/custom/scripts',
    timeouts: { buildMs: 1, launchMs: 600 },
  });
  assert.equal(settings.hookUrl, 'http://127.0.0.1:39999');
  assert.equal(settings.expectedVersion, '9.9.9.9');
  assert.equal(settings.ports.adapter, 9999);
  assert.equal(settings.scriptsDir, 'D:/custom/scripts');
  assert.equal(settings.timeouts.buildMs, 500);
  assert.equal(settings.timeouts.launchMs, 600);
});

test('unknown workspace disables nothing but reports invalid, keeping defaults', () => {
  const settings = resolveSettings({ workspace: 'Z:/definitely-missing-workspace' });
  assert.equal(settings.workspace, 'Z:/definitely-missing-workspace');
  assert.equal(settings.workspaceValid, false);
  assert.equal(settings.configOk, false);
  assert.equal(settings.expectedVersion, DEFAULT_EXPECTED_VERSION);
  assert.equal(settings.hookUrl, DEFAULT_HOOK_URL);
  assert.deepEqual(settings.ports, DEFAULT_PORTS);
  assert.ok(settings.clientDir.endsWith(`wechat-${DEFAULT_EXPECTED_VERSION}`));
  assert.ok(settings.promptText.includes('wechat_deploy_status'));
});

test('WECHATAGENT_WORKSPACE env wins over the built-in candidates', () => {
  const settings = resolveSettings({}, { WECHATAGENT_WORKSPACE: fixture.workspace, DSH_HOME: join(ROOT, 'dsh-home') });
  assert.equal(settings.workspace, fixture.workspace);
  assert.equal(settings.workspaceSource, 'env:WECHATAGENT_WORKSPACE');
  assert.equal(settings.workspaceValid, true);
});

test('explicit config beats env even when it does not exist', () => {
  const resolved = resolveWorkspace('Z:/explicit', { WECHATAGENT_WORKSPACE: fixture.workspace });
  assert.equal(resolved.path, 'Z:/explicit');
  assert.equal(resolved.source, 'config');
  assert.equal(resolved.valid, false);
});

test('workspace candidates keep the documented order and include dsh-home', () => {
  const candidates = workspaceCandidates({ DSH_HOME: 'C:/tmp/dsh-home-test' });
  // No DEFAULT_WORKSPACE default in the public build: env → ~/Documents/data/workspace → <DSH_HOME>/wechatagent
  assert.deepEqual(candidates.map((item) => item.source), [
    'home:Documents/data/workspace',
    'dsh-home:wechatagent',
  ]);
  assert.ok(candidates[0].path.endsWith('/Documents/data/workspace'));
  assert.equal(candidates[1].path, 'C:/tmp/dsh-home-test/wechatagent');
  // An explicit env candidate comes first when present.
  const withEnv = workspaceCandidates({ DSH_HOME: 'C:/tmp/dsh-home-test', WECHATAGENT_WORKSPACE: 'D:/wa/ws' });
  assert.equal(withEnv[0].source, 'env:WECHATAGENT_WORKSPACE');
  assert.equal(withEnv[0].path, 'D:/wa/ws');
});

test('isWorkspace needs both config/wechatagent.json and state/', () => {
  assert.equal(isWorkspace(fixture.workspace), true);
  assert.equal(isWorkspace(join(ROOT, 'nope')), false);
  const empty = join(ROOT, 'ws-empty');
  mkdirSync(join(empty, 'config'), { recursive: true });
  assert.equal(isWorkspace(empty), false);
});

test('toPosix and dshHome normalize Windows paths', () => {
  assert.equal(toPosix('D:\\a\\b\\'), 'D:/a/b');
  assert.equal(toPosix('C:\\'), 'C:/');
  assert.equal(toPosix(''), '');
  assert.equal(toPosix(undefined), '');
  assert.equal(dshHome({ DSH_HOME: 'C:\\Users\\x\\.dsh\\' }), 'C:/Users/x/.dsh');
});

test('readJsonFile reports instead of throwing', () => {
  const good = readJsonFile(join(fixture.workspace, 'config', 'wechatagent.json'));
  assert.equal(good.ok, true);
  const bad = readJsonFile(join(ROOT, 'missing.json'));
  assert.equal(bad.ok, false);
  assert.ok(bad.error.length > 0);
});

// ---------------------------------------------------------------------------
// version + hash helpers
// ---------------------------------------------------------------------------

test('normalizeVersion extracts dotted versions only', () => {
  assert.equal(normalizeVersion('4.1.10.27'), '4.1.10.27');
  assert.equal(normalizeVersion('v4.1.10.27 (123)'), '4.1.10.27');
  assert.equal(normalizeVersion(' 4.2.0.8 '), '4.2.0.8');
  assert.equal(normalizeVersion(''), '');
  assert.equal(normalizeVersion(undefined), '');
});

test('versionsMatch compares equal normalized versions', () => {
  assert.equal(versionsMatch('4.1.10.27', ' 4.1.10.27 '), true);
  assert.equal(versionsMatch('4.1.10.27', '4.1.10.28'), false);
  assert.equal(versionsMatch('4.1.10', '4.1.10.27'), false);
  assert.equal(versionsMatch('', ''), false);
});

test('compareSha covers match/mismatch/missing/unknown', () => {
  assert.equal(compareSha(SHA.toUpperCase(), SHA), 'match');
  assert.equal(compareSha(SHA, 'f'.repeat(64)), 'mismatch');
  assert.equal(compareSha(SHA, ''), 'missing');
  assert.equal(compareSha('', SHA), 'unknown');
});

test('sha256File hashes real files and reports missing ones', () => {
  const file = join(ROOT, 'hash-me.txt');
  writeFileSync(file, 'abc');
  assert.equal(sha256File(file).sha256, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(sha256File(join(ROOT, 'nope.dll')).state, 'missing');
});

// ---------------------------------------------------------------------------
// process classification
// ---------------------------------------------------------------------------

const CLIENT_DIR = 'D:/ws/state/hook/wechat-4.1.10.27';

test('isAppUnderDir respects directory boundaries', () => {
  assert.equal(isAppUnderDir('D:\\ws\\client\\Weixin.exe', 'D:/ws/client'), true);
  assert.equal(isAppUnderDir('D:/ws/client/Weixin.exe', 'D:/WS/CLIENT'), true);
  assert.equal(isAppUnderDir('D:/ws/client-evil/Weixin.exe', 'D:/ws/client'), false);
  assert.equal(isAppUnderDir('', 'D:/ws/client'), false);
});

test('classifyProcesses splits hooked client, desktop and helper processes', () => {
  const classified = classifyProcesses(
    [
      { name: 'Weixin.exe', pid: 1, executable: `${CLIENT_DIR}/Weixin.exe`, commandLine: '"…Weixin.exe" StartPort=30001' },
      { name: 'Weixin.exe', pid: 2, executable: `${CLIENT_DIR}/Weixin.exe`, commandLine: '"…Weixin.exe" --type=wxocr' },
      { name: 'Weixin.exe', pid: 3, executable: 'D:/微信/Weixin/Weixin.exe', commandLine: '"D:\\微信\\Weixin\\Weixin.exe" ' },
      { name: 'Weixin.exe', pid: 4, executable: 'D:/微信/Weixin/Weixin.exe', commandLine: '"…" --type=wxplayer' },
      { name: 'WeChatAgent.exe', pid: 5, executable: 'D:/app/WeChatAgent.exe', commandLine: '"…" --type=gpu-process' },
    ],
    CLIENT_DIR,
  );
  assert.equal(classified.hookedCount, 2);
  assert.equal(classified.otherCount, 2);
  assert.equal(classified.otherMain.length, 1);
  assert.equal(classified.otherMain[0].pid, 3);
  assert.equal(classified.wechatAgentCount, 1);
  assert.equal(classified.desktopMainRunning, true);
});

// ---------------------------------------------------------------------------
// probe parsing
// ---------------------------------------------------------------------------

test('parseProbeOutput unwraps the probe JSON and tolerates banners', () => {
  const parsed = parseProbeOutput(
    `banner line\n{"processes":{"name":"Weixin.exe","pid":7,"executable":"D:\\\\x\\\\Weixin.exe","commandLine":""},"services":[],"desktop":{"version":"4.2.0.8"},"client":{"version":"4.1.10.27"},"errors":[]}\ntrailer`,
  );
  assert.equal(parsed.processes.length, 1);
  assert.equal(parsed.processes[0].pid, 7);
  assert.equal(parsed.desktop.version, '4.2.0.8');
  assert.deepEqual(parsed.errors, []);
  assert.throws(() => parseProbeOutput(''), /无法解析/);
});

test('parseProcessList returns normalized rows', () => {
  const rows = parseProcessList(
    '[{"pid":1,"executable":"D:\\\\ws\\\\Weixin.exe","commandLine":"x"},{"pid":2,"executable":null,"commandLine":""}]',
  );
  assert.equal(rows.length, 2);
  assert.equal(rows[0].executable, 'D:/ws/Weixin.exe');
  assert.deepEqual(parseProcessList(''), []);
});

// ---------------------------------------------------------------------------
// services, tokens, ports
// ---------------------------------------------------------------------------

test('evaluateServices joins runtime.json with live pids', () => {
  const runtime = { adapter: { pid: 10, marker: 'D:/ws/scripts/s.mjs', exe: 'C:/node.exe' } };
  const live = [{ pid: 10, alive: true, executable: 'C:\\node.exe' }];
  const result = evaluateServices(runtime, { ok: true, error: '' }, live);
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].exeMatches, true);
  assert.equal(result.entries[0].markerExists, false); // fixture file does not exist for this path
  assert.equal(result.ok, false);
  assert.equal(evaluateServices(undefined, { ok: false, error: '缺少 state/runtime.json' }, []).error, '缺少 state/runtime.json');
});

test('evaluateServices is ok when pid, exe, marker all check out', () => {
  const marker = toPosix(join(fixture.workspace, 'scripts', 'hook-onebot.mjs'));
  const runtime = { adapter: { pid: 10, marker, exe: 'C:/node.exe' } };
  const result = evaluateServices(runtime, { ok: true, error: '' }, [{ pid: 10, alive: true, executable: 'C:/node.exe' }]);
  assert.equal(result.ok, true);
  assert.equal(result.entries[0].markerExists, true);
});

test('readToken validates the 64-hex format', () => {
  const valid = join(fixture.workspace, 'state', 'hook', 'native-token.txt');
  assert.equal(readToken(valid).ok, true);
  const bad = join(ROOT, 'bad-token.txt');
  writeFileSync(bad, 'not-a-token');
  assert.equal(readToken(bad).ok, false);
  assert.match(readToken(bad).error, /格式不对/);
  assert.equal(readToken(join(ROOT, 'missing-token.txt')).ok, false);
});

test('portDefinitions reflects configured ports; checkPorts is injectable', async () => {
  const settings = resolveSettings({ workspace: fixture.workspace });
  const defs = portDefinitions(settings);
  assert.deepEqual(defs.map((item) => item.port), [6031, 21229, 18766, 21230]);
  const ports = await checkPorts(settings, async (port) => port === 18766);
  assert.deepEqual(ports.map((item) => item.listening), [false, false, true, false]);
});

test('readReaderEndpoint prefers state/wechat-io-config.json', () => {
  const settings = resolveSettings({ workspace: fixture.workspace });
  const reader = readReaderEndpoint(settings);
  assert.equal(reader.baseUrl, 'http://127.0.0.1:6031');
  assert.equal(reader.port, 6031);
});

// ---------------------------------------------------------------------------
// hook health (injected fetch)
// ---------------------------------------------------------------------------

await testAsync('hookHealth parses a ready payload and sends the bearer token', async () => {
  const settings = resolveSettings({ workspace: fixture.workspace });
  let seen;
  const fetchImpl = async (url, init) => {
    seen = { url, init };
    return new Response(
      JSON.stringify({
        startupState: 'ready',
        pid: 852,
        version: '4.1.10.27',
        integration: 'WeChatAgent-1',
        backend: 'wechat-hook',
        databaseAccounts: ['wxid_1'],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  };
  const health = await hookHealth(settings, { fetchImpl });
  assert.equal(health.ok, true);
  assert.equal(health.health.startupState, 'ready');
  assert.equal(health.health.pid, 852);
  assert.deepEqual(health.health.databaseAccounts, ['wxid_1']);
  assert.equal(seen.url, 'http://127.0.0.1:31111/WeChatAgent/health');
  assert.equal(seen.init.headers.Authorization, `Bearer ${'a'.repeat(64)}`);
});

await testAsync('hookHealth explains 401 and connection failures', async () => {
  const settings = resolveSettings({ workspace: fixture.workspace });
  const unauthorized = await hookHealth(settings, { fetchImpl: async () => new Response('no', { status: 401 }) });
  assert.equal(unauthorized.ok, false);
  assert.match(unauthorized.error, /HTTP 401/);
  assert.match(unauthorized.error, /令牌不匹配/);

  const offline = await hookHealth(settings, {
    fetchImpl: async () => {
      throw new Error('fetch failed');
    },
  });
  assert.equal(offline.ok, false);
  assert.match(offline.error, /连不上/);
});

await testAsync('hookHealth refuses a missing token before any network call', async () => {
  const settings = resolveSettings({ workspace: fixture.workspace, tokenFile: join(ROOT, 'no-token.txt') });
  let called = false;
  const health = await hookHealth(settings, {
    fetchImpl: async () => {
      called = true;
      return new Response('{}');
    },
  });
  assert.equal(health.ok, false);
  assert.equal(called, false);
  assert.match(health.error, /令牌/);
});

// ---------------------------------------------------------------------------
// nextSteps shaping
// ---------------------------------------------------------------------------

test('nextSteps is a single no-op step for a healthy report', () => {
  assert.deepEqual(buildNextSteps(makeReport()), ['一切正常，无需操作。']);
});

test('nextSteps points at the docs when the pinned client is missing', () => {
  const steps = buildNextSteps(makeReport({ client: { exists: false }, checks: { client: false, dll: false } }));
  assert.ok(steps.some((step) => step.includes('docs/WECHAT_HOOK.md')));
  assert.ok(steps.some((step) => step.includes('wechat_deploy_prepare')));
});

test('nextSteps asks for prepare on a DLL mismatch', () => {
  const steps = buildNextSteps(makeReport({ client: { dll: { state: 'mismatch' } }, checks: { dll: false } }));
  assert.ok(steps.some((step) => step.includes('SHA256') && step.includes('wechat_deploy_prepare')));
});

test('nextSteps asks for launch when the client is down', () => {
  const steps = buildNextSteps(
    makeReport({
      hook: { ok: false, error: '连不上', startupState: '', version: '' },
      processes: { hooked: [], hookedCount: 0 },
      checks: { hook: false, processes: false },
    }),
  );
  assert.ok(steps.some((step) => step.includes('wechat_deploy_launch')));
});

test('nextSteps asks for restart when the client runs but the hook is not ready', () => {
  const steps = buildNextSteps(makeReport({ hook: { ok: false, error: 'x', startupState: 'waiting' }, checks: { hook: false } }));
  assert.ok(steps.some((step) => step.includes('wechat_deploy_restart')));
  assert.ok(steps.some((step) => step.includes('waiting')));
});

test('nextSteps covers ports and managed services', () => {
  const report = makeReport({
    ports: [
      { name: 'weflow', label: '读取器', port: 5031, listening: false },
      { name: 'onebot', label: 'OneBot', port: 11229, listening: true },
      { name: 'adapter', label: '适配器', port: 8766, listening: true },
      { name: 'dshPlugin', label: 'DSH 插件', port: 11230, listening: true },
    ],
    checks: { ports: false, services: false },
    services: {
      ok: false,
      error: '',
      entries: [
        {
          name: 'adapter',
          pid: 1,
          alive: false,
          executable: '',
          expectedExe: 'C:/node.exe',
          exeMatches: null,
          marker: 'D:/ws/scripts/hook-onebot.mjs',
          markerExists: true,
        },
      ],
    },
  });
  const steps = buildNextSteps(report);
  assert.ok(steps.some((step) => step.includes('读取器 5031')));
  assert.ok(steps.some((step) => step.includes('wechat_deploy_services action=start')));
  assert.ok(steps.some((step) => step.includes('adapter') && step.includes('action=restart')));
});

test('nextSteps mentions a missing runtime.json', () => {
  const steps = buildNextSteps(
    makeReport({ checks: { services: false }, services: { ok: false, error: '缺少 state/runtime.json', entries: [] } }),
  );
  assert.ok(steps.some((step) => step.includes('state/runtime.json')));
});

test('nextSteps adds the desktop-WeChat note only when work is needed', () => {
  const idle = buildNextSteps(makeReport({ processes: { desktopMainRunning: true, otherMain: [{ pid: 7 }] } }));
  assert.equal(idle.length, 1);
  assert.ok(idle[0].includes('退出桌面微信'));

  const broken = buildNextSteps(
    makeReport({
      processes: { desktopMainRunning: true, otherMain: [{ pid: 7 }] },
      hook: { ok: false, error: 'x', startupState: '', version: '' },
      checks: { hook: false },
    }),
  );
  assert.ok(broken.some((step) => step.includes('launch/restart 前')));
});

// ---------------------------------------------------------------------------
// report formatting
// ---------------------------------------------------------------------------

test('formatSummary renders the Chinese report sections', () => {
  const summary = formatSummary(makeReport());
  assert.ok(summary.includes('微信 Hook 部署状态'));
  assert.ok(summary.includes('【工作区】D:/ws'));
  assert.ok(summary.includes('期望 4.1.10.27'));
  assert.ok(summary.includes('version.dll'));
  assert.ok(summary.includes('✅ ready'));
  assert.ok(summary.includes('【下一步】'));
  assert.ok(summary.includes('一切正常，无需操作。'));
});

test('formatStatusReport appends parseable JSON without duplicating the summary', () => {
  const text = formatStatusReport(makeReport({ summary: '摘要行' }));
  assert.ok(text.startsWith('摘要行'));
  assert.ok(text.includes('完整报告（JSON）'));
  const match = text.match(/```json\n([\s\S]*?)\n```/);
  assert.ok(match, 'json fence missing');
  const parsed = JSON.parse(match[1]);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.summary, undefined);
  assert.equal(parsed.expectedVersion, '4.1.10.27');
});

test('formatHookLine degrades gracefully without a payload', () => {
  assert.match(formatHookLine(null), /不可用/);
  assert.match(formatHookLine({ ok: false, error: 'HTTP 401' }), /HTTP 401/);
});

test('formatHealthReport prints the hook JSON block', () => {
  const report = {
    ok: true,
    generatedAt: '2026-10-28T10:00:00.000Z',
    summary: '健康摘要',
    hook: { ok: true, raw: { startupState: 'ready' }, startupState: 'ready', pid: 1, version: '4.1.10.27', integration: 'WeChatAgent-1', backend: 'wechat-hook', databaseAccounts: [] },
    reader: { baseUrl: 'http://127.0.0.1:5031', port: 5031, listening: true },
    services: { ok: true, error: '', entries: [{ name: 'adapter', pid: 1, alive: true, exeMatches: true, markerExists: true }] },
    checks: { hook: true, reader: true, services: true },
    probeError: '',
    nextSteps: ['一切正常，无需操作。'],
  };
  const text = formatHealthReport(report);
  assert.ok(text.includes('Hook JSON'));
  assert.ok(text.includes('"startupState": "ready"'));
});

// ---------------------------------------------------------------------------
// status collector end-to-end (injected probe / fetch / ports)
// ---------------------------------------------------------------------------

/** @param {string} clientExe @param {{desktopVersion?: string, extraProcesses?: Array<Record<string, any>>, alive?: boolean}} [options] */
function makeProbeStdout(clientExe, options = {}) {
  return {
    processes: [
      { name: 'Weixin.exe', pid: 100, executable: clientExe, commandLine: '"…Weixin.exe" StartPort=30001' },
      ...(options.extraProcesses ?? []),
      { name: 'WeChatAgent.exe', pid: 200, executable: 'D:/app/WeChatAgent.exe', commandLine: '"…"' },
    ],
    services: [
      { pid: 1234, alive: options.alive !== false, executable: 'C:/runtimes/node.exe' },
      { pid: 4321, alive: options.alive !== false, executable: 'C:/runtimes/python.exe' },
    ],
    desktop: {
      registryKey: 'HKCU:\\Software\\Tencent\\Weixin',
      installPath: 'D:/wx',
      exe: 'D:/wx/Weixin.exe',
      exists: true,
      version: options.desktopVersion ?? '4.2.0.8',
      overridden: false,
      error: '',
    },
    client: { exe: clientExe, exists: true, version: '4.1.10.27' },
    errors: [],
  };
}

/** @param {{payload?: Record<string, any>, fail?: boolean}} [options] */
function makeFetch(options = {}) {
  return async () => {
    if (options.fail) throw new Error('fetch failed');
    return new Response(
      JSON.stringify(
        options.payload ?? {
          startupState: 'ready',
          pid: 100,
          version: '4.1.10.27',
          integration: 'WeChatAgent-1',
          backend: 'wechat-hook',
          databaseAccounts: ['wxid_1'],
        },
      ),
      { status: 200 },
    );
  };
}

/** @param {ReturnType<typeof makeProbeStdout>} probe */
function makeRunCommand(probe) {
  return async () => ({ code: 0, stdout: JSON.stringify(probe), stderr: '', elapsedMs: 10, timedOut: false, aborted: false, commandLabel: 'probe' });
}

await testAsync('collectStatus composes a healthy report from injected deps', async () => {
  const settings = resolveSettings({ workspace: fixture.workspace });
  const report = await collectStatus(settings, {
    runCommand: makeRunCommand(makeProbeStdout(settings.clientExe)),
    fetchImpl: makeFetch(),
    probePort: async () => true,
  });
  assert.equal(report.ok, true);
  assert.deepEqual(report.checks, {
    workspace: true,
    client: true,
    dll: true,
    token: true,
    hook: true,
    processes: true,
    ports: true,
    services: true,
  });
  assert.equal(report.client.version, '4.1.10.27');
  assert.equal(report.desktop.version, '4.2.0.8');
  assert.equal(report.desktop.matchesExpected, false);
  assert.equal(report.hook.startupState, 'ready');
  assert.equal(report.processes.hookedCount, 1);
  assert.equal(report.processes.wechatAgentCount, 1);
  assert.ok(report.warnings.some((warning) => warning.includes('桌面微信版本 4.2.0.8')));
  assert.ok(report.summary.includes('✅ 正常'));
  assert.ok(report.summary.includes('⚠️'));
  assert.deepEqual(report.nextSteps, ['一切正常，无需操作。']);
  assert.equal(JSON.parse(JSON.stringify(report)).ok, true);
});

await testAsync('collectStatus reports a down hook and a running desktop client', async () => {
  const settings = resolveSettings({ workspace: fixture.workspace });
  const report = await collectStatus(settings, {
    runCommand: makeRunCommand(
      makeProbeStdout(settings.clientExe, {
        extraProcesses: [
          { name: 'Weixin.exe', pid: 300, executable: 'D:/微信/Weixin/Weixin.exe', commandLine: '"D:\\微信\\Weixin\\Weixin.exe" ' },
        ],
      }),
    ),
    fetchImpl: makeFetch({ fail: true }),
    probePort: async () => true,
  });
  assert.equal(report.ok, false);
  assert.equal(report.checks.hook, false);
  assert.equal(report.processes.desktopMainRunning, true);
  assert.ok(report.hook.error.includes('连不上'));
  assert.ok(report.nextSteps.some((step) => step.includes('wechat_deploy_restart')));
  assert.ok(report.nextSteps.some((step) => step.includes('退出')));
  assert.equal(formatStatusReport(report).includes('❌ 异常'), true);
});

await testAsync('collectStatus degrades cleanly when the probe fails', async () => {
  const settings = resolveSettings({ workspace: fixture.workspace });
  const report = await collectStatus(settings, {
    runCommand: async () => ({ code: 1, stdout: '', stderr: 'boom', elapsedMs: 5, timedOut: false, aborted: false, commandLabel: 'probe' }),
    fetchImpl: makeFetch(),
    probePort: async () => false,
  });
  assert.equal(report.ok, false);
  assert.match(report.probeError, /退出码 1/);
  assert.equal(report.processes.hookedCount, 0);
  assert.equal(report.ports.every((port) => port.listening === false), true);
});

// ---------------------------------------------------------------------------
// PowerShell helper
// ---------------------------------------------------------------------------

test('buildPowerShellArgs builds -File argv without a shell string', () => {
  const args = buildPowerShellArgs({ file: 'C:/ws/scripts/launch-hook-wechat.ps1', args: ['-PrepareOnly', 42] });
  assert.deepEqual(args.slice(0, 6), ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File']);
  assert.equal(args[6], 'C:/ws/scripts/launch-hook-wechat.ps1');
  assert.deepEqual(args.slice(7), ['-PrepareOnly', '42']);
  assert.equal(buildPowerShellArgs({ file: 'C:/a b/x.ps1' })[6], 'C:/a b/x.ps1');
  assert.throws(() => buildPowerShellArgs({}), /需要 file 或 command/);
});

test('buildPowerShellArgs encodes inline commands as UTF-16LE base64', () => {
  const command = 'Write-Output "微信"';
  const args = buildPowerShellArgs({ command });
  assert.equal(args[5], '-EncodedCommand');
  assert.equal(args[6], encodeCommand(command));
  assert.equal(Buffer.from(args[6], 'base64').toString('utf16le'), command);
});

test('tail keeps the last lines and reports truncation', () => {
  const text = Array.from({ length: 50 }, (_value, index) => `line ${index + 1}`).join('\n');
  const cut = tail(text, 3);
  assert.ok(cut.startsWith('…（输出已截断）'));
  assert.ok(cut.endsWith('line 50'));
  assert.equal(tail('one line', 10), 'one line');
  assert.equal(tail('', 10), '');
  assert.ok(tail('x'.repeat(50), 5, 10).length < 40);
});

test('decodeOutput prefers UTF-8 and falls back to GBK bytes', () => {
  assert.equal(decodeOutput(Buffer.from('微信 hook', 'utf8')), '微信 hook');
  // GBK for 中 is D6 D0, which is invalid UTF-8 -> decoder must fall back.
  assert.equal(decodeOutput(Buffer.from([0xd6, 0xd0])), '中');
});

test('cleanStream drops the CLIXML progress envelope', () => {
  const clixml =
    'real error line\n#< CLIXML\n<Objs Version="1.1.0.1"><Obj S="progress"><MS><PR><AV>busy</AV></PR></MS></Obj>' +
    '<S S="Error">boom_x000D__x000A_</S></Objs>';
  assert.equal(cleanStream(clixml), 'real error line\nboom');
  assert.equal(cleanStream('plain'), 'plain');
});

// ---------------------------------------------------------------------------
// action helpers
// ---------------------------------------------------------------------------

test('requireConfirm throws a Chinese confirm error', () => {
  assert.throws(
    () => requireConfirm({}, '准备 Hook 组件'),
    (error) => error instanceof ConfirmRequiredError && error.message.includes('confirm: true'),
  );
  assert.doesNotThrow(() => requireConfirm({ confirm: true }, '准备 Hook 组件'));
});

test('firstErrorLine picks the actionable line', () => {
  assert.equal(firstErrorLine('info\nHOOK_TOKEN_MISSING: set it\nmore'), 'HOOK_TOKEN_MISSING: set it');
  assert.equal(firstErrorLine('only info'), 'only info');
  assert.equal(firstErrorLine(''), '');
});

test('refusal keeps the action result shape for a failed preflight', () => {
  const result = refusal('准备 Hook 组件', new Error('匹配微信正在运行（pid 1）'));
  assert.equal(result.ok, false);
  assert.equal(result.executed, false);
  assert.equal(result.title, '准备 Hook 组件');
  assert.equal(result.reason, '匹配微信正在运行（pid 1）');
  const text = formatActionResult(result);
  assert.ok(text.startsWith('❌ 准备 Hook 组件失败'));
  assert.ok(text.includes('前置检查未通过'));
  assert.ok(text.includes('原因：'));
});

await testAsync('prepareHook refuses with a result instead of throwing', async () => {
  const settings = resolveSettings({ workspace: 'Z:/missing-workspace-for-refusal-test' });
  const result = await prepareHook(settings, { confirm: true });
  assert.equal(result.ok, false);
  assert.equal(result.executed, false);
  assert.match(result.reason, /工作区/);
  assert.match(formatActionResult(result), /未执行任何操作/);
});


test('hintFor maps known script failures to Chinese advice', () => {
  assert.match(hintFor('Close the matching WeChat before replacing its native component.'), /先从托盘/);
  assert.match(hintFor('HOOK_COMPONENT_UPDATE_PENDING: Exit the matching WeChat'), /version\.dll/);
  assert.match(hintFor('Upstream source differs from the reviewed commit.'), /源码/);
  assert.equal(hintFor('totally unknown failure'), '');
});

test('parseStopOutput reads the stopped pids', () => {
  assert.deepEqual(parseStopOutput('{"stopped":[1,2],"count":2}'), [1, 2]);
  assert.deepEqual(parseStopOutput('garbage'), []);
  assert.deepEqual(parseStopOutput(''), []);
});

test('formatActionResult renders success and failure shapes', () => {
  const okText = formatActionResult({
    ok: true,
    title: '准备 Hook 组件',
    elapsedMs: 1234,
    commandLabel: 'powershell.exe -File C:/ws/scripts/launch-hook-wechat.ps1',
    summary: '已写入。',
    tail: 'line1\nline2',
    nextSteps: ['调用 wechat_deploy_launch。'],
  });
  assert.ok(okText.startsWith('✅ 准备 Hook 组件完成（1.2s）'));
  assert.ok(okText.includes('命令：powershell.exe'));
  assert.ok(okText.includes('输出（末尾）：'));
  assert.ok(okText.includes('1. 调用 wechat_deploy_launch。'));

  const failText = formatActionResult({
    ok: false,
    title: '重启匹配微信',
    elapsedMs: 800,
    reason: 'HOOK_TOKEN_MISSING',
    hint: '令牌缺失：先执行 wechat_deploy_prepare。',
    tail: 'x',
  });
  assert.ok(failText.startsWith('❌ 重启匹配微信失败（800ms）'));
  assert.ok(failText.includes('原因：HOOK_TOKEN_MISSING'));
  assert.ok(failText.includes('建议：'));
  assert.equal(formatActionResult(null), '没有返回结果。');
});

// ---------------------------------------------------------------------------
// profile patch helpers
// ---------------------------------------------------------------------------

const SAMPLE_PATCH = [
  '# Your patch layer',
  '- id: ui-chat',
  '  config:',
  '    transcriptView: standard',
  '- id: agent-default-model',
  '  config:',
  '    model: deepseek-flash',
  '',
].join('\n');

test('buildManagedBlock produces a valid insert entry', () => {
  const block = buildManagedBlock({
    installDir: 'C:\\Users\\x\\.dsh\\dsh-wechat-deploy-plugin',
    workspace: 'D:/ws',
    hookUrl: 'http://127.0.0.1:30001',
    expectedVersion: '4.1.10.27',
  });
  assert.ok(block.startsWith('# >>> dsh-wechat-deploy (managed) >>>'));
  assert.ok(block.endsWith('# <<< dsh-wechat-deploy <<<'));
  assert.ok(block.includes('    - id: dsh-wechat-deploy'));
  assert.ok(block.includes('      name: "file:///C:/Users/x/.dsh/dsh-wechat-deploy-plugin/index.mjs"'));
  assert.ok(block.includes('        workspace: "D:/ws"'));
  assert.ok(block.includes('        expectedVersion: "4.1.10.27"'));
  assert.equal(fileUrl('D:\\a\\b'), 'file:///D:/a/b');
});

test('upsertManagedBlock is idempotent and preserves user entries', () => {
  const block = buildManagedBlock({ installDir: 'C:/p', workspace: 'D:/ws', hookUrl: 'h', expectedVersion: '4.1.10.27' });
  const once = upsertManagedBlock(SAMPLE_PATCH, block);
  assert.equal(once.replaced, false);
  assert.equal(countManagedBlocks(once.text), 1);
  assert.ok(once.text.includes('- id: ui-chat'));

  const twice = upsertManagedBlock(once.text, block);
  assert.equal(twice.replaced, true);
  assert.equal(countManagedBlocks(twice.text), 1);
  assert.equal(twice.text.trim(), once.text.trim());
});

test('stripManagedBlock removes the block and reports unterminated ones', () => {
  const block = buildManagedBlock({ installDir: 'C:/p', workspace: 'D:/ws', hookUrl: 'h', expectedVersion: '4.1.10.27' });
  const withBlock = upsertManagedBlock(SAMPLE_PATCH, block);
  const stripped = stripManagedBlock(withBlock.text);
  assert.equal(stripped.removed, 1);
  assert.equal(countManagedBlocks(stripped.text), 0);
  assert.ok(stripped.text.includes('- id: ui-chat'));
  assert.equal(stripManagedBlock(stripped.text).removed, 0);

  const broken = `- id: x\n${block.split('\n').slice(0, 4).join('\n')}\n- id: y`;
  const cut = stripManagedBlock(broken);
  assert.equal(cut.removed, 1);
  assert.equal(cut.unterminated, true);
  assert.ok(cut.text.includes('- id: x'));
});

// ---------------------------------------------------------------------------
// done
// ---------------------------------------------------------------------------

rmSync(ROOT, { recursive: true, force: true });
console.log(`\n${passed} passed${failed > 0 ? `, ${failed} failed` : ''}`);

