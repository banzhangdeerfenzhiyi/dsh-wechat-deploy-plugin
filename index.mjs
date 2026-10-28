/**
 * dsh-wechat-deploy — deploy/repair tools for the local WeChat hook.
 *
 * Registers seven host tools that wrap the WeChat-Agent workspace scripts for the
 * pinned client version (4.1.10.27):
 *
 *   wechat_deploy_status    read-only full diagnostic report
 *   wechat_deploy_health    read-only hook + reader + service health
 *   wechat_deploy_prepare   DLL + token into the pinned client (no launch)
 *   wechat_deploy_launch    open the pinned client and wait for the hook
 *   wechat_deploy_restart   stop only the pinned client, then launch
 *   wechat_deploy_build     rebuild the native hook DLL (15 min cap)
 *   wechat_deploy_services  start|stop|restart|status the managed services
 *
 * Write actions require `confirm: true`. Host scope only, no client half;
 * configuration comes from the profile's cordis.patch.yml insert entry.
 *
 * WeChat persona sessions get their tool surface filtered by the social bridge,
 * so the definitions are also merged into the bridge's extension-policy slot on
 * `agent/pre-step` and `system-prompt/assemble` (same slot send_voice uses), and
 * a short Chinese rule block is injected only for `social-*` sessions.
 */
import { createLogger, messageOf } from './src/log.mjs';
import { formatActionResult, buildHook, launchHook, manageServices, prepareHook, restartHook } from './src/actions.mjs';
import { collectHealth, collectStatus, formatHealthReport, formatStatusReport } from './src/status.mjs';
import { resolveSettings } from './src/settings.mjs';

/** Cordis plugin name. */
export const name = 'dsh-wechat-deploy';

/** Keep the plugin pending until the tool registry is mounted. */
export const inject = ['tools'];

const TOOL_STATUS = 'wechat_deploy_status';
const TOOL_HEALTH = 'wechat_deploy_health';
const TOOL_PREPARE = 'wechat_deploy_prepare';
const TOOL_LAUNCH = 'wechat_deploy_launch';
const TOOL_RESTART = 'wechat_deploy_restart';
const TOOL_BUILD = 'wechat_deploy_build';
const TOOL_SERVICES = 'wechat_deploy_services';
const TOOL_NAMES = [TOOL_STATUS, TOOL_HEALTH, TOOL_PREPARE, TOOL_LAUNCH, TOOL_RESTART, TOOL_BUILD, TOOL_SERVICES];

const STATUS_DESCRIPTION =
  '微信 Hook 部署体检（只读，不改任何东西）：一次给出工作区、期望版本、桌面微信版本与安装路径、匹配客户端与 version.dll 的 SHA256 校验、' +
  'Hook 健康（startupState/pid/version/integration/backend/databaseAccounts）、Weixin/WeChatAgent 进程、端口与 state/runtime.json 托管服务，' +
  '并附中文 nextSteps。排查微信“没反应/不能发消息/版本不对”时先调它。';

const HEALTH_DESCRIPTION =
  '微信 Hook 健康快查（只读）：返回 /WeChatAgent/health 的 JSON、读取器端口连通性、托管服务存活情况。' +
  '部署后确认或想先轻量探一下时用；完整诊断用 wechat_deploy_status。';

const PREPARE_DESCRIPTION =
  '准备匹配客户端（需要 confirm: true）：运行 scripts/launch-hook-wechat.ps1 -PrepareOnly，把校验过的 version.dll 与本地令牌写入匹配客户端目录，' +
  '不会启动微信。要求匹配微信已完全退出；会临时解锁再恢复客户端目录的写保护 ACL。';

const LAUNCH_DESCRIPTION =
  '打开匹配微信（需要 confirm: true）：运行 scripts/launch-hook-wechat.ps1，先准备 DLL/令牌再启动匹配客户端，等待 Hook 就绪并返回健康结论。' +
  '要求桌面上没有其他微信在运行（工具不会结束它们）；不会自动登录，需要人工在微信里登录。';

const RESTART_DESCRIPTION =
  '重启匹配微信（需要 confirm: true）：只结束可执行路径在匹配客户端目录下的 Weixin.exe（绝不结束桌面微信），然后重新启动并等待 Hook 就绪。' +
  '桌面微信正在运行时会直接拒绝，避免启动阶段失败。';

const BUILD_DESCRIPTION =
  '重新构建原生 Hook（需要 confirm: true，最长 15 分钟）：运行 scripts/build-hook.ps1，产物写入 state/hook/native/version.dll 与 build.json。' +
  '构建后还要 prepare + launch 才生效；要求 components/WeChat-Hook 源码与 VS C++ 生成工具。';

const SERVICES_DESCRIPTION =
  '启停 WeChatAgent 托管服务（adapter/reader/bridge，内部调用 scripts/manage.ps1）：action=start|stop|restart|status。' +
  'status 只读；start/stop/restart 需要 confirm: true。';

const CONFIRM_PROPERTY = {
  type: 'boolean',
  description: '必须传 true 才会执行；不传或 false 时不做任何操作。',
};

const EMPTY_PARAMETERS = {
  type: 'object',
  properties: {},
  additionalProperties: false,
};

const CONFIRM_PARAMETERS = {
  type: 'object',
  properties: { confirm: CONFIRM_PROPERTY },
  required: ['confirm'],
  additionalProperties: false,
};

const SERVICES_PARAMETERS = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['start', 'stop', 'restart', 'status'],
      description: 'status=只读查状态；start/stop/restart 需要 confirm: true。',
    },
    confirm: CONFIRM_PROPERTY,
  },
  required: ['action'],
  additionalProperties: false,
};

/**
 * Mount the plugin.
 *
 * @param {object} ctx - Cordis host context.
 * @param {Record<string, unknown>} [config] - Patch configuration.
 */
export function apply(ctx, config = {}) {
  let settings;
  try {
    settings = resolveSettings(config);
  } catch (error) {
    createLogger()(`apply: settings failed ${messageOf(error)}`);
    throw error;
  }
  const log = createLogger();
  log(
    `apply: enabled=${settings.enabled} workspace=${settings.workspace} (${settings.workspaceSource}) ` +
      `expected=${settings.expectedVersion} hook=${settings.hookUrl} client=${settings.clientDir}`,
  );
  if (!settings.workspaceValid) log(`apply: workspace invalid (${settings.workspace}); tools will report it`);
  if (!settings.enabled) {
    log('apply: disabled by config, nothing registered');
    return;
  }

  const tools = ctx.get?.('tools') ?? ctx.tools;
  if (!tools || typeof tools.register !== 'function') {
    log('apply: tools service unavailable, nothing registered');
    return;
  }

  const definitions = buildDefinitions(settings, log);
  const registerAll = () => {
    const disposers = definitions.map((definition) => tools.register(definition));
    log(`apply: registered ${TOOL_NAMES.join(', ')}`);
    return () => {
      for (const dispose of disposers.reverse()) {
        try {
          dispose?.();
        } catch {
          /* disposal must not throw during reload */
        }
      }
    };
  };
  if (typeof ctx.effect === 'function') ctx.effect(registerAll);
  else registerAll();

  if (typeof ctx.on !== 'function') return;

  // The social bridge filters the persona-chat tool surface in its own
  // `system-prompt/assemble` hook. Attach (and merge into) the per-session
  // extension policy before awaiting next() so the filter sees our tools; the
  // send_voice and qqmusic plugins own the same slot, hence merge, not claim.
  ctx.on('agent/pre-step', async ({ agent }, next) => {
    try {
      const sessionId = sessionIdOf(agent);
      for (const target of [agent?.ctx, agent]) {
        attachExtensionPolicy(target, sessionId, log, 'pre-step');
        ensureScopedTools(target, definitions, log);
      }
    } catch {
      /* policy attachment must never break a turn */
    }
    return next();
  });

  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const sessionId = sessionIdOf(context?.agent) ?? sessionIdFromScope(context?.scope);
    try {
      for (const target of promptTargets(context, ctx)) {
        attachExtensionPolicy(target, sessionId, log, 'assemble');
        ensureScopedTools(target, definitions, log);
      }
    } catch {
      /* policy attachment must never break assembly */
    }
    const assembled = await next();
    try {
      if (settings.promptEnabled && inSocialSession(sessionId)) {
        assembled.sections?.push({ name: 'dsh-wechat-deploy:rules', text: settings.promptText });
      }
      const names = Array.isArray(assembled?.tools) ? assembled.tools.map((item) => item?.name) : [];
      log(`prompt: session=${sessionId ?? '?'} tools=${names.length} deploy=${names.includes(TOOL_STATUS)}`);
    } catch {
      /* a composition without sections just gets no rules */
    }
    return assembled;
  });
  log('apply: policy + prompt hooks attached');
}

/**
 * The tool table. Every execute returns `{detail}` and never throws: a failed
 * deploy is content the persona should relay, not a broken tool turn.
 *
 * @param {Record<string, any>} settings
 * @param {(line: string) => void} log
 * @returns {Array<Record<string, any>>}
 */
function buildDefinitions(settings, log) {
  return [
    {
      name: TOOL_STATUS,
      description: STATUS_DESCRIPTION,
      parameters: structuredClone(EMPTY_PARAMETERS),
      output: textOutput(),
      execute: async (_args, exec) => ({
        detail: await diagnostic(log, 'status', async () => {
          const report = await collectStatus(settings, signalOf(exec));
          log(`status: ok=${report.ok} hook=${report.hook.startupState || report.hook.error} steps=${report.nextSteps.length}`);
          return formatStatusReport(report);
        }),
      }),
    },
    {
      name: TOOL_HEALTH,
      description: HEALTH_DESCRIPTION,
      parameters: structuredClone(EMPTY_PARAMETERS),
      output: textOutput(),
      execute: async (_args, exec) => ({
        detail: await diagnostic(log, 'health', async () => {
          const report = await collectHealth(settings, signalOf(exec));
          log(`health: ok=${report.ok} hook=${report.hook.startupState || report.hook.error}`);
          return formatHealthReport(report);
        }),
      }),
    },
    {
      name: TOOL_PREPARE,
      description: PREPARE_DESCRIPTION,
      parameters: structuredClone(CONFIRM_PARAMETERS),
      output: textOutput(),
      execute: async (args, exec) => ({
        detail: await actionDetail(log, TOOL_PREPARE, () => prepareHook(settings, args, signalOf(exec))),
      }),
    },
    {
      name: TOOL_LAUNCH,
      description: LAUNCH_DESCRIPTION,
      parameters: structuredClone(CONFIRM_PARAMETERS),
      output: textOutput(),
      execute: async (args, exec) => ({
        detail: await actionDetail(log, TOOL_LAUNCH, () => launchHook(settings, args, signalOf(exec))),
      }),
    },
    {
      name: TOOL_RESTART,
      description: RESTART_DESCRIPTION,
      parameters: structuredClone(CONFIRM_PARAMETERS),
      output: textOutput(),
      execute: async (args, exec) => ({
        detail: await actionDetail(log, TOOL_RESTART, () => restartHook(settings, args, signalOf(exec))),
      }),
    },
    {
      name: TOOL_BUILD,
      description: BUILD_DESCRIPTION,
      parameters: structuredClone(CONFIRM_PARAMETERS),
      output: textOutput(),
      execute: async (args, exec) => ({
        detail: await actionDetail(log, TOOL_BUILD, () => buildHook(settings, args, signalOf(exec))),
      }),
    },
    {
      name: TOOL_SERVICES,
      description: SERVICES_DESCRIPTION,
      parameters: structuredClone(SERVICES_PARAMETERS),
      output: textOutput(),
      execute: async (args, exec) => ({
        detail: await actionDetail(log, TOOL_SERVICES, () => manageServices(settings, args, signalOf(exec))),
      }),
    },
  ];
}

/**
 * Run one write action and render its result.
 *
 * @param {(line: string) => void} log
 * @param {string} tool
 * @param {() => Promise<Record<string, any>>} body
 * @returns {Promise<string>}
 */
async function actionDetail(log, tool, body) {
  try {
    const result = await body();
    log(`${tool}: ok=${result.ok} elapsed=${result.elapsedMs}ms`);
    return formatActionResult(result);
  } catch (error) {
    log(`${tool}: refused/failed ${messageOf(error)}`);
    return `❌ ${tool} 未执行：${messageOf(error)}`;
  }
}

/**
 * Run one read-only diagnostic and render it.
 *
 * @param {(line: string) => void} log
 * @param {string} tool
 * @param {() => Promise<string>} body
 * @returns {Promise<string>}
 */
async function diagnostic(log, tool, body) {
  try {
    return await body();
  } catch (error) {
    log(`${tool}: failed ${messageOf(error)}`);
    return `❌ ${tool} 体检失败：${messageOf(error)}`;
  }
}

/** @returns {{schema: object, render: (args: unknown, value: any) => Array<{type: string, text: string}>}} */
function textOutput() {
  return {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: { detail: { type: 'string' } },
      required: ['detail'],
    },
    render: (_args, value) => [{ type: 'text', text: String(value?.detail ?? '') }],
  };
}

/**
 * @param {{signal?: AbortSignal}|undefined} exec
 * @returns {{signal?: AbortSignal}}
 */
function signalOf(exec) {
  return exec?.signal === undefined ? {} : { signal: exec.signal };
}

/** The generic host extension slot the social bridge reads. */
const EXTENSION_POLICY = Symbol.for('wechatagent.extension-tools.v1');

/** Marks the scoped registration so one agent scope registers only once. */
const SCOPED_TOOLS = Symbol.for('dsh.wechat-deploy.scoped-tools.v1');

/** Guards the policy merge so the slot is only wrapped once. */
const POLICY_MERGED = Symbol.for('dsh.wechat-deploy.policy-merged.v1');

/**
 * Allow our tools inside one WeChatAgent chat's tool surface.
 *
 * send_voice and qqmusic own the same slot with their own tools; merge instead
 * of overwriting so none of the tool sets disappear.
 *
 * @param {unknown} scopeCtx
 * @param {string|undefined} sessionId
 * @param {(line: string) => void} log
 * @param {string} where
 * @returns {boolean}
 */
function attachExtensionPolicy(scopeCtx, sessionId, log, where) {
  if (typeof scopeCtx !== 'object' || scopeCtx === null) return false;
  if (!inSocialSession(sessionId)) return false;
  const ownDefinitions = () => policyDefinitions();
  const existing = scopeCtx[EXTENSION_POLICY];
  try {
    if (existing === undefined) {
      Object.defineProperty(scopeCtx, EXTENSION_POLICY, {
        configurable: true,
        value: {
          names: () => [...TOOL_NAMES],
          check: (toolName) => TOOL_NAMES.includes(toolName),
          definitions: ownDefinitions,
        },
      });
    } else if (typeof existing === 'object' && existing !== null && existing[POLICY_MERGED] !== true) {
      const previousNames = existing.names?.bind(existing);
      const previousCheck = existing.check?.bind(existing);
      const previousDefinitions = existing.definitions?.bind(existing);
      existing.names = () => [...new Set([...(previousNames?.() ?? []), ...TOOL_NAMES])];
      existing.check = (toolName) => TOOL_NAMES.includes(toolName) || Boolean(previousCheck?.(toolName));
      existing.definitions = () => [...(previousDefinitions?.() ?? []), ...ownDefinitions()];
      Object.defineProperty(existing, POLICY_MERGED, { configurable: true, value: true });
    } else {
      return false;
    }
  } catch {
    return false;
  }
  log(`policy: deploy tools allowed (${where}) session=${sessionId}`);
  return true;
}

/**
 * Register our tools on one agent scope's own registry, once.
 *
 * @param {unknown} scopeCtx
 * @param {Array<Record<string, any>>} definitions
 * @param {(line: string) => void} log
 */
function ensureScopedTools(scopeCtx, definitions, log) {
  if (typeof scopeCtx !== 'object' || scopeCtx === null) return;
  if (scopeCtx[SCOPED_TOOLS] !== undefined) return;
  const tools = scopeCtx.tools ?? scopeCtx.get?.('tools');
  if (!tools || typeof tools.register !== 'function') return;
  try {
    const disposers = definitions.map((definition) => tools.register(definition));
    Object.defineProperty(scopeCtx, SCOPED_TOOLS, { configurable: true, value: disposers });
    log('scoped: deploy tools registered on agent tool registry');
  } catch {
    /* scoped registration is best-effort */
  }
}

/**
 * Tool definitions without `execute`, for the extension-policy slot.
 *
 * @returns {Array<{name: string, description: string, parameters: object}>}
 */
function policyDefinitions() {
  return [
    { name: TOOL_STATUS, description: STATUS_DESCRIPTION, parameters: structuredClone(EMPTY_PARAMETERS) },
    { name: TOOL_HEALTH, description: HEALTH_DESCRIPTION, parameters: structuredClone(EMPTY_PARAMETERS) },
    { name: TOOL_PREPARE, description: PREPARE_DESCRIPTION, parameters: structuredClone(CONFIRM_PARAMETERS) },
    { name: TOOL_LAUNCH, description: LAUNCH_DESCRIPTION, parameters: structuredClone(CONFIRM_PARAMETERS) },
    { name: TOOL_RESTART, description: RESTART_DESCRIPTION, parameters: structuredClone(CONFIRM_PARAMETERS) },
    { name: TOOL_BUILD, description: BUILD_DESCRIPTION, parameters: structuredClone(CONFIRM_PARAMETERS) },
    { name: TOOL_SERVICES, description: SERVICES_DESCRIPTION, parameters: structuredClone(SERVICES_PARAMETERS) },
  ];
}

/**
 * Every object that might carry the policy slot for this assembly.
 *
 * @param {object} context
 * @param {object} ctx
 * @returns {unknown[]}
 */
function promptTargets(context, ctx) {
  const targets = [];
  const push = (value) => {
    if (value && typeof value === 'object' && !targets.includes(value)) targets.push(value);
  };
  push(context?.scope?.ctx);
  push(context?.scope);
  push(context?.agent?.ctx);
  push(context?.agent);
  push(ctx);
  push(ctx?.root);
  push(ctx?.scope);
  return targets;
}

/**
 * The deploy tools belong to WeChat persona chats only.
 *
 * @param {string|undefined} sessionId
 * @returns {boolean}
 */
function inSocialSession(sessionId) {
  return typeof sessionId === 'string' && sessionId.startsWith('social-');
}

/** @param {unknown} agent @returns {string|undefined} */
function sessionIdOf(agent) {
  if (typeof agent !== 'object' || agent === null) return undefined;
  const candidate = agent.session?.id;
  return typeof candidate === 'string' ? candidate : undefined;
}

/** @param {unknown} scope @returns {string|undefined} */
function sessionIdFromScope(scope) {
  if (typeof scope !== 'object' || scope === null) return undefined;
  const candidate = scope.session?.id ?? scope.id;
  return typeof candidate === 'string' ? candidate : undefined;
}

export { resolveSettings };
