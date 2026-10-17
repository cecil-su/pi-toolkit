# pi-toolkit

最小 Pi package：用自定义 footer 显示当前模型、剩余上下文、Git 分支，以及当前 Codex 账户额度或 DeepSeek API 余额。MIT，无第三方运行时依赖，不复制或加载其它状态栏插件实现。

## 安装与使用

需要 Pi 1.3.0 的官方 runtime API、Node.js ≥22.19（独立 Pi 可执行文件使用自身运行时）。在需要使用的项目目录中从 GitHub 安装：

```sh
pi install --local git:github.com/cecil-su/pi-toolkit
```

也可以安装本地源码目录，将路径替换为实际克隆位置：

```sh
pi install --local /path/to/pi-toolkit
```

安装命令会修改该项目的 Pi package 声明；本包本身不写配置。进入交互 TUI 后自动生效，`/reload` 重新加载。JSON、RPC、print 模式不创建 footer、timer 或额度请求。

已有扩展若也调用 `setFooter()`，两者会竞争，最后设置者生效。本包不解析其它扩展的状态文本、不修改它们的配置，也不恢复或停用其它插件。自己的 footer 被替换时会停止资源，退出/重载时恢复内置 footer（仅当本包仍持有 footer）。

### 隔离试用

不要用真实凭据做测试；先使用全新 agent 目录，并清除当前进程的 `DEEPSEEK_API_KEY`。以下是 Git Bash/POSIX 示例，目录须改为专用的空目录；不更改全局 Pi 配置，也不加载现有扩展：

```sh
env -u DEEPSEEK_API_KEY PI_CODING_AGENT_DIR=/path/to/empty-agent \
  pi --offline --no-session --no-extensions --no-skills --no-prompt-templates \
  --no-themes --no-context-files --no-mcp -e /path/to/pi-toolkit
```

只查看 UI，不输入模型请求或登录真实账户。没有凭据时额度显示 unavailable。`--offline` 只控制 Pi 自身自动联网，并不是扩展 HTTP 的全局防火墙；本包测试通过 mock 注入拦截 HTTP，不依赖该参数阻止请求。

## 显示

普通宽度按两组分行，宽屏合为一行；更窄时按完整字段/额度窗口换行：

```text
GPT Display Name | high | ctx 80%/500k | branch: main
5h [██████▎   ] 63% ~4h8m | 7d [████      ] 40% ~4d15h
```

DeepSeek 第二组示例：

```text
balance CNY 110.00100 | USD 20.00000001
```

- 模型显示名称取自当前 runtime 的 `ctx.model.name`，不维护模型名称表。其后独立显示 `ctx.thinkingLevel`（如 `high` / `off`），思考程度切换事件立即重绘；长模型名省略不影响该字段，未知显示 `?`。
- `ctx` 百分比仍表示剩余比例，即 `100 - ctx.getContextUsage().percent`，不是已用比例；格式为 `ctx 100%/500k`，压缩中、压缩后尚无估计或缺失数据为 `ctx ?/500k`（窗口也未知时为 `ctx ?/?`）。`/` 后显示上下文窗口总长度，优先取 `getContextUsage().contextWindow`，未知时回退当前 `model.contextWindow`，都未知为 `?`。总长度按十进制 k/M 紧凑显示、最多两位小数，例如 `272k`、`500k`、`1.05M`；压缩后百分比未知时仍保留已知窗口。此项是 runtime 上下文窗口估计，不扣除额外保留 token，也不是账户额度。
- 分支使用官方只读 footer data provider；非 Git 目录或空白/无有效分支值时隐藏整个 branch 字段及其分隔符。有值显示 `branch: NAME`，detached HEAD 按宿主返回值显示。不执行 Git 写操作。
- Codex 使用响应根部 `rate_limit` 中实际时长为 18000/604800 秒的**账户**窗口。不是当前模型专属额度；`additional_rate_limits` 的 opaque feature 不被猜测、合并或替换为模型 ID。特殊模型还可能有本包不显示的独立限制。
- bar 与百分比使用同一个剩余值；bar 每格分 8 级，四舍五入到最近 1/8 格，默认 10 格、窄屏最低 2 格。整段 bar 体使用统一暗色背景轨道和亮色填充，空余区用空格，部分格右侧也显示同一轨道，不使用 `░`；上方纯文本示例无法展示底色。背景只覆盖括号内的 bar 体，0% 仍有完整轨道，100% 填满；换行保留空格并恢复/重置样式，不给括号或整行铺底。每次渲染读取当前主题，使用官方 Theme/style 和颜色 API 适配浅色/深色及 truecolor/ANSI256，不缓存带旧主题颜色的字符串。百分比最多两位小数，极小/极大非端点值用 `<0.01%` / `>99.99%`，避免四舍五入伪装成 0/100。
- 倒计时根据服务端绝对 `reset_at`，按分钟/小时向下取整，少于一分钟为 `~<1m`，缺失为 `~?`。到期为 `reset due`，立即隐藏旧百分比和 bar，不自行填充为满额。
- DeepSeek 只显示官方 `total_balance`，每个返回的 CNY/USD 分别显示；原始十进制字符串不转浮点、不相加、不换汇。不显示百分比、bar 或重置时间；余额本身不保证 API 请求一定可用。
- ready Codex 结果只显示实际返回的 5h/7d 窗口，缺失窗口不展示；返回窗口为 0% 时仍显示。没有可解析的受支持窗口会令整次查询失败，整体 loading/unavailable/stale 仍明确显示；失败不保留旧成功值，不把错误当作无限额，也不用 0 或满额代替。其它 provider 只显示第一组。
- Unicode 宽度使用宿主 TUI 工具测量；超长模型名称/分支会省略。一个字段本身超过终端宽度时才在字段内部换行；极窄到无法容纳单个宽字符时会裁掉该字符以防溢出，金额数字不做四舍五入。终端字体须支持 Unicode block glyph。

## 数据、安全与生命周期

只在交互 TUI 当前 provider 为 `openai-codex` 或 `deepseek` 时查询：

| Provider | 唯一只读 GET 地址 | 认证 |
|---|---|---|
| Codex | `https://chatgpt.com/backend-api/wham/usage` | 当前 runtime OAuth bearer，JWT 内对应的账户 header |
| DeepSeek | `https://api.deepseek.com/user/balance` | 当前 runtime API key bearer |

Codex 的 ChatGPT backend 接口**不是稳定的公开 API**，可能变更或被拒绝访问。DeepSeek balance 是公开官方 API。账户字段若由响应返回，必须与请求账户匹配。没有 Codex OAuth、过期/无法识别的 token 或仅有 API key 时不查询 Codex 额度；不回退到 Codex CLI、浏览器或其它账户。

认证使用官方 `modelRegistry.getApiKeyAndHeaders(model)` / `isUsingOAuth(model)`。代码不读取 auth.json、session、数据库或其它私有文件，不保存 secret、账户 ID、HTTP payload 或认证错误文本到磁盘/日志。正常 OAuth 刷新由 Pi 管理，宿主可能更新自己的凭据。配置的凭据命令也由 Pi runtime 处理。

发送前同时检查模型和 runtime 认证覆盖的官方 endpoint，拒绝 proxy/custom origin、URL 用户名密码、非官方路径、query/fragment，以及有歧义的认证 header。仅接受 Codex 官方根路径、`/backend-api`、`/backend-api/codex`，或 DeepSeek 根路径、`/v1`（可有末尾斜杠）。不转发任意配置 header，只构造必要认证 header。HTTP 拒绝重定向、8 秒超时、AbortSignal 取消，响应最多 64 KiB（包括流式累计上限）；异常只呈现 unavailable，不输出秘密或账户标识。

- 每秒只做轻量调度和倒计时重绘；正常每 10 秒重新解析当前 runtime 认证，模型选择、输入/运行边界会提前校验。同一身份校验不切换成 loading。
- 身份验证租期最长 15 秒且不超过 JWT 到期时间；认证阻塞超过租期即隐藏额度。Pi 没有通用账户切换通知，静默账户替换在下一次校验前可能有最长约 10 秒的观察延迟，不能保证即时感知外部凭据变化。
- 每个当前 scope 正常最多每分钟 GET 一次；会话/模型切换会重新建立 scope。请求返回后再次校验当前 runtime 身份才接纳结果。失败、账号/provider/模型切换会丢弃旧结果；不会从其它账户/模型缓存取值。
- 缓存只有一个进程内 slot，以 provider、model、endpoint 与带随机进程盐的凭据摘要隔离；有效数据最多 90 秒，不落盘。token 刷新也会保守地换 scope。
- 模型/会话切换、组件替换、重载和退出会清理 timer、branch 订阅和在途请求；迟到结果不能恢复失效状态。官方兼容认证 API 没有取消参数，底层 Pi 认证刷新本身不能由本包强行终止，但本包对它的等待有超时/取消，迟到返回会被忽略。

## 开发与验证

```sh
npm install --ignore-scripts --legacy-peer-deps
npm run check
npm test
npm pack --dry-run --ignore-scripts
```

所有 HTTP/认证/账号切换测试使用合成数据和 mock，不调用真实账户接口或模型，也不开服务。覆盖渲染与 Unicode 宽度、bar 边界、统一背景与空格、真实 Pi dark/light Theme 下的最终 footer 组合、ANSI256、主题切换、窄屏样式恢复/重置和信息保留、ctx unknown/compaction 与窗口总长度优先/回退、thinking 事件重绘、空分支与缺失窗口隐藏及分隔符、倒计时、账户根窗口与无关专属桶、币种精度、超时/取消/超大/错误/重定向、scope 切换和生命周期清理。真实账户、真实终端字体与远端 backend 兼容性需另行验证；测试通过不代表业务验收。

`@earendil-works/pi-coding-agent`、`pi-ai`、`pi-tui`（均为 `@earendil-works` scope）与 `typebox` 仅以 `peerDependencies: "*"` 声明；本地 devDependencies 固定宿主 1.3.0 供类型检查，不包含在发布文件中。Pi 通过自己的 loader 提供宿主模块，本包不打包宿主或其它 Pi package。没有依赖其它状态栏/usage package，因此没有额外插件自动加载或格式化状态协议耦合。

### 权威参考

- [Pi packages](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md)、[Extensions](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)、[TUI](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/tui.md)；实现以安装版 1.3.0 声明为准。
- [DeepSeek Get User Balance](https://api-docs.deepseek.com/api/get-user-balance)
- [OpenAI Codex backend client](https://github.com/openai/codex/blob/main/codex-rs/backend-client/src/client.rs)、[账户额度 fixture](https://github.com/openai/codex/blob/main/codex-rs/app-server/tests/suite/v2/rate_limits.rs)
