# Parallel Codex CLI Prompts: `refactor-runtime-storage-to-database`

> 用法：每个 CLI 复制对应章节里的整段提示词即可。
> 规则：第一轮先补子计划、边界、风险、验证方案，再进入实现；不要一上来就全仓乱改。

## Shared Context

所有 CLI 开始前统一阅读：

- `openspec/changes/refactor-runtime-storage-to-database/proposal.md`
- `openspec/changes/refactor-runtime-storage-to-database/design.md`
- `openspec/changes/refactor-runtime-storage-to-database/tasks.md`
- `openspec/changes/refactor-runtime-storage-to-database/parallel-outline.md`
- `openspec/changes/refactor-runtime-storage-to-database/parallel-prompts.md`

统一硬约束：

- `provider_id` 是内部不可变主键，`routing_uuid` 是对外兼容标识。
- `provider_runtime_state` 只存 durable provider 级快照，不存锁、Promise 队列、瞬时并发占位。
- `needsRefresh`、`activeCount`、`waitingCount`、队列/锁/定时器仍默认留内存。
- 未经协调，不要自创表名、自创字段归属、自创广播语义。
- 第一轮先给出子计划，不要直接进行大面积实现。

---

## Prompt 1 - CLI-1 存储契约与数据库基础层

```text
你正在处理 OpenSpec 变更 `refactor-runtime-storage-to-database` 的并行子任务 1。

先阅读：
- openspec/changes/refactor-runtime-storage-to-database/proposal.md
- openspec/changes/refactor-runtime-storage-to-database/design.md
- openspec/changes/refactor-runtime-storage-to-database/tasks.md
- openspec/changes/refactor-runtime-storage-to-database/parallel-outline.md

你的职责边界：
- 负责冻结 RuntimeStorage 共享契约、数据库基础设施、backend 选择与 feature flag。
- 负责 provider registry / runtime state / inline secrets / group state / credential inventory 的 repository 抽象与初始化路径。
- 不负责 ProviderPoolManager 选点逻辑。
- 不负责 provider-api 的 CRUD 业务细节。
- 不负责 usage/plugin 业务迁移细节。

你主要覆盖的 tasks.md 条目：
- 1.2 明确数据库托管范围与非目标
- 1.3 确认数据库选型与部署约束
- 1.5 明确 `provider_pools.json` 的字段拆分、主键策略和兼容视图（存储层视角）
- 2.1 设计统一存储抽象，隔离文件与数据库实现
- 2.2 明确数据库数量、逻辑域与初版表清单
- 2.3 为 Provider 池定义注册表、secret 表、credential inventory、运行时状态表和兼容投影视图
- 2.4 提供事务化写入、并发控制、幂等更新以及 `provider_id` / `uuid` 双标识解析能力
- 4.4 使用特性开关支持分阶段切换与灰度回退（共享契约部分）

第一轮先输出，不要急着大改代码：
1. 你负责的边界与不负责的边界
2. 计划新增/修改的文件列表
3. RuntimeStorage 顶层接口草案
4. 数据库初始化与 feature flag 方案
5. 你需要其他 CLI 遵守的共享契约
6. 风险点、阻塞点、验证方案

如果进入实现，优先顺序：
1. 定义存储目录、数据库 bootstrap、backend 装配
2. 冻结 RuntimeStorage 最小接口
3. 实现 repository / schema 初始化 / 基础事务边界
4. 提供 file/db/dual-write 模式切换
5. 给其他 CLI 可消费的 mockable 接口

特别要求：
- 你的产出要尽量让 CLI-2/3/4/5/6 可以并行对接，不要把 API 设计成只能单线程跟你商量。
- 优先做“接口稳定”，不要上来就做一堆业务细节。
- 如果你需要补文档，请把共享契约写清楚，别写成谜语。

最终请给出：
- 子计划
- 契约草案
- 预估改动文件
- 验证命令
```

---

## Prompt 2 - CLI-2 ProviderPoolManager 热状态与 flush 改造

```text
你正在处理 OpenSpec 变更 `refactor-runtime-storage-to-database` 的并行子任务 2。

先阅读：
- openspec/changes/refactor-runtime-storage-to-database/proposal.md
- openspec/changes/refactor-runtime-storage-to-database/design.md
- openspec/changes/refactor-runtime-storage-to-database/tasks.md
- openspec/changes/refactor-runtime-storage-to-database/parallel-outline.md

你的职责边界：
- 负责 `src/providers/provider-pool-manager.js` 的热状态分层、启动恢复、批量 flush 改造。
- 负责把 durable runtime state 写入 RuntimeStorage / db backend。
- 负责保持 Layer 1 内存热状态仍然服务请求热路径。
- 不负责 provider-api CRUD。
- 不负责 credential inventory / auto-link。
- 不负责 usage/plugin/session 迁移。

你主要覆盖的 tasks.md 条目：
- 1.6 输出 `ProviderPoolManager` 字段级归属清单（落地实现视角）
- 2.5 定义内存热状态层与数据库 flush 策略，明确哪些字段逐请求更新、哪些字段批量持久化
- 3.3 迁移 `provider-pool-manager` 的 Provider 池写路径
- 4.2 让 `getProviderStatus()` 使用数据库兼容快照（与 CLI-3 协同）
- 5.2 验证启动/Reload/状态接口在数据库模式下仍能拿到正确的 Provider 池兼容快照（本模块部分）
- 5.3 验证高频写入场景下不再产生 `provider_pools.json.*.tmp` 临时文件堆积（本模块部分）
- 5.6 验证大池选点、批量 flush、恢复加载的性能边界（本模块部分）
- 5.7 验证进程崩溃、flush 中断或异常退出时 Provider runtime durable state 的一致性边界（本模块部分）

第一轮先输出，不要直接大改：
1. `provider.config` / `provider.state` / manager-level state 的字段落位方案
2. 需要依赖 CLI-1 提供哪些 RuntimeStorage 接口
3. `_flushPendingSaves()`、初始化恢复、`PERSIST_SELECTION_STATE` 的改造思路
4. 你计划新增/修改的文件
5. 风险、验证方案、性能关注点

如果进入实现，优先顺序：
1. 用 mock/stub 先对齐 RuntimeStorage 接口
2. 改造启动恢复链路
3. 改造 runtime flush 链路
4. 保证 `needsRefresh`、`activeCount`、`waitingCount` 等字段仍只留内存
5. 补针对性的单元测试/性能验证

特别要求：
- 不能把数据库改成“每次选点同步写一次”，那是灾难，不是实现。
- `provider_runtime_state` 只保存 durable snapshot，不准把锁、队列、计时器往里塞。
- 不要顺手扩散修改 provider-api 或 service-manager。

最终请给出：
- 子计划
- 字段落位实现方案
- 预估改动文件
- 验证命令
```

---

## Prompt 3 - CLI-3 Provider 管理 API 与兼容快照读写

```text
你正在处理 OpenSpec 变更 `refactor-runtime-storage-to-database` 的并行子任务 3。

先阅读：
- openspec/changes/refactor-runtime-storage-to-database/proposal.md
- openspec/changes/refactor-runtime-storage-to-database/design.md
- openspec/changes/refactor-runtime-storage-to-database/tasks.md
- openspec/changes/refactor-runtime-storage-to-database/parallel-outline.md

你的职责边界：
- 负责 `provider-api`、`config-api`、`config-scanner` 等管理入口的统一存储改造。
- 负责兼容快照读取、legacy shape 输出、广播兼容。
- 负责 add/update/delete/disable/reset/delete unhealthy/refresh unhealthy UUIDs/quick link 等 mutation 的统一写路径。
- 不负责 ProviderPoolManager 内部调度状态。
- 不负责 credential inventory 去重和 auto-link。

你主要覆盖的 tasks.md 条目：
- 1.5 明确 `provider_pools.json` 的字段拆分、主键策略和兼容视图（API/快照视角）
- 3.3 迁移 `provider-api` 的 Provider 池写路径
- 4.1 保留现有文件导入/导出接口，并提供 `provider_pools.json` 兼容导出
- 4.2 让 `provider-api`、`config-scanner` 使用数据库兼容快照
- 4.3 保持 `config_update` / `provider_update` 广播语义与现有 Web UI 响应结构兼容
- 5.1 增加数据库模式下 Provider 池 CRUD、UUID 刷新、Quick Link、Batch Import 相关测试（API 部分）
- 5.2 验证状态接口在数据库模式下仍能拿到正确兼容快照（API 部分）

第一轮先输出：
1. 你覆盖的 API / handler 列表
2. 哪些旧的 `writeFileSync(provider_pools.json)` 路径需要被替换
3. 兼容快照 shape 与导出策略
4. 广播兼容策略
5. 对 CLI-1 / CLI-2 的接口依赖
6. 风险和验证方案

如果进入实现，优先顺序：
1. 识别所有 provider pool mutation 入口
2. 收口到统一 mutation service / RuntimeStorage
3. 抽离兼容快照读取层
4. 保持响应结构与广播兼容
5. 补 API 测试

特别要求：
- 不要让旧接口悄悄改 shape，否则前端和脚本会一起炸。
- 兼容导出可以保留，但运行时高频写不能再回写 `provider_pools.json`。
- 不要顺手接管 credential inventory 逻辑。

最终请给出：
- 子计划
- API mutation 清单
- 预估改动文件
- 验证命令
```

---

## Prompt 4 - CLI-4 凭据清单、绑定与 auto-link 迁移

```text
你正在处理 OpenSpec 变更 `refactor-runtime-storage-to-database` 的并行子任务 4。

先阅读：
- openspec/changes/refactor-runtime-storage-to-database/proposal.md
- openspec/changes/refactor-runtime-storage-to-database/design.md
- openspec/changes/refactor-runtime-storage-to-database/tasks.md
- openspec/changes/refactor-runtime-storage-to-database/parallel-outline.md

你的职责边界：
- 负责 credential inventory、绑定关系、去重规则、auto-link / batch-link 迁移。
- 负责从旧目录扫描/字符串去重迁到数据库模型。
- 负责 `provider_pools.json` 内联 secret 与文件型凭据的拆分导入策略。
- 不负责 ProviderPoolManager 热状态。
- 不负责 provider-api CRUD 聚合接口。
- 不负责 usage/plugin runtime。

你主要覆盖的 tasks.md 条目：
- 1.4 确认凭据原文入库策略与安全边界
- 2.3 为 Provider 池定义 secret 表、credential inventory、绑定关系（credential 部分）
- 3.1 实现从 `provider_pools.json` 到数据库模型的初始化导入工具（credential 部分）
- 3.2 为 Provider 池、内联 secret 和凭据目录建立去重、稳定主键与绑定规则
- 3.3 迁移 `service-manager auto-link` 的 Provider 池写路径
- 4.1 保留现有文件导入接口（credential import 部分）
- 5.1 增加 Batch Import / auto-link / credential binding 测试（本模块部分）
- 5.8 补充凭据导入、备份恢复、安全边界相关文档（本模块部分）

第一轮先输出：
1. credential 领域的实体/关系草案
2. 去重键、稳定主键、绑定规则方案
3. 旧目录扫描到新模型的迁移思路
4. auto-link / batch-link 的新写路径
5. 对 CLI-1 / CLI-3 的接口依赖
6. 风险和验证方案

如果进入实现，优先顺序：
1. 冻结 credential asset / binding / inline secret 数据模型
2. 改造导入与扫描逻辑
3. 改造 auto-link / batch-link
4. 补测试和文档

特别要求：
- 第一阶段可以保留文件原文兼容层，但索引、去重、绑定不能继续靠目录扫描硬顶。
- 内联 secret 不得继续把 `provider_pools.json` 当权威源。
- 别顺手乱改 usage 或 ProviderPoolManager。

最终请给出：
- 子计划
- credential 关系模型
- 预估改动文件
- 验证命令
```

---

## Prompt 5 - CLI-5 Usage cache、插件运行态与会话类数据迁移

```text
你正在处理 OpenSpec 变更 `refactor-runtime-storage-to-database` 的并行子任务 5。

先阅读：
- openspec/changes/refactor-runtime-storage-to-database/proposal.md
- openspec/changes/refactor-runtime-storage-to-database/design.md
- openspec/changes/refactor-runtime-storage-to-database/tasks.md
- openspec/changes/refactor-runtime-storage-to-database/parallel-outline.md

你的职责边界：
- 负责 `usage-cache.json`、usage refresh task、`api-potluck` 插件运行态、必要的后台会话类数据迁移。
- 负责这部分数据的数据库抽象、兼容读取与测试。
- 不负责 ProviderPoolManager 热路径。
- 不负责 provider-api CRUD。
- 不负责 credential inventory / auto-link。

你主要覆盖的 tasks.md 条目：
- 1.2 明确数据库托管范围与非目标（usage/plugin/session 部分）
- 2.2 明确数据库逻辑域与初版表清单（usage/plugin/session 部分）
- 3.1 初始化导入工具（usage/plugin/session 部分，如需要）
- 4.2 让 `usage-api` 使用数据库兼容快照/新后端
- 5.1 增加数据库模式下 usage / plugin runtime 测试
- 5.2 验证启动/Reload 后 usage/plugin 数据可正确恢复
- 5.5 验证并发写入压力下 usage/plugin/session 持久化的一致性与幂等行为（本模块部分）
- 5.8 补充 usage/plugin 运维说明

第一轮先输出：
1. 你负责的数据对象边界
2. 这些数据分别进哪些表/逻辑域
3. 现有文件路径、读写入口、兼容需求
4. 对 CLI-1 的后端接口依赖
5. 风险与验证方案

如果进入实现，优先顺序：
1. 梳理现有 usage/plugin/session 读写入口
2. 抽存储接口
3. 落数据库后端与兼容读取
4. 补测试与必要文档

特别要求：
- 不要碰 ProviderPoolManager 选点状态，那不是你的锅。
- 这部分设计要和主 RuntimeStorage 逻辑域一致，不要另起一套宇宙。

最终请给出：
- 子计划
- usage/plugin/session 存储方案
- 预估改动文件
- 验证命令
```

---

## Prompt 6 - CLI-6 迁移工具、兼容导入导出与回滚能力

```text
你正在处理 OpenSpec 变更 `refactor-runtime-storage-to-database` 的并行子任务 6。

先阅读：
- openspec/changes/refactor-runtime-storage-to-database/proposal.md
- openspec/changes/refactor-runtime-storage-to-database/design.md
- openspec/changes/refactor-runtime-storage-to-database/tasks.md
- openspec/changes/refactor-runtime-storage-to-database/parallel-outline.md

你的职责边界：
- 负责迁移工具、初始化导入、兼容导出、差异报告、回滚方案、运维说明。
- 负责把旧文件世界和新数据库世界之间的可验证迁移通道做出来。
- 不负责核心运行时热路径改造。
- 不负责 provider-api 的日常 CRUD 逻辑。

你主要覆盖的 tasks.md 条目：
- 3.1 实现从 `provider_pools.json` 到数据库模型的初始化导入工具
- 3.4 提供迁移校验、差异报告与回滚方案
- 4.1 保留现有文件导入/导出接口，并提供 `provider_pools.json` 兼容导出
- 4.4 使用特性开关支持分阶段切换与灰度回退（迁移与运维部分）
- 5.3 验证高频写入场景下不再产生 `provider_pools.json.*.tmp` 临时文件堆积（迁移后验证部分）
- 5.8 补充运维文档、备份恢复和监控说明

第一轮先输出：
1. 迁移命令/脚本/入口设计
2. 导入、校验、差异、回滚的步骤设计
3. 兼容导出策略
4. 灰度切换/回滚流程
5. 对 CLI-1/3/4/5 的依赖
6. 风险和验证方案

如果进入实现，优先顺序：
1. 设计 migration command / tool 入口
2. 做初始化导入
3. 做 diff report 与校验工具
4. 做兼容导出与回滚流程
5. 补运维文档

特别要求：
- 迁移工具必须可验证、可回滚，不要只会“导进去然后祈祷”。
- 差异报告至少要覆盖 provider registry、runtime state、credential binding、usage/plugin 这几个核心域。
- 如果只有 6 个 CLI，CLI-7 的部分验证职责可由你代管，但要明确说明。

最终请给出：
- 子计划
- 迁移/导出/回滚方案
- 预估改动文件
- 验证命令
```

---

## Prompt 7 - CLI-7 测试、性能、灰度验证与最终集成

```text
你正在处理 OpenSpec 变更 `refactor-runtime-storage-to-database` 的并行子任务 7。

先阅读：
- openspec/changes/refactor-runtime-storage-to-database/proposal.md
- openspec/changes/refactor-runtime-storage-to-database/design.md
- openspec/changes/refactor-runtime-storage-to-database/tasks.md
- openspec/changes/refactor-runtime-storage-to-database/parallel-outline.md

你的职责边界：
- 负责测试矩阵、性能验证、灰度验证、最终集成回归。
- 负责把其他 CLI 的改动串起来验证，而不是重新发明业务实现。
- 可以补最小必要的测试桩与集成脚本。
- 不负责主业务逻辑重构。

你主要覆盖的 tasks.md 条目：
- 5.1 增加数据库模式下 Provider 池 CRUD、健康状态、UUID 刷新、Quick Link、Batch Import 的单元与集成测试
- 5.2 验证启动/Reload/状态接口在数据库模式下仍能拿到正确的 Provider 池兼容快照
- 5.3 验证高频写入场景下不再产生 `provider_pools.json.*.tmp` 临时文件堆积
- 5.4 验证 SQLite CLI 后端在批量 SQL、事务提交与短周期 flush 场景下的进程启动开销与可接受性能窗口
- 5.5 验证并发写入压力下 Provider mutation、runtime flush、usage/plugin/session 持久化的一致性与幂等结果
- 5.6 验证十几万账号规模下选点、批量 flush、分页查询和恢复加载的性能边界
- 5.7 验证进程崩溃、flush 中断或异常退出时数据库不损坏，且未 flush 数据丢失窗口符合设计预期
- 5.8 补充运维文档、备份恢复和监控说明（验证矩阵部分）

第一轮先输出：
1. 测试矩阵草案
2. 你需要各 CLI 提供哪些可验证接口/夹具/fixture
3. 单元测试 / 集成测试 / 并发压力测试 / 崩溃恢复测试 / 性能验证 / 灰度回退验证的分层方案
4. 你需要如何量化 SQLite CLI 启动开销、批量 flush 延迟窗口和十万级账号性能边界
5. 可能的测试冲突与整合策略
6. 风险和验证命令

如果进入实现，优先顺序：
1. 先补测试矩阵与 fixture 设计
2. 跟进 CLI-1~6 的接口冻结结果
3. 增加并发写入压力、崩溃恢复、SQLite CLI 开销基准相关回归测试
4. 做十万级账号性能与灰度验证脚本/文档
5. 做最终集成回归

特别要求：
- 不要为了“测试方便”把核心业务再改烂一遍。
- 测试优先验证最容易回归爆炸的链路：provider mutation、runtime flush、compat snapshot、migration、rollback。
- 必须把 SQLite CLI 启动开销、并发写入压力、十万级账号性能、进程崩溃一致性单独列成可执行验证项，别拿“以后再测”自欺欺人。
- 如果只有 6 个 CLI，这部分可并入 CLI-6，但测试矩阵仍要单独成稿。

最终请给出：
- 子计划
- 测试矩阵
- 预估改动文件
- 验证命令
```

---

## Prompt 8 - CLI-8 现有 `configs/` 存量数据迁移收尾与切换执行（后置）

```text
你正在处理 OpenSpec 变更 `refactor-runtime-storage-to-database` 的后置子任务 8。

启动条件：
- 这个工作流默认在 CLI-1~6 已完成、或至少主要接口与数据模型已经冻结后再启动。
- 你的任务是收尾现有 `configs/` 存量数据迁移，不是回头改烂前面主线实现。
- 如果某个前置接口缺失，请明确记录 blocker 并反馈协调者；不要自创一套新的共享契约。

先阅读：
- openspec/changes/refactor-runtime-storage-to-database/proposal.md
- openspec/changes/refactor-runtime-storage-to-database/design.md
- openspec/changes/refactor-runtime-storage-to-database/tasks.md
- openspec/changes/refactor-runtime-storage-to-database/parallel-outline.md
- 如已存在，补充阅读 CLI-1/4/5/6/7 的最终接口说明、迁移工具说明、验证矩阵

你的职责边界：
- 负责现有 `configs/` 存量运行时数据的 inventory、snapshot manifest、baseline backfill 编排、cutover gate、异常处理、最终迁移验收。
- 负责把 `provider_pools.json`、凭据目录索引、`usage-cache.json`、`token-store.json`、`api-potluck` 数据串成一条可执行、可验证、可回滚的迁移 runbook。
- 负责迁移后记录数、关键字段、兼容投影 diff、异常文件策略的最终验收。
- 不负责重新设计 RuntimeStorage 契约。
- 不负责重写 `ProviderPoolManager`、provider-api CRUD、usage/plugin 主业务逻辑。
- 不负责为了迁移方便去反向改烂 CLI-1~6 已经稳定的边界。

你主要覆盖的 tasks.md 条目：
- 3.1 生成现有 `configs/` 存量数据清单、checksum 快照与异常文件报告
- 3.4 实现 `usage-cache.json`、`token-store.json`、`api-potluck` 现有数据的基线回填（收尾编排与落地验证部分）
- 3.5 定义 `file -> dual-write -> db` 切换闸门、冻结窗口与断点续跑规则
- 3.7 提供迁移校验、差异报告与回滚方案
- 4.4 使用特性开关支持分阶段切换与灰度回退（执行与验收部分）
- 5.9 验证现有 `configs/` 存量数据迁移后，Provider、usage、session、potluck 记录数与关键字段校验通过

第一轮先输出：
1. 你依赖哪些前置产物（CLI-1/4/5/6/7）以及是否已满足
2. `configs/` 存量数据 inventory / snapshot manifest 方案
3. baseline backfill 的顺序、幂等策略、断点续跑规则
4. `file -> dual-write -> db` 切换闸门、冻结窗口、回滚触发条件
5. 异常文件处理策略（例如 `provider_pools.json.*.tmp`、孤儿文件、解析失败文件）
6. 最终验证命令、验收标准、风险与阻塞点

如果进入实现，优先顺序：
1. 先确认 CLI-1~6 的接口、表结构、迁移工具已经稳定可消费
2. 生成 `configs/` inventory、checksum、snapshot manifest 与 anomaly report
3. 串起 `provider_pools.json`、凭据目录索引、`usage-cache.json`、`token-store.json`、`api-potluck` 的 baseline backfill 流程
4. 落地 diff report、关键计数校验、兼容投影校验与回滚前置检查
5. 输出 cutover runbook、回滚 runbook、迁移验收报告

特别要求：
- 你是后置收尾 CLI，不要回头打断已经运行中的 1~6；主线边界一旦稳定，就按现状消费。
- 如果某个主线产物不满足迁移要求，请先写清 blocker 和最小补丁点，不要顺手扩散改造范围。
- `provider_pools.json.*.tmp`、孤儿文件、解析失败文件不得被静默当成权威输入，必须进入 anomaly report。
- 最终产出必须让协调者能据此判断：能不能切、怎么切、切坏了怎么退。

最终请给出：
- 子计划
- 前置依赖清单
- inventory / backfill / cutover / rollback 方案
- 预估改动文件
- 验证命令
```

