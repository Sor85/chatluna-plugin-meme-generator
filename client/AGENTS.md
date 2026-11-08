# client 说明

适用范围：`client/`。同时遵守根 `AGENTS.md`；配置契约见 `src/AGENTS.md`，回归测试见 `tests/AGENTS.md`。

- 只向原插件设置页注册 `meme-generator:weights` 数组渲染器，不注册通用 `array/table`，不新增设置路由或独立保存接口，避免影响其他插件。
- 通过 `registerReactFormExtension` 注册并由 Cordis `ctx.effect` 注销；服务端可选注入 `chatluna_webui` 加载客户端，不让命令依赖 WebUI。
- 表格与按钮复用 `@chatluna/ui-kit`，单元格调用 SchemaForm 的 `render(..., { embedded: true })`，保留宿主校验和控件行为。外层使用 `extensionProps` 保留整组恢复默认、撤销与 JSON 编辑。
- 不改变数组数据语义：保留顺序、重复类别、零权重、空数组及未知字段；编辑只通过 `onChange` 交回宿主保存。新增行显式填入子字段默认值，避免必填类别仅显示而未保存。
- 表格根容器显式指定字号与行高。横向溢出沿用宿主 Table 容器；不覆盖宿主滚动条、指针或弹窗行为。图标沿用宿主 Lucide。
- 客户端由宿主 `chatluna-webui` 构建到 `dist`，源码目录不生成产物。新增 Tailwind 类名后完整重启宿主再验证。
