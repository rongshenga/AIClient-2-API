# Change: Refactor runtime storage to database-backed persistence

## Why

当前项目使用 `configs/` 目录保存主配置、Provider 池、OAuth 凭据、使用缓存和部分插件数据。这种方案最初有几个现实优势：零外部依赖、便于手工编辑、方便直接导入第三方凭据文件、也容易和现有的目录扫描逻辑对接。

但随着高频运行时状态和批量凭据导入规模扩大，文件存储已经开始暴露结构性问题：大文件高频重写、并发写入冲突、临时文件残留、目录扫描成本持续升高，以及凭据文件无限增长导致的运维和恢复复杂度上升。

因此需要把“高频变化、需要原子更新、需要查询与去重”的运行时数据迁移到数据库中，同时保留文件导入/导出兼容能力，作为长期演进方向。

## What Changes

- 引入数据库作为运行时存储的权威数据源，用于承载高频更新和可索引的数据。
- 将以下数据纳入数据库迁移范围：Provider 池持久化状态、凭据目录索引与去重元数据、使用缓存、`api-potluck` 相关用户与 Key 数据。
- 保留 `configs/` 目录的导入/导出能力，用于初始化、兼容旧流程、人工备份和应急恢复。
- 通过统一的存储抽象替代零散的 `writeFile` / `rename` / 目录扫描逻辑，避免同一份状态被多个模块以不同方式写入。
- 采用分阶段迁移：优先迁移高频运行时状态；凭据原文是否完全进入数据库作为后续阶段决策，不在第一阶段强制完成。
- 增加迁移工具、校验机制、回滚策略和运行可观测性要求。

## Impact

- Affected specs: `runtime-data-storage`
- Affected code:
  - `src/providers/provider-pool-manager.js`
  - `src/services/service-manager.js`
  - `src/ui-modules/config-scanner.js`
  - `src/ui-modules/usage-cache.js`
  - `src/auth/codex-oauth.js`
  - `src/providers/openai/codex-core.js`
  - `src/plugins/api-potluck/user-data-manager.js`
  - `src/plugins/api-potluck/key-manager.js`
- Operational impact:
  - 需要定义数据库选型、初始化和备份策略
  - 需要规划文件存储向数据库的迁移窗口
  - 需要为 Web UI 和现有导入流程保留兼容层
