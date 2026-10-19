# pi-toolkit

Pi package：用自定义 footer 显示当前模型、思考程度、剩余上下文、当前 Codex 账户额度或 DeepSeek API 余额，以及末尾的 Git 分支；提供原创 `/fast` 切换已验证支持的 Codex Fast 请求策略。MIT，无第三方运行时依赖，不复制或加载其它状态栏插件实现。

## 安装与使用

需要 Pi 1.3.0 的官方 runtime API、Node.js ≥22.19（独立 Pi 可执行文件使用自身运行时）。在需要使用的项目目录中从 GitHub 安装：

```sh
pi install --local git:github.com/cecil-su/pi-toolkit
```

也可以安装本地源码目录，将路径替换为实际克隆位置：

```sh
pi install --local /path/to/pi-toolkit
```

安装命令会修改该项目的 Pi package 声明；本包不修改 Pi 加载配置，仅由 `/fast` 保存本包的 `pi-toolkit.json` 偏好。进入交互 TUI 后自动生效，`/reload` 重新加载。JSON、RPC、print 模式不创建 footer、timer 或额度请求；也不读取 Fast 偏好、不查 Fast 目录、不执行 Fast 切换或改写请求。Fast 不覆盖其它插件的 RPC/非交互能力。

已有扩展若也调用 `setFooter()`，两者会竞争，最后设置者生效。本包不解析其它扩展的状态文本、不修改它们的配置，也不恢复或停用其它插件。自己的 footer 被替换时会停止 footer/额度资源；Fast 策略独立存续至退出/重载，不随 footer 替换停止，其额外轮询仅在偏好开启时运行。退出/重载时恢复内置 footer（仅当本包仍持有 footer）。

### 隔离试用

不要用真实凭据做测试；先使用全新 agent 目录，并清除当前进程的 `DEEPSEEK_API_KEY`。以下是 Git Bash/POSIX 示例，目录须改为专用的空目录；不更改全局 Pi 配置，也不加载现有扩展：

```sh
env -u DEEPSEEK_API_KEY PI_CODING_AGENT_DIR=/path/to/empty-agent \
  pi --offline --no-session --no-extensions --no-skills --no-prompt-templates \
  --no-themes --no-context-files --no-mcp -e /path/to/pi-toolkit
```

只查看 UI，不输入模型请求或登录真实账户。没有凭据时额度显示 unavailable。`--offline` 只控制 Pi 自身自动联网，并不是扩展 HTTP 的全局防火墙；本包测试通过 mock 注入拦截 HTTP，不依赖该参数阻止请求。

## Codex Fast（仅交互 TUI）

`/fast` 不带参数，切换 Fast 偏好，默认 **off**。开启前会明确提示：**Fast 会消耗更多计划额度**。只有命令触发开启，或恢复本包已保存的开启偏好，才允许验证后的 priority 请求；不更改模型或 thinking，不提供 `/usage` 菜单或额度重置。

旧 pi-usage 也注册 `/fast`，同时加载会有同名命令及请求策略冲突，不能假定命令由本包处理。请使用上面的空 agent 目录和 `--no-extensions -e` 隔离试用；正式使用由用户明确选择加载范围。本包不会卸载、停用其它插件，也不迁移它们的设置。

偏好路径为官方 `getAgentDir()` 下的 `pi-toolkit.json`，内容仅为：

```json
{ "fast": false }
```

不读取 pi-usage 偏好或真实凭据文件。先验证能力、保存成功，再改变开启状态；保存失败保持原状态（关闭保存失败也仍为原开启状态，并提示错误）。仅接受有且只有一个布尔 `fast` 字段的文件，读取最多 1 KiB；损坏、额外字段、非普通文件或可见的并发变更会拒绝保存，不自动覆盖/修复。新建文件独占发布，已有有效文件通过临时文件原子替换。修复本包偏好文件后 `/reload`；没有额外用户配置。偏好在 Session 启动时读取，其它存量 Session 不即时同步开关。

生效条件：当前 TUI 模型的 provider 为 `openai-codex`、API 为 `openai-codex-responses`，模型与 runtime 认证目标均为允许的官方 endpoint，并且当前 runtime OAuth 身份的目录中，精确匹配 `models[].slug` 的模型明确包含 `service_tiers[].id: "priority"`，或兼容的 `additional_speed_tiers: ["fast"]`。不硬编码模型型号，不把缺失、未知或错误字段视为支持。

固定只读目录地址：`https://chatgpt.com/backend-api/codex/models?client_version=<Pi VERSION>`（开发/验证宿主为 1.3.0）。只发送当前 runtime Codex OAuth bearer 与对应账户 header，不使用 Codex CLI、其它账号、第三方格式化状态文本或静态内置目录作为能力证明。目录前后重验身份，同账户/模型能力缓存最长 5 分钟；开启时正常每 10 秒校验身份，身份租期 15 秒且不超过 token 到期时间。目录失败、过期、账号/模型切换或迟到结果会安全降级，不保留失败后的旧支持结论；关闭时不建立额外 Fast 轮询。

请求策略使用正式 `registerProvider` 适配器，而不是仅含 payload 的 `before_provider_request` 事件来猜测身份。每次实际调用独立绑定已解析的模型、endpoint、bearer 和 headers；原 payload hook 先运行，随后仅在该请求快照精确匹配已验证能力时设置 `service_tier: "priority"`。关闭、能力未知、身份未验证或 payload 模型不匹配时使用明确的 `"default"`。自定义/代理 endpoint、其它 provider/API 及所有非 TUI 请求保持原样；不使用当前 registry 或共享 lastHeaders 代替实际请求身份，也不等待目录查询。

官方 legacy provider 入口同时接管 full/simple stream；适配器统一委托原 provider 的完整 `stream`，原参数全部转发，仅将 simple `reasoning` 按官方 clamp 规则转换为 `reasoningEffort`。保留 full-stream 专属参数、transport、abort、fetch、原 payload/response/stream-event hook，不替换 auth、目录或模型覆盖。若 `openai-codex` 已被其它 native/legacy 扩展接管，拒绝安装并提示，不覆盖它。退出/重载只按 handler 所有权移除适配器，并保留后来合并的其它注册字段。命令保存后到达的 payload 决策才受新状态影响；已经发出的请求及其底层重试不撤回。

仅验证有效时 footer 独立显示 `fast`：

```text
GPT Display Name | high | fast | ctx 80%/500k
```

`fast` 表示当前经验证的 priority 请求策略，不代表服务端实际保证使用 priority、确定加速比例或减少耗时；真实可用性及计划计费由服务端决定。Pi 没有通用账户切换通知，静默身份变化的 footer 观察存在校验间隔；请求适配器只用实际请求身份匹配能力，不沿用其它 scope 的结论；不会把已捕获的 A 请求按后来 registry B 的能力提速。此策略不提供最终服务端执行承诺。

## 显示

字段顺序为模型 / thinking / fast（生效时）/ ctx / 5h、7d 额度或各币种余额 / branch。所有字段按此顺序连续填充当前行，只有当前完整字段放不下时才换行；不按信息和额度分组提前换行，也不因长分支移动前面能放下的额度。branch 始终位于所有可见字段最后，宽度足够时全部合为一行。

仅返回 7d 额度的合成示例（80 列，fast 生效）：

```text
Synthetic 模型 | high | fast | ctx 80%/500k | 7d [████      ] 40% ~4d15h
branch: feature/synthetic-footer-layout-long-branch
```

DeepSeek 余额字段示例（同样按顺序连续排列）：

```text
balance CNY 110.00100 | USD 20.00000001 | branch: main
```

- 模型显示名称取自当前 runtime 的 `ctx.model.name`，不维护模型名称表。其后独立显示 `ctx.thinkingLevel`（如 `high` / `off`），思考程度切换事件立即重绘；长模型名省略不影响该字段，未知显示 `?`。
- `ctx` 百分比仍表示剩余比例，即 `100 - ctx.getContextUsage().percent`，不是已用比例；格式为 `ctx 100%/500k`，压缩中、压缩后尚无估计或缺失数据为 `ctx ?/500k`（窗口也未知时为 `ctx ?/?`）。`/` 后显示上下文窗口总长度，优先取 `getContextUsage().contextWindow`，未知时回退当前 `model.contextWindow`，都未知为 `?`。总长度按十进制 k/M 紧凑显示、最多两位小数，例如 `272k`、`500k`、`1.05M`；压缩后百分比未知时仍保留已知窗口。此项是 runtime 上下文窗口估计，不扣除额外保留 token，也不是账户额度。
- 分支使用官方只读 footer data provider；非 Git 目录或空白/无有效分支值时隐藏整个 branch 字段及其分隔符。有值显示 `branch: NAME`，始终排在额度、余额或状态字段之后；没有额度/余额时也位于末尾。长分支沿用标签省略和字段换行，不隐藏前面的模型、thinking、fast、ctx 或额度/余额。detached HEAD 按宿主返回值显示。不执行 Git 写操作。
- Codex 使用响应根部 `rate_limit` 中实际时长为 18000/604800 秒的**账户**窗口。不是当前模型专属额度；`additional_rate_limits` 的 opaque feature 不被猜测、合并或替换为模型 ID。特殊模型还可能有本包不显示的独立限制。
- bar 与百分比使用同一个剩余值；bar 每格分 8 级，四舍五入到最近 1/8 格，默认 10 格、窄屏最低 2 格。整段 bar 体使用统一暗色背景轨道和亮色填充，空余区用空格，部分格右侧也显示同一轨道，不使用 `░`；上方纯文本示例无法展示底色。背景只覆盖括号内的 bar 体，0% 仍有完整轨道，100% 填满；换行保留空格并恢复/重置样式，不给括号或整行铺底。每次渲染读取当前主题，使用官方 Theme/style 和颜色 API 适配浅色/深色及 truecolor/ANSI256，不缓存带旧主题颜色的字符串。百分比最多两位小数，极小/极大非端点值用 `<0.01%` / `>99.99%`，避免四舍五入伪装成 0/100。
- 倒计时根据服务端绝对 `reset_at`，按分钟/小时向下取整，少于一分钟为 `~<1m`，缺失为 `~?`。到期为 `reset due`，立即隐藏旧百分比和 bar，不自行填充为满额。
- DeepSeek 只显示官方 `total_balance`，每个返回的 CNY/USD 分别显示；原始十进制字符串不转浮点、不相加、不换汇。不显示百分比、bar 或重置时间；余额本身不保证 API 请求一定可用。
- ready Codex 结果只显示实际返回的 5h/7d 窗口，缺失窗口不展示；返回窗口为 0% 时仍显示。没有可解析的受支持窗口会令整次查询失败，整体 loading/unavailable/stale 仍明确显示；失败不保留旧成功值，不把错误当作无限额，也不用 0 或满额代替。其它 provider 不显示额度/余额，分支仍位于最后。
- Unicode 宽度使用宿主 TUI 工具测量；超长模型名称/分支会省略。一个字段本身超过终端宽度时才在字段内部换行；极窄到无法容纳单个宽字符时会裁掉该字符以防溢出，金额数字不做四舍五入。终端字体须支持 Unicode block glyph。

## 数据、安全与生命周期

只在交互 TUI 当前 provider 为 `openai-codex` 或 `deepseek` 时查询：

| Provider | 唯一只读 GET 地址 | 认证 |
|---|---|---|
| Codex | `https://chatgpt.com/backend-api/wham/usage` | 当前 runtime OAuth bearer，JWT 内对应的账户 header |
| DeepSeek | `https://api.deepseek.com/user/balance` | 当前 runtime API key bearer |

Codex 的 ChatGPT backend 接口**不是稳定的公开 API**，可能变更或被拒绝访问。DeepSeek balance 是公开官方 API。账户字段若由响应返回，必须与请求账户匹配。没有 Codex OAuth、过期/无法识别的 token 或仅有 API key 时不查询 Codex 额度；不回退到 Codex CLI、浏览器或其它账户。

认证使用官方 `modelRegistry.getApiKeyAndHeaders(model)` / `isUsingOAuth(model)`。除本包 Fast 偏好外，代码不直接读取 auth.json、session、数据库或其它私有文件，不保存 secret、账户 ID、HTTP payload 或认证错误文本到磁盘/日志。正常 OAuth 刷新由 Pi 管理，宿主可能更新自己的凭据。配置的凭据命令也由 Pi runtime 处理。

发送前同时检查模型和 runtime 认证覆盖的官方 endpoint，拒绝 proxy/custom origin、URL 用户名密码、非官方路径、query/fragment，以及有歧义的认证 header。仅接受 Codex 官方根路径、`/backend-api`、`/backend-api/codex`，或 DeepSeek 根路径、`/v1`（可有末尾斜杠）。不转发任意配置 header，只构造必要认证 header。HTTP 拒绝重定向、8 秒超时、AbortSignal 取消，额度响应最多 64 KiB、Fast 目录最多 2 MiB（包括流式累计上限）；异常只呈现 unavailable，不输出秘密或账户标识。共享 HTTP 仅保留安全的错误分类、status 和解析后的 retry 时间，不保留响应内容或原始 header。

Fast 与额度查询按身份分别维护节流：支持 Retry-After 秒数和 HTTP-date，服务端未来期限不受 force、用户事件或同账户模型切换绕过。连续失败指数退避，Fast 从 10 秒、额度从 60 秒起步，本地退避最多 5 分钟；服务端更长期限不截短。有效成功响应重置失败计数，取消不计失败，也不清除已有期限。Codex 以账户/主体隔离期限，DeepSeek 以 API key 的进程内摘要隔离；切回原身份保留其期限，不影响另一个身份。受限且没有有效数据时显示 unavailable，不假装正在加载。节流保存在对应扩展实例的闭包中，同一实例的 `/new`、Session 替换和重复 `session_start` 保留端点/账户期限；进程退出或扩展 reload 后内存状态重建，不提供跨进程持久化限流。

- 每秒只做轻量调度和倒计时重绘；正常每 10 秒重新解析当前 runtime 认证，模型选择、输入/运行边界会提前校验。同一身份校验不切换成 loading。
- 身份验证租期最长 15 秒且不超过 JWT 到期时间；认证阻塞超过租期即隐藏额度。Pi 没有通用账户切换通知，静默账户替换在下一次校验前可能有最长约 10 秒的观察延迟，不能保证即时感知外部凭据变化。
- 每个当前 scope 正常最多每分钟 GET 一次；会话/模型切换会重新建立 scope。请求返回后再次校验当前 runtime 身份才接纳结果。失败、账号/provider/模型切换会丢弃旧结果；不会从其它账户/模型缓存取值。
- 缓存只有一个进程内 slot，以 provider、model、endpoint 与带随机进程盐的凭据摘要隔离；有效数据最多 90 秒，不落盘。token 刷新也会保守地换 scope。
- footer/额度的模型或会话切换、组件替换、重载和退出会清理其 timer、branch 订阅和在途请求；迟到结果不能恢复失效状态。Fast 策略及其资源独立管理，不随 footer 被替换而停止，退出/重载时释放。官方兼容认证 API 没有取消参数，底层 Pi 认证刷新本身不能由本包强行终止，但本包对它的等待有超时/取消，迟到返回会被忽略。

## 开发与验证

```sh
npm install --ignore-scripts --legacy-peer-deps
npm run check
npm test
npm pack --dry-run --ignore-scripts
```

所有 HTTP/认证/账号切换测试使用合成数据和 mock，不调用真实账户接口或模型，也不开服务。持久化测试使用 `os.tmpdir()`，运行时可将 TEMP/TMP/TMPDIR 指向专用测试工作目录；测试保留生成目录。覆盖渲染与 Unicode 宽度、bar 边界、统一背景与空格、真实 Pi dark/light Theme 下的最终 footer 组合、ANSI256、主题切换、窄屏样式恢复/重置和信息保留、ctx unknown/compaction 与窗口总长度优先/回退、thinking 事件重绘、空分支与缺失窗口隐藏及分隔符、长分支在窄/普通/宽屏下全局最后且不隐藏额度/多币种余额/错误状态、单 7d/双窗口/多币种连续排列的恰好容纳与少一列边界、倒计时、账户根窗口与无关专属桶、币种精度、超时/取消/超大/错误/重定向、scope 切换和生命周期清理，以及 Fast 能力解析、仅布尔偏好保存、失败/关闭并发、多 handler 真实组合、非 TUI 隔离、请求级 A/B 身份与实际 custom endpoint、同 ID 并发、full/simple 参数及注册恢复、Retry-After/连续失败退避和恢复。真实 Pi 1.3.0 Runtime 与 compiled pi.exe 的合成请求验证均使用隔离凭据及拦截的 fetch，不产生真实服务请求。Codex 额度和 DeepSeek 余额已通过真实终端显示验证，但未与供应商页面核对。Fast 验证未查询真实 Codex 目录/账户接口，也未发送真实 Fast 模型请求；Fast 的实际可用性、速度及额度消耗均未实测，需另行验证。测试通过不代表业务验收。

`@earendil-works/pi-coding-agent`、`pi-ai`、`pi-tui`（均为 `@earendil-works` scope）与 `typebox` 仅以 `peerDependencies: "*"` 声明；本地 devDependencies 固定宿主 1.3.0 供类型检查，不包含在发布文件中。Pi 通过自己的 loader 提供宿主模块，本包不打包宿主或其它 Pi package。没有依赖其它状态栏/usage package，因此没有额外插件自动加载或格式化状态协议耦合。

### 权威参考

- [Pi packages](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md)、[Extensions](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)、[TUI](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/tui.md)；实现以安装版 1.3.0 声明为准。
- [DeepSeek Get User Balance](https://api-docs.deepseek.com/api/get-user-balance)
- [OpenAI Codex backend client](https://github.com/openai/codex/blob/main/codex-rs/backend-client/src/client.rs)、[账户额度 fixture](https://github.com/openai/codex/blob/main/codex-rs/app-server/tests/suite/v2/rate_limits.rs)
- Fast 契约（官方源码快照 `ce0323f2f2d3b25e82806cd555237da3db4e1897`）：[模型能力字段与支持判断](https://github.com/openai/codex/blob/ce0323f2f2d3b25e82806cd555237da3db4e1897/codex-rs/protocol/src/openai_models.rs)、[Fast → priority/default 映射](https://github.com/openai/codex/blob/ce0323f2f2d3b25e82806cd555237da3db4e1897/codex-rs/protocol/src/config_types.rs)、[目录 GET 协议](https://github.com/openai/codex/blob/ce0323f2f2d3b25e82806cd555237da3db4e1897/codex-rs/codex-api/src/endpoint/models.rs)、[官方 Codex base URL](https://github.com/openai/codex/blob/ce0323f2f2d3b25e82806cd555237da3db4e1897/codex-rs/model-provider-info/src/lib.rs)、[目录端点与身份隔离](https://github.com/openai/codex/blob/ce0323f2f2d3b25e82806cd555237da3db4e1897/codex-rs/model-provider/src/models_endpoint.rs)。
