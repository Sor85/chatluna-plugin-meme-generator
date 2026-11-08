# AGENTS.md — chatluna-plugin-meme-generator

ChatLuna v2 表情包生成插件，迁移自 `koishi-plugin-chatluna-meme-generator` 0.0.34。独立源码目录是唯一编辑入口，宿主 `external/meme-generator` 仅为构建和运行副本。

## 开发与验证

- `@chatluna/*` 依赖来自 v2 workspace，不在本目录安装依赖或生成锁文件。
- 执行 `node scripts/sync-to-v2.mjs --once` 单向同步；不带 `--once` 持续监听。默认宿主为 `../../chatluna-v2-mirror`，可用 `CHATLUNA_V2_ROOT` 指定。
- 在宿主根目录执行 `yarn install`（首次同步或依赖变化后）、`yarn yakumo build meme-generator`；流水线同时构建服务端和 `client/index.ts`。
- 在宿主 `external/meme-generator` 执行 `yarn typecheck`（服务端与客户端）和 `yarn test`。
- 不直接改宿主副本，不覆盖用户配置、数据、现有工作区变更。测试使用临时目录与本地模拟 HTTP 服务。
- 不自行提交、建分支或发布。协议 MIT，版权与许可声明保留在 LICENSE。
- README 面向插件使用者，介绍使用方式、功能与必要限制，不包含迁移背景、内部 UI 实现或本地开发流程；开发与验证约定维护在本文件及子目录说明中。

## 发布

- 在源码根目录运行 `node scripts/publish.mjs`，不使用 `yarn npm publish`；脚本复用现有同步设置，依赖须已在 v2 宿主安装，不自动安装或修改版本。
- `--dry-run` 完整执行同步、清理、构建、类型检查、测试、打包和 `npm publish --dry-run`；允许源码有未提交改动，跳过正式发布的 Git/npm 前置条件，不上传、不创建或推送标签。`--otp=<验证码>` 传递 npm 两步验证码，日志隐藏验证码；`--help` 查看用法。
- 正式发布要求工作区干净、HEAD 与 origin 同名分支一致、本地及远端 `v<版本>` 标签不存在、npm 已登录且目标版本未发布；构建后再次检查工作区和 HEAD，防止包内容与标签不一致。
- 发布前清空副本 `lib`、`dist`、`tsconfig.tsbuildinfo`，用 `yarn pack` 转换 workspace 依赖，检查入口、声明、客户端、README 与 LICENSE 后发布解包目录。打包产物保留在系统临时目录并打印路径，不进入源码仓库。
- 稳定版使用 `latest`，alpha/beta/rc/next 版本使用对应 npm 标签，其他预发布使用 `next`。npm 命令成功后轮询确认版本及 dist-tag，再创建并推送指向原 HEAD 的 Git 标签；不自动提交或推送分支。索引未确认时不打标签，不应直接重复发布。

## 通用约定

- 使用 Cordis 4 生命周期、`@chatluna/schema` 与 v2 原生工具/动作 API，不引入旧 ChatLuna、LangChain、Zod 或旧 XML 临时消息钩子。
- v2 本身通过 Koishi 桥提供平台命令；可使用其类型增强和宿主的 `ctx.command`、`ctx.$processor`。上下文来自 Cordis，平台消息使用 Satori，不创建第二个 Koishi 实例。
- 配置由宿主 ui-kit / SchemaForm 渲染，不另建设置页面或复制旧 Vue 浮动导航；权重数组的客户端扩展约定见客户端子目录说明。
- 注册与资源释放绑定当前插件上下文；后端生命周期取消与工具调用取消必须传递至 HTTP 请求。
- 新增或改变约定时同步维护所属目录说明。

## 子目录说明

- `src/AGENTS.md`：配置、后端协议、平台命令、补全算法和原生工具。
- `client/AGENTS.md`：原设置页的权重表格扩展、客户端构建与生命周期。
- `tests/AGENTS.md`：迁移回归、HTTP 协议与安全边界测试。
