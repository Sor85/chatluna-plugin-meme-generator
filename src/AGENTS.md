# src 说明

适用范围：`src/`。同时遵守根 `AGENTS.md`；回归测试见 `tests/AGENTS.md`。

- `config.ts` 保留源 0.0.34 的键名、八组配置与浅合并规则，使用 `@chatluna/schema` 和中文 label。默认值沿用迁移基线，但 `allowKeyWithoutPrefixTrigger` 默认开启；必须保留用户显式配置的 `false`。两组权重数组使用 `meme-generator:weights` 角色，由客户端子目录的表格扩展渲染；其他数组仍由宿主默认表单渲染。
- `index.ts` 可选注入 `chatluna_webui` 并注册客户端入口；没有 WebUI 时命令、后端与工具仍能独立加载。
- `backend.ts` 封装 meme-generator Python HTTP 协议，保留重复 multipart 字段、空 args 和 key 编码；校验返回结构，限制大小并传播超时/取消。
- `command/` 保留六个命令、别名、随机、列表与分群排除语义；v2 命令桥的 `session.execute` 默认自动发送；重写命令使用 `execute(input, true)` 捕获结果后只发送一次。
- `domain/policy.ts` 与 `command/random.ts` 是迁移的纯算法。随机桶分类不能与列表分类排除合并；历史仅存在当前插件实例内，跨会话共享；成功后才记录，子集轮回不清空全局历史。
- `tools.ts` 将 `meme_generate` 和 `meme` 原生动作接入同一个执行器，禁止监听或改写模型消息数组。工具显式参数不继承触发消息的文字、图片或提及；图片引用只从当前 agent 会话解析。工具成功需实际向平台发图，再通过 `render.result` 返回结构化图像，不能把 base64 当文本。
- `enableMemeXmlTool` 控制原生工具/动作启用；旧 `injectMemeXmlToolAsReplyTool` 仅保留配置兼容，v2 不存在旧 character_reply 字段注入。
- 网络图片仅允许公网 HTTP(S)，逐次校验重定向并绑定经过验证的 DNS 地址，流读取上限 10 MiB；平台内联图片支持同样大小上限的 PNG/JPEG/GIF/WebP Base64 Data URL，不接受 SVG 或任意本地路径。管理员配置的后端可以位于内网。
- 图片段可以位于命令前后：执行时保留原会话图片，只从命令文本参数剔除图片段；图片前置的普通聊天必须继续放行。
- `render/takumi.ts` 和列表排版保留原来的 Takumi、中韩字体及 PNG 分页，不使用浏览器截图。不新增数据库、业务持久化或生成图片落盘。
- 初始化重试、别名 matcher 与待处理请求都在插件卸载时释放；不使用旧 `ready` / `dispose` 生命周期事件。
