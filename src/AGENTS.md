# src 说明

适用范围：`src/`。同时遵守根 `AGENTS.md`；回归测试见 `tests/AGENTS.md`。

- `config.ts` 使用 `@chatluna/schema`、十组设置和中文 label；基础、触发、模型调用与模板筛选保持展开，列表输出、补全、随机、排队缓存、运行与开发者等低频调优组用 `.collapse()` 默认折叠，新增字段按使用频率归组。`Config` 表示已补全默认值的配置；`allowKeyWithoutPrefixTrigger` 默认开启，必须保留用户显式配置的 `false`。检索仅使用本地关键词匹配，不调用模型。两组权重数组使用 `meme-generator:weights` 角色，由客户端子目录的表格扩展渲染；`promptMemeKeys` 使用 `meme-generator:templates`，全局与分群排除的 key 数组使用 `meme-generator:excluded-templates`，均由模板选择器渲染、只保存 key；分群排除外层保留 `table` 角色，因子项含数组由宿主退回堆叠列表。
- 动作能力与参数由原生工具/动作定义提供，不在配置中保留不参与执行的参考提示词字段。删除此类字段时同步移除类型、默认文本、Schema 与标签，不为旧字段增加转换或回退分支。
- `index.ts` 可选注入 `chatluna_webui` 并注册客户端入口；没有 WebUI 时命令、后端与工具仍能独立加载。
- `backend.ts` 封装 meme-generator Python HTTP 协议，保留重复 multipart 字段、空 args 和 key 编码；校验返回结构，限制大小并传播超时/取消。
- `command/` 保留六个命令、别名、随机、列表与分群排除语义；v2 命令桥的 `session.execute` 默认自动发送；重写命令使用 `execute(input, true)` 捕获结果后只发送一次。前置提及的中文别名通过始终存在的 `meme` 父命令解析参数以保留引号边界，再直接调用生成管线，不执行主生成命令，避免受 `enableMemeCommandTrigger` 影响；该入口仍检查全局、分群与分类排除，并遵守错误静默设置。
- `domain/policy.ts` 与 `command/random.ts` 是迁移的纯算法。与原版的已确认差异：多段模板的昵称来源以昵称替换首段、其余沿用默认文案（奖状等首段为人名，原版对多段模板一律退回默认文案）；已有部分文字时按段位补缺额，避免默认首段错位到后面。随机桶分类不能与列表分类排除合并；历史仅存在当前插件实例内，跨会话共享；成功后才记录，子集轮回不清空全局历史。
- `promptMemeKeys`（注入模板）只增加提示、不限制可用模板：`prompt-templates.ts` 通过 `meme` 动作的 `prompt` 钩子写入选中模板的 key、名称与图文数量；宿主的提示钩子类型是同步的，所以模板信息在注册时预取，未取到的 key 只列 key，失败后 60 秒内不重试。未选模板时不设置 `prompt`，避免宿主每步生成动态块。全局、分群（按 `env.guildId`，私聊不适用）与类别排除在生成提示时生效。
- `webui.ts` 只在 `chatluna_webui` 存在时注册：`meme-generator.templates` 状态复用 `MemeSearchIndex` 的元数据快照（与 `meme_search` 共用一份，由 `index.ts` 创建），`meme-generator.preview` 动作把后端预览经可选服务 `takumi` 缩成 96px WebP Data URL，服务未启用时动作失败且不缓存。WebUI 接口需鉴权头，`<img>` 无法直接请求，所以预览走动作而非 HTTP 路由；缩略图只在内存缓存（最多 1024 张），失败不缓存，后端请求最多并发 4 个。
- `tools.ts` 只注册只读 `meme_search`，禁止生成、下载图片或向平台发消息。`search.ts` 缓存后端元数据，以 key、关键词、别名、标签及默认文案进行字面匹配，精确命中优先；全局、分群和分类排除在候选排序前生效，原人工命令保持不变。
- `actions.ts` 独立注册 `meme` 动作的 `run`，不依赖公开生成工具。宿主不替自定义动作校验 Schema，因此必须显式校验 attrs；仅消费显式文字、图片和提及，再应用原补全策略。图片 ref 只从宿主 ActionContext.sessionId 对应活动 agent 的内存消息读取，不读其他会话或创建会话。错误抛回宿主；平台图像只发送一次。
- `action-queue.ts` 以稳定平台会话隔离动作：包括平台、机器人、群/频道或私聊用户，使用结构化键避免分隔符碰撞，不使用单条消息或 agent 标识。同一会话 FIFO，不同会话受 `memeActionConcurrency` 限制（默认 4）；繁忙会话轮转，不抢占其他等待会话。排队取消立即移除，失败释放槽，运行中取消必须等实际任务退出再释放槽。
- 动作执行超时在获得槽位后开始；等待期限独立控制，默认 30 秒，每会话最多等待 5 条（均可配置），插件实例最多等待 100 条。排队超时或超限明确失败且不补发，调度前再次检查绝对期限，清理取消/到期任务的监听与计时器。排队期间仍响应 agent 取消与插件卸载；并发控制只作用于 XML 表情动作，不改变人工命令和普通聊天策略。
- 查询取消传入后端请求；动作结合插件卸载、超时以及可取得的当前 agent signal 取消，发送前再次检查。禁止把 XML 属性中的会话标识作为可信 ActionContext。
- `enableMemeXmlTool` 控制 v2 原生工具/动作启用；不保留旧版插件的配置兼容项、字段迁移或 character_reply 注入逻辑。
- 网络图片仅允许公网 HTTP(S)，逐次校验重定向并绑定经过验证的 DNS 地址，流读取上限 10 MiB；平台内联图片支持同样大小上限的 PNG/JPEG/GIF/WebP Base64 Data URL，不接受 SVG 或任意本地路径。管理员配置的后端可以位于内网。`198.18.0.0/15` 视为公网放行：Clash/mihomo 等代理的 fake-ip 模式把公网域名解析到该段，拦截会让所有头像和图片下载失败；拒绝时错误信息带上域名与命中地址便于排查。
- 图片段可以位于命令前后：执行时保留原会话图片与提及供图片解析、头像和昵称补全使用，只从命令文本参数剔除 `img`、`at` 元素，不把提及当作模板文案；普通文字与已解析的参数边界保持不变。图片前置的普通聊天必须继续放行。
- 平台提及仅读取标准 `at.id/name`，用户与群成员昵称使用 Satori 的 `nick/name`；不兼容旧 `at.userId/qq` 或 User 的 `nickname/username`。Koishi 桥的 `session.username` 与当前适配器的原始协议数据仍是有效输入，不按旧字段处理。图片消息由 Satori `h.image` 创建并使用其标准字符串序列化，不支持旧图片对象格式。
- 列表图片与缩略图交给可选服务 `takumi`（`chatluna-plugin-takumi`），调用时经 `ctx.get` 取用；字体、并发、`<head>` 样式提取与实体解码由服务负责，本插件不依赖 `@takumi-rs/*` 或字体包。列表排版保留 PNG 分页，分页高度用服务的 `measure` 测得。别名中的 emoji 以 Twemoji 图片渲染，只经 `downloadImage` 下载并在同一次构建内复用。服务未启用或渲染失败都退回文本，不保留不可达的纯文本图片布局。不新增数据库、业务持久化或生成图片落盘。
- 初始化重试、别名 matcher 与待处理请求都在插件卸载时释放；不使用旧 `ready` / `dispose` 生命周期事件。
