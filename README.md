# dsh-wechat-deploy-plugin

把本机微信 Hook（固定版本 **4.1.10.27**）的**检查、准备、启动、重启、构建**做成 DSH 可以用对话调用的宿主插件。
它不自己实现 Hook，也不改微信客户端逻辑：所有动作都调用 WeChat-Agent 工作区里已有的 PowerShell 脚本，并按
`docs/WECHAT_HOOK.md`、`docs/HOOK_STARTUP_RECOVERY.md`、`docs/EXIT_SHUTDOWN.md` 记录的流程执行。

- 只读工具（`wechat_deploy_status` / `wechat_deploy_health`）随时可以调用，不改任何东西。
- 写操作（prepare / launch / restart / build / services start|stop|restart）都必须显式传 `confirm: true`。
- 微信 persona 会话（`social-*`）里也能调用：插件会把自己的工具合并进 social bridge 的扩展工具策略槽，
  并只在 persona 会话注入一小段中文使用规则。

## 它做什么

| 能力 | 工具 | 说明 |
| --- | --- | --- |
| 完整体检 | `wechat_deploy_status` | 工作区、期望版本、桌面微信版本、匹配客户端与 `version.dll` 校验、Hook 健康、进程、端口、托管服务、`nextSteps` |
| 健康快查 | `wechat_deploy_health` | Hook `/WeChatAgent/health` JSON + 读取器端口 + `state/runtime.json` 服务存活 |
| 准备组件 | `wechat_deploy_prepare` | `launch-hook-wechat.ps1 -PrepareOnly`：写 `version.dll` 与本地令牌，**不启动** |
| 打开微信 | `wechat_deploy_launch` | `launch-hook-wechat.ps1`：准备并启动匹配客户端，等待 Hook ready |
| 重启微信 | `wechat_deploy_restart` | 只结束匹配客户端目录下的 `Weixin.exe`，再启动并等待 ready |
| 重新构建 | `wechat_deploy_build` | `build-hook.ps1`：重编 `state/hook/native/version.dll`（最长 15 分钟） |
| 托管服务 | `wechat_deploy_services` | `manage.ps1 -Action start\|stop\|restart\|status`（adapter / reader / bridge） |

### 状态报告内容

`wechat_deploy_status` 返回中文摘要 + 完整 JSON：

- 工作区路径、来源（config / env / default / home / dsh-home）与有效性；
- 期望版本（默认 `4.1.10.27`）、匹配客户端版本、桌面微信版本（从 `HKCU\Software\Tencent\Weixin` 的
  `InstallPath` 找到 `Weixin.exe` 读 FileVersion）；
- 匹配客户端目录、`Weixin.exe` 是否存在、`version.dll` 的 SHA256 与 `state/hook/native/build.json.sha256`
  的比对结果（`match` / `mismatch` / `missing` / `unknown`）；
- 令牌文件是否存在且为 64 位十六进制；
- Hook 健康：`startupState`、`pid`、`version`、`integration`、`backend`、`databaseAccounts`，或确切错误；
- 匹配客户端进程、其他 `Weixin.exe`（含主进程/辅助进程区分）、`WeChatAgent.exe` 进程；
- 读取器 / OneBot / 适配器 / DSH 插件端口连通性；
- `state/runtime.json` 托管服务的 pid 存活、可执行路径匹配、marker 是否存在；
- `ok` 总判定、`warnings` 与具体可执行的 `nextSteps`。

## 要求

- Windows + Node.js **>= 22**（使用全局 `fetch`、`AbortSignal.timeout`）。
- WeChat-Agent 工作区（含 `config/wechatagent.json`、`scripts/`、`state/hook/`）。
- 已按 `docs/WECHAT_HOOK.md` 准备好匹配的 `4.1.10.27` 客户端与构建产物。
- Windows PowerShell 5.1 可用（`powershell.exe` 在 PATH 里）；构建另需 Visual Studio C++ 生成工具。
- 插件以 DSH host 插件方式加载，装完要**重启 DeepSeek Harness**。

## 安装

```powershell
# 在本目录执行：复制到 <DSH_HOME>\dsh-wechat-deploy-plugin，并给每个 profile 写入托管 patch 块
node tools/install.mjs

# 只改 patch（假定文件已就位）
node tools/install.mjs --patch-only

# 自定义安装目录 / DSH_HOME / 只改一个 profile / 显式工作区
node tools/install.mjs --target D:\plugins\dsh-wechat-deploy --dsh-home C:\Users\me\.dsh --profile C:\Users\me\.dsh\profiles\desktop --workspace D:\...\workspace

# 卸载（只删托管块，插件文件保留；每个 profile 都有 .bak-<时间戳> 备份）
node tools/install.mjs --remove
```

托管块用两行标记围起来，重复安装只会替换、不会堆叠：

```yaml
# >>> dsh-wechat-deploy (managed) >>>
- insert:
    - id: dsh-wechat-deploy
      name: "file:///<DSH_HOME>/dsh-wechat-deploy-plugin/index.mjs"
      config:
        enabled: true
        promptEnabled: true
        workspace: ""
        hookUrl: "http://127.0.0.1:30001"
        expectedVersion: "4.1.10.27"
        powershell: "powershell.exe"
# <<< dsh-wechat-deploy <<<
```

`cordis.patch.yml` 是本仓库里的插入模板（手工合并时对照用），不会被自动应用。

## 配置项

配置来自 profile patch 的 `insert` 条目。除 `workspace` 外全部可选，不写就用 `config/wechatagent.json` 或内置默认值。

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | `false` 时完全不注册工具 |
| `promptEnabled` | `true` | 是否给 `social-*` 会话注入使用规则 |
| `workspace` | 自动检测 | 显式指定后**优先**，写错会报错而不是偷偷换一个 |
| `scriptsDir` | `<workspace>/scripts` | 脚本目录 |
| `configFile` | `<workspace>/config/wechatagent.json` | 读取 `hook.baseUrl` / `expectedVersion` / `wechatExecutable` / `ports` |
| `hookUrl` | `config.hook.baseUrl` 或 `http://127.0.0.1:30001` | Hook 基地址 |
| `expectedVersion` | `config.hook.expectedVersion` 或 `4.1.10.27` | 期望的客户端/Hook 版本 |
| `tokenFile` | `<workspace>/state/hook/native-token.txt` | 64 位十六进制令牌 |
| `nativeDir` | `<workspace>/state/hook/native` | `version.dll` + `build.json` |
| `clientDir` | 由 `hook.wechatExecutable` 推导 | 匹配客户端目录（`Weixin.exe` 所在） |
| `clientExe` | `<clientDir>/Weixin.exe` | 覆盖整个客户端路径 |
| `desktopWechatExe` | 空（读注册表） | 注册表读取失败时显式指定桌面微信路径 |
| `desktopRegistryKey` | `HKCU:\Software\Tencent\Weixin` | 桌面微信安装信息 |
| `powershell` | `powershell.exe` | 用哪个 PowerShell 执行脚本 |
| `timeouts` | 见下 | `healthMs` / `probeMs` / `prepareMs` / `launchMs` / `restartMs` / `buildMs`(900000) / `servicesMs` / `stopWaitMs` / `stopPollMs` |
| `promptText` | 内置中文规则 | 覆盖注入给 persona 的文本 |

工作区自动检测顺序：`workspace` 配置 → `WECHATAGENT_WORKSPACE` 环境变量 →
`` → `~/Documents/data/workspace` → `<DSH_HOME>/wechatagent`。

## 每个工具的参数

- `wechat_deploy_status`：无参数。
- `wechat_deploy_health`：无参数。
- `wechat_deploy_prepare` / `wechat_deploy_launch` / `wechat_deploy_restart` / `wechat_deploy_build`：
  `{ "confirm": true }`（必须显式传，否则一个动作都不会做）。
- `wechat_deploy_services`：`{ "action": "start" | "stop" | "restart" | "status", "confirm": true }`；
  `status` 只读，不需要 `confirm`。

## 安全说明（务必读）

- **restart 会真的关闭匹配微信**：它只结束可执行路径位于匹配客户端目录下的 `Weixin.exe`（不含桌面微信），
  然后重新启动；未完成的微信操作会中断，可能需要重新登录。
- **launch 会启动匹配微信**：如果客户端里的 `version.dll` 与构建清单不一致，脚本会先写 DLL，此时匹配微信必须
  已经完全退出；否则脚本会报 `HOOK_COMPONENT_UPDATE_PENDING`。
- **部署前先退出桌面微信**：本机桌面微信（`D:\微信\Weixin`，当前 4.2.0.8）与 Hook 客户端（4.1.10.27）是两套程序。
  只要还有其他 `Weixin.exe` 主进程在跑，`launch` / `restart` 会直接拒绝——工具**不会**结束桌面微信，请自己从托盘退出。
- **prepare 要求匹配微信已退出**：它要替换客户端目录里的 `version.dll` 并临时解锁/恢复该目录的 ACL。
- **不要并发执行部署动作**：一次只做一个（status/health 可以随时调）。
- **不会自动登录微信**：启动后仍需人工扫码/登录，再等待 Hook 与账号就绪。
- **版本不匹配不要硬改配置**：`expectedVersion` 只应跟随真实匹配的客户端与构建产物；文档明确要求版本失配需真实适配验证。
- **令牌是敏感信息**：`state/hook/native-token.txt` 与客户端里的 `wechatagent-hook.token` 不要贴到聊天或日志里。
  插件的日志只记录动作与结果，不记录令牌。
- **只读保证**：`wechat_deploy_status` / `wechat_deploy_health` 只做只读 PowerShell 探测、文件哈希、一次带令牌的
  `GET /WeChatAgent/health` 和四次 TCP 连接。

## 命令行体检

```powershell
node tools/status-cli.mjs            # 中文摘要 + JSON；健康时退出码 0，异常时 1，配置/执行错误 2
node tools/status-cli.mjs --json     # 只输出 JSON
node tools/status-cli.mjs --workspace D:\...\workspace
```

## 测试

```powershell
npm test        # = node test/unit.test.mjs，57 个离线用例
```

离线测试不跑 PowerShell、不联网、不动进程：用临时目录构造工作区夹具，用注入的 probe/fetch/端口探针跑完整
`collectStatus`，并覆盖版本/哈希比对、nextSteps 生成、PowerShell 参数拼装、CLI 输出格式、patch 托管块 round-trip。

安装器 round-trip 可用临时 DSH_HOME 验证（不会碰真实 profile）：

```powershell
$tmp = Join-Path $env:TEMP 'dsh-deploy-home-test'
New-Item -ItemType Directory -Force -Path "$tmp\profiles\desktop" | Out-Null
Set-Content "$tmp\profiles\desktop\cordis.patch.yml" "- id: ui-chat`n  config:`n    transcriptView: standard`n"
node tools/install.mjs --dsh-home $tmp --target "$tmp\installed-plugin"
node tools/install.mjs --remove --dsh-home $tmp
```

## 目录

```
index.mjs               host 插件入口：注册工具、social 策略合并、persona prompt 注入
src/settings.mjs        工作区检测与全部路径/版本/端口/超时解析
src/powershell.mjs      PowerShell spawn（-File / -EncodedCommand）、超时终止、输出解码与 tail
src/status.mjs          只读探测、Hook 健康、SHA256/版本判定、nextSteps、中文报告
src/actions.mjs         prepare / launch / restart / build / services 及 confirm 门禁
src/patch.mjs           profile patch 托管块的插入/替换/移除
src/log.mjs             ~/.dsh/wechat-deploy/wechat-deploy.log
tools/install.mjs       安装/卸载（每个 profile 备份）
tools/status-cli.mjs    只读体检 CLI
test/unit.test.mjs      离线单元测试
cordis.patch.yml        profile 插入模板
```

## 故障排查

| 现象 | 处理 |
| --- | --- |
| `wechat_deploy_status` 报工作区无效 | 检查 `workspace` 配置，或 `WECHATAGENT_WORKSPACE`；工作区需含 `config/wechatagent.json` 与 `state/` |
| `version.dll` 与 build.json 不一致 | 先退出匹配微信，再 `wechat_deploy_prepare`；构建清单过期则先 `wechat_deploy_build` |
| Hook 返回 401 | 重启匹配客户端刷新令牌（`wechat_deploy_restart`） |
| Hook 一直不是 `ready` | 看 `state/logs/hook-init.log`；`wechat_deploy_health` 复查；仍失败 `wechat_deploy_restart` |
| 端口 30001 被占用 | 先确认监听进程；本插件不会杀未知进程 |
| 托管服务异常 | `wechat_deploy_services action=restart`，日志在 `state/logs/shutdown.log` |
| 构建失败 | 确认 `components/WeChat-Hook` 源码与受审 commit 一致、已装 VS C++ 生成工具 |

## 插件生态与配合使用

这套工具链拆成 4 个独立仓库，按「基础设施 → 语音能力 → 点歌 / 换音色」分层：

| 仓库 | 作用 | 什么时候需要 |
|---|---|---|
| [wechat-agent-bundle](https://github.com/banzhangdeerfenzhiyi/wechat-agent-bundle) | WeChatAgent 安装包（0.4.1，含已授权匹配微信 4.1.10.27 客户端）+ DSH 接入插件 + Hook 部署脚本/教程 | 微信侧接入 DSH 的基础设施（语音条、人格聊天） |
| [dsh-wechat-deploy-plugin](https://github.com/banzhangdeerfenzhiyi/dsh-wechat-deploy-plugin) | 在聊天里检查 / 准备 / 启动 / 重启微信 Hook | Hook 没就绪、版本不匹配、语音发不出去时先跑它 |
| [dsh-voicepack-plugin](https://github.com/banzhangdeerfenzhiyi/dsh-voicepack-plugin) | 15 个 Edge 音色 + 3 个 RVC 音色，用指定音色说微信语音条 | 想换音色 / 男声说话 |
| [dsh-qqmusic-plugin](https://github.com/banzhangdeerfenzhiyi/dsh-qqmusic-plugin) | QQ 音乐点歌 + AI 翻唱（默认 30 秒语音条） | 想听「她」唱歌 |
| [dsh-voicepack-plugin](https://github.com/banzhangdeerfenzhiyi/dsh-voicepack-plugin) | 指定音色说微信语音条 | 想换音色 / 男声说话 |
| **本仓库 dsh-wechat-deploy-plugin** | 微信 Hook 部署 / 体检工具 | Hook 或语音通道出问题时 |

### 配合使用示例（同一台机器）

1. 先按 [wechat-agent-bundle](https://github.com/banzhangdeerfenzhiyi/wechat-agent-bundle) 装好 WeChatAgent 与 DSH 接入插件，登录微信。
2. 用 [dsh-wechat-deploy-plugin](https://github.com/banzhangdeerfenzhiyi/dsh-wechat-deploy-plugin) 的 `wechat_deploy_status` 确认 Hook `ready` —— 语音条通道就绪。
3. 在微信里：
   - 「唱首稻香」→ 本插件渲染翻唱并发出语音条；
   - 「用男声说晚安」→ [dsh-voicepack-plugin](https://github.com/banzhangdeerfenzhiyi/dsh-voicepack-plugin) 用指定音色发声；
   - 「检查一下微信部署」→ [dsh-wechat-deploy-plugin](https://github.com/banzhangdeerfenzhiyi/dsh-wechat-deploy-plugin) 体检 Hook。
4. 三个插件共用同一条「Edge TTS / RVC → SILK → 本机 hook」语音通道，**互不替换**：
   原有 `dsh-wechatagent-voice-plugin` 的 `send_voice` 继续用默认音色说话，本插件负责「唱歌」，
   语音包负责「换音色」。

