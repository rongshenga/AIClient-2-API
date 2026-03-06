# Parallel Execution Outline: `refactor-runtime-storage-to-database`

## 目标

把这个变更拆成 6~7 个可并行推进的工作流，让多个 Codex CLI 先并行完善各自子计划，再统一进入代码实现与集成。

## 并行前置规则

- 所有 CLI 都从同一个基线 commit 开分支。
- 所有 CLI 开始前统一阅读：`proposal.md`、`design.md`、`tasks.md`、本文件。
- 第一轮先各自补完“子计划 / 风险 / 接口假设 / 验证方案”，不要先改大面积代码。
- 未经协调，不要擅自修改以下共享契约：
  - `provider_id` 是不可变主键，`routing_uuid` 是可变兼容标识。
  - 表名、逻辑域命名、字段归属以 `design.md` 当前版本为准。
  - `provider_runtime_state` 只承载 durable provider 级快照，不承载锁、队列、瞬时并发占位。
  - 兼容导出仍保留 `provider_pools.json` 形状，但不再作为高频主写路径。
  - 事件广播语义 `config_update` / `provider_update` 保持兼容。

## 推荐分工

### CLI-1：存储契约与数据库基础层

- 目标：冻结 RuntimeStorage 共享契约，搭好数据库初始化、后端选择与基础 repository。
- 主范围：`src/core/`、新建存储目录、数据库 bootstrap、feature flag、基础模型定义。
- 优先产出：
  - RuntimeStorage 抽象边界
  - 数据库 backend 初始化路径
  - `provider_registrations` / `provider_runtime_state` / `provider_inline_secrets` / `provider_group_state` 等基础仓储接口
  - `file|db|dual-write` 模式切换约定
- 禁止越界：不要直接改 `provider-pool-manager` 选点细节，不要改 UI 业务逻辑。

### CLI-2：`ProviderPoolManager` 热状态与 flush 改造

- 目标：保留 Layer 1 内存热状态，同时把 durable runtime state flush 到数据库后端。
- 主范围：`src/providers/provider-pool-manager.js` 及其相关测试。
- 优先产出：
  - 内存态 vs `provider_runtime_state` 的落盘边界实现
  - `_flushPendingSaves()` / 初始化恢复 / `PERSIST_SELECTION_STATE` 行为改造
  - `needsRefresh`、`activeCount`、`waitingCount` 等字段继续只留内存
- 依赖：消费 CLI-1 冻结后的存储接口；接口未合并前可先用 mock/stub 对接。
- 禁止越界：不要顺手重写 provider CRUD API。

### CLI-3：Provider 管理 API 与兼容快照读写

- 目标：把 Provider CRUD / disable / reset / UUID refresh / quick link 等 mutation 收口到统一存储路径。
- 主范围：`src/ui-modules/provider-api.js`、`src/ui-modules/config-api.js`、`src/ui-modules/config-scanner.js`、广播兼容层。
- 优先产出：
  - 所有 Provider 池 mutation 统一走 RuntimeStorage
  - 兼容快照读取与 `provider_pools.json` 导出路径
  - 现有响应结构与广播副作用兼容
- 依赖：基于 CLI-1 的 mutation / snapshot 契约；与 CLI-2 只通过存储层交互，避免直接耦合。
- 禁止越界：不要接管凭据目录去重和 auto-link 逻辑。

### CLI-4：凭据清单、绑定与 auto-link 迁移

- 目标：把文件凭据索引、去重、绑定、auto-link 从目录扫描/字符串拼接迁到数据库模型。
- 主范围：`src/services/service-manager.js`、导入/上传入口、认证接入相关模块。
- 优先产出：
  - `credential_assets` / `credential_bindings` 的导入与去重规则
  - `provider_pools.json` 内联 secret 与文件凭据的拆分导入
  - auto-link / batch-link 新链路
- 依赖：CLI-1 的 credential inventory 契约；与 CLI-3 共享 provider registry 标识规则。
- 禁止越界：不要顺手修改 usage cache / plugin runtime。

### CLI-5：Usage cache、插件运行态与会话类数据迁移

- 目标：把 `usage-cache.json`、`api-potluck` 数据、必要的后台会话类运行态迁入数据库。
- 主范围：`src/ui-modules/usage-api.js`、`src/ui-modules/usage-cache.js`、`src/plugins/api-potluck/`、相关管理模块。
- 优先产出：
  - usage snapshot / refresh task 持久化
  - plugin runtime data 的数据库读写抽象
  - 与主 RuntimeStorage 的逻辑域边界
- 依赖：CLI-1 的数据库基础设施；与其他 CLI 主要通过配置与 feature flag 协同。
- 禁止越界：不要碰 ProviderPoolManager 内部状态机。

### CLI-6：迁移工具、兼容导入导出与回滚能力

- 目标：做初始化导入、差异校验、兼容导出、回滚与运维工具。
- 主范围：迁移脚本、导入导出工具、差异报告、运维文档。
- 优先产出：
  - 从 `provider_pools.json` / 旧目录到数据库的迁移工具
  - 差异报告、校验命令、回滚方案
  - 兼容导出与备份恢复流程
- 依赖：CLI-1 的仓储接口，CLI-3/CLI-4 的数据模型冻结结果。
- 禁止越界：不要改核心运行时热路径。

### CLI-7：测试、性能、灰度验证与最终集成

- 目标：补测试、做大号池性能验证、灰度开关验证，并承担最终集成回归。
- 主范围：`tests/`、文档、验证脚本、必要的 build/test 流程。
- 优先产出：
  - db mode 的 CRUD / 健康状态 / UUID 刷新 / quick link / batch import 测试
  - 大池选点、批量 flush、分页查询、启动恢复性能验证
  - 特性开关灰度/回退验证矩阵
- 依赖：消费前 1~6 的最终接口；尽量不要反向要求业务层再返工。
- 备注：如果只开 6 个 CLI，可把本工作流并入 CLI-6。

## 共享接口冻结清单

以下内容建议由 CLI-1 起草，其他 CLI 只提意见，不各自发明：

- RuntimeStorage 顶层能力最小集
  - 加载 provider registry + runtime snapshot
  - 原子执行 provider mutation
  - 批量 flush runtime state
  - 导出兼容 `provider_pools.json` 快照
  - 执行 legacy import / migration / diff report
- feature flag 最小集
  - `RUNTIME_STORAGE_BACKEND=file|db`
  - `RUNTIME_STORAGE_DUAL_WRITE=true|false`
  - `PERSIST_SELECTION_STATE=true|false`
- provider 标识规则
  - 内部一律用 `provider_id`
  - 对外兼容仍可接受 `providerType + uuid`
- 兼容快照规则
  - 读接口可继续返回 legacy shape
  - 写接口不得再直接 `writeFileSync(provider_pools.json)`

## 推荐执行顺序

### Phase 0：冻结共享契约

- CLI-1 先出接口草案与数据库基础边界。
- CLI-2 ~ CLI-7 只补各自子计划、风险与接口诉求。
- 协调者统一冻结 contract 后，再进入代码实现。

### Phase 1：并行完善子计划

每个 CLI 先在自己的分支补齐：

- 影响文件列表
- 子任务拆分
- 风险点 / 阻塞点
- 测试与验证命令
- 需要协调的共享接口变更

### Phase 2：并行实现

- 可完全并行：CLI-2、CLI-3、CLI-4、CLI-5、CLI-6
- 作为底座优先：CLI-1
- 作为收尾整合：CLI-7

### Phase 3：合并顺序

推荐合并顺序：

1. CLI-1 存储契约与基础设施
2. CLI-2 ProviderPoolManager 改造
3. CLI-3 Provider 管理 API / 兼容快照
4. CLI-4 凭据清单与 auto-link
5. CLI-5 usage/plugin/session runtime
6. CLI-6 迁移/导出/回滚工具
7. CLI-7 测试、性能、灰度验证与最终集成

## 每个 CLI 首轮输出模板

每个 Codex CLI 收到任务后，第一轮先给协调者回这 5 项，不要直接莽进代码：

1. 我负责的边界与不负责的边界
2. 预计改动文件
3. 对共享契约的依赖与假设
4. 风险 / 阻塞 / 需要确认的点
5. 实现后如何验证

## 冲突规避建议

- `src/providers/provider-pool-manager.js` 默认只让 CLI-2 动。
- Provider CRUD / API 入口默认只让 CLI-3 动。
- `service-manager` 与 credential inventory 默认只让 CLI-4 动。
- `usage-*` 与 `api-potluck` 默认只让 CLI-5 动。
- 迁移脚本、diff report、导出回滚默认只让 CLI-6 动。
- 公共存储抽象与数据库 bootstrap 默认只让 CLI-1 动。
- 测试文件若发生冲突，以 CLI-7 为主整合，其余 CLI 先提交最小必要测试或单独说明。

## 交付标准

- 子计划必须可独立阅读，不依赖口头上下文。
- 每个工作流都必须写清“依赖什么 shared contract，绝不越界改什么”。
- 最终实现前，协调者只接受已经完成边界声明的子计划，不接受“边写边想”的散装发挥。
