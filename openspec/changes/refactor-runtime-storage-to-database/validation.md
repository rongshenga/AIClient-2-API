# Validation Baseline

## 5.0 分层测试基线与统一判定标准

本文档记录 `openspec/changes/refactor-runtime-storage-to-database/tasks.md` 中 `5.0` 的完成证据。
目标不是拿一次 Happy Path 自欺欺人，而是把分层测试入口、覆盖维度、复测结果和判定边界摊开说清楚。

### 5.0.a 测试矩阵与结果证据

| 层级 | 重点对象 | Happy Path | Sad Path | Boundary Cases | 现有测试入口 | 本轮复测结果 |
| --- | --- | --- | --- | --- | --- | --- |
| 后端核心业务逻辑 | `ProviderPoolManager` 刷新恢复、UUID 刷新、runtime flush | 刷新成功恢复健康、批量 flush、UUID 刷新写回 | 刷新上限后立即标记不健康 | `needsRefresh` 仅保留内存态、selection seq 可选落库 | `tests/provider-pool-manager.test.js` | 通过 |
| 后端核心业务逻辑 | `provider-api` CRUD、Quick Link、Batch Import | CRUD、批量导入、Quick Link、兼容导出 | 持久化失败、未知 UUID、广播不应误发 | 缺参、非法 `providerType`、空对象、空名、超长名、UUID 冲突 | `tests/provider-api-runtime-storage.test.js` | 通过 |
| 输入边界 / 批处理 | `usage-api` query override 解析与分组策略 | 大批量异步 refresh 完成并持久化 | 无缓存时按优先级刷新 | `0` / 负数 override 忽略、超界 `groupSize` 被钳制 | `tests/usage-api.test.js` | 通过 |
| 存储映射 | Provider 拆分、稳定 ID、compat snapshot | legacy Provider 正常拆分和回放 | 旧 JSON 脏字段不应污染导出 | 默认值、时间字段、布尔字段、稳定 `provider_id` 与 mutable `uuid` 分离 | `tests/runtime-storage.test.js`、`tests/provider-storage-mapper.test.js` | 通过 |
| 错误分类 | `RuntimeStorageError` 分类、策略、细节序列化 | lock conflict / backend unavailable 正常分类 | parameter / data / validation error 不误判 | 数组截断、对象归一化、底层错误码透传 | `tests/runtime-storage-error.test.js` | 通过 |
| 降级与重试 | `runtime-storage-registry` fallback / retry | 初始化成功、操作成功 | DB 初始化失败、写失败、fallback retry 失败 | 关闭 fallback、secondary write 失败不降级、空 compat snapshot | `tests/runtime-storage-registry.test.js` | 通过 |
| 双写语义 | `DualWriteRuntimeStorage` 主写/次写包装 | primary 成功后 secondary 同步 | primary 失败 / secondary 失败错误分流 | replay-safe 诊断信息与 cutover 阻断语义 | `tests/dual-write-runtime-storage.test.js`、`tests/runtime-storage-extended.test.js` | 通过 |
| DAO / Executor | sqlite CLI 与 DAO SQL 构造 | 事务 SQL、查询队列、聚合逻辑 | JSON parse fail-fast、commit 失败 | 空结果集、字符转义、序列化失败、空批次短路 | `tests/sqlite-cli-client.test.js`、`tests/sqlite-runtime-storage-dao.test.js` | 通过 |
| 启动恢复 / 兼容读 | config reload、compat snapshot、服务启动恢复 | 从 DB 启动与 reload 恢复 | legacy 文件缺失时继续恢复 | usage / session / potluck 空内存恢复 | `tests/config-manager-runtime-storage.test.js`、`tests/config-reload-runtime-storage.test.js`、`tests/usage-runtime-storage.test.js`、`tests/auth-potluck-runtime-storage.test.js`、`tests/runtime-storage-extended.test.js` | 通过 |
| 迁移 / 校验 / 回滚 | migrate / verify / export / rollback 全链路 | migrate / verify / export / rollback 成功 | `failOnDiff=true` 抛带 `report` 的错误 | 异常文件、坏 JSON、重复/孤儿 credential、旧运行态文件映射 | `tests/runtime-storage-migration.test.js` | 通过 |
| 前端状态与交互 | `provider-manager` runtime diagnostics、`event-stream`、`usage-manager` | runtime diagnostics 渲染、reload/export/rollback action、usage refresh 成功 | usage fetch 失败、rollback 失败 toast、active section 抑制 toast | storage mode / diagnostics 条件渲染、只读态禁用、事件派发、loading 状态流转 | `tests/frontend-runtime-storage-ui.test.js` | 通过 |

### 5.0.b 路径覆盖结论

当前证据已经覆盖 `if/else`、`switch/case`、早返回、空数组/单次/多次循环、重试、降级、回滚与幂等分支：

- `provider-api` 覆盖缺参早返回、非法枚举、空字符串、超长名、UUID 冲突、404、500 与成功广播分支。
- `usage-api` 覆盖异步任务、分组/不分组、单组/多组、非正数 override 忽略、超界 `groupSize` 钳制。
- `runtime-storage-registry` 覆盖初始化 fallback、操作期 fallback、fallback retry 失败、禁用 fallback、secondary write 不触发降级。
- `runtime-storage-migration-service` 覆盖 migrate / verify / export / rollback 四段链路与 `failOnDiff=true` 阻断分支。
- `ProviderPoolManager`、`DualWriteRuntimeStorage`、`SqliteCliClient`、`SqliteRuntimeStorage` 分别覆盖刷新重试、主写/次写分流、锁冲突重试、事务/批量 SQL 路径。

因此针对当前 runtime storage 改造范围，`5.0.b` 可以判定为 **已完成**。

### 5.0.c 输入验证结论

当前显式输入验证已覆盖：

- `undefined` / `null` / 空字符串：缺失 `providerType` / `providerConfig`、空白 `ssoTokens`、空 `customName`、空 compat snapshot、空 usage cache。
- 超长字符串：`customName.length > 255` 被拒绝。
- 非法枚举值：不符合约束的 `providerType` 直接 `400`。
- 非法 JSON / 脏数据：migration 中损坏 credential JSON、mapper 中脏 `config_json`、sqlite CLI JSON parse fail-fast。
- 负数 / `0` / 超界 limit：`usage-api` 对 `concurrency=0`、`groupSize=0`、`groupMinPoolSize=-1` 做忽略，对超大 `groupSize` 做上界钳制。
- UUID 规则：本项目保留 legacy `grok-1` / `gemini-1` 这类非 RFC UUID 路由键，因此这里不做格式拒绝，而是按“未知 UUID / 冲突 UUID”分支验证，避免把历史数据误判成非法输入。
- Email 规则：credential email 在当前模型里是可选元数据，不作为强拒绝条件；现有映射验证保证缺失或脏 email 不会打崩 dedupe / compat snapshot 链路。

因此 `5.0.c` 按当前项目的输入语义可以判定为 **已完成**。

### 5.0.d 异常处理结论

当前异常处理证据已覆盖：

- repository 抛错 / 事务提交失败：`SqliteRuntimeStorage` DAO `exec()` 失败会原样上抛，不伪装成功。
- 序列化失败：Potluck store 循环引用触发 `JSON.stringify()` 失败并 fail-fast。
- 文件解析失败：migration 对坏 JSON credential / 脏旧文件样本做 inventory + anomaly 记录；sqlite CLI query JSON parse 失败立即返回 `SQLITE_JSON_PARSE`。
- 数据库锁冲突 / 外部依赖超时：`SQLITE_BUSY`、`ETIMEDOUT` 被统一归类为 `lock_conflict`，并验证 retry / fallback 策略。
- 降级路径：DB 初始化失败、操作期写失败、fallback retry 失败、secondary write 失败与 runtime diagnostics 全部有结构化断言。
- 日志与诊断：`provider-api` 持久化失败返回 `traceId`、`runtimeStorage`、`runtimeStorageError`；`runtime-storage-error` 保留底层 `backendErrorCode`。

因此 `5.0.d` 可以判定为 **已完成**。

### 5.0.e 数据映射结论

当前映射证据已覆盖以下闭环：

- legacy Provider 记录 -> registration / runtime / inline secret / credential binding 拆分。
- `provider_id` 稳定、`uuid` 可变；运行时字段变化不会改稳定主键。
- migration 导入后的 normalized tables -> compat snapshot -> `provider-api` / `download-all` 导出读回一致字段。
- 时间字段、布尔字段、默认值、数值类型转换：`lastErrorTime`、`lastHealthCheckTime`、`isHealthy`、`isDisabled`、`usageCount`、`errorCount`、`refreshCount` 均有断言。
- `usage-cache.json`、`token-store.json`、`api-potluck-data.json`、`api-potluck-keys.json` 在 migrate / export 后逐字段回放一致。

因此 `5.0.e` 可以判定为 **已完成**。

### 5.0.f DAO / Repository 结论

当前 sqlite3-cli 方案的 DAO / executor 单元测试仍保持：

- fake executor / mocked spawn，不拿真实 sqlite 集成测试冒充单元测试；
- SQL 片段、绑定参数、事务边界、字符转义、空结果集、聚合逻辑、序列化失败均有断言。

因此 `5.0.f` 保持 **已完成**。

### 5.0.g 前端单元测试结论

当前前端基线已经补齐，不再是“截图式快照测试”：

- `buildRuntimeStorageDiagnosticsViewModel()` 覆盖 storage mode / source of truth / alert / readOnly / suggested runId。
- `renderRuntimeStorageDiagnostics()` 覆盖条件渲染、禁用态、错误提示、loading dataset。
- `executeRuntimeStorageReloadAction()` / `executeRuntimeStorageExportAction()` / `executeRuntimeStorageRollbackAction()` 覆盖事件触发、状态流转、toast 与失败路径。
- `event-stream` 覆盖 provider/config/usage 事件分发与条件提示。
- `usage-manager` 覆盖 loading、error banner、active section 行为与按钮禁用态。

因此 `5.0.g` 可以判定为 **已完成**。

## 本轮复测命令与结果

### 命令 1：新增缺口定向回归

```bash
npx jest --runInBand \
  tests/provider-api-runtime-storage.test.js \
  tests/provider-storage-mapper.test.js \
  tests/sqlite-runtime-storage-dao.test.js \
  tests/runtime-storage-registry.test.js \
  tests/usage-api.test.js \
  tests/frontend-runtime-storage-ui.test.js
```

结果：

- `6` 个 test suites 全部通过。
- `56` 个 tests 全部通过。
- 总耗时约 `3.86s`。

### 命令 2：5.0 全套回归

```bash
npx jest --runInBand \
  tests/runtime-storage-error.test.js \
  tests/provider-pool-manager.test.js \
  tests/runtime-storage.test.js \
  tests/dual-write-runtime-storage.test.js \
  tests/provider-api-runtime-storage.test.js \
  tests/usage-runtime-storage.test.js \
  tests/auth-potluck-runtime-storage.test.js \
  tests/config-manager-runtime-storage.test.js \
  tests/config-reload-runtime-storage.test.js \
  tests/runtime-storage-extended.test.js \
  tests/runtime-storage-migration.test.js \
  tests/runtime-storage-registry.test.js \
  tests/sqlite-cli-client.test.js \
  tests/sqlite-runtime-storage-dao.test.js \
  tests/provider-storage-mapper.test.js \
  tests/usage-api.test.js \
  tests/frontend-runtime-storage-ui.test.js
```

结果：

- `17` 个 test suites 全部通过。
- `106` 个 tests 全部通过。
- 总耗时约 `5.55s`。

### 说明：未纳入本轮门槛的测试

- `tests/api-integration.test.js` 仍依赖外部 HTTP 服务，本轮 `5.0` 判定只看仓库内可自给自足的单元 / 轻集成 / 前端逻辑测试。

## 结论

当前 `5.0.a ~ 5.0.g` 已具备明确测试入口、可复现结果与覆盖说明，因此 `5.0` 可以判定为 **已完成**。

注意：这不代表 `5.1+` 自动完成。Provider 闭环回放、更多 DAO 查询构造器、并发压力与高频写入窗口验证仍然是后续任务，不要脑补过头。

## 5.5 并发写入验证

本轮补的是 `tasks.md` 中 `5.5.a ~ 5.5.e`，重点不是嘴上说“并发可用”，而是把 flush 队列、SQLite 串行执行、跨域持久化写入和最后写入语义都打成可复现测试。

### 覆盖点

- `5.5.a`：`tests/provider-pool-manager.test.js` 新增“flush 进行中再次 mutation”场景，验证首批 flush 不会吞掉新变更，`follow_up` flush 会补齐最新状态。
- `5.5.b`：`tests/runtime-storage-extended.test.js` 新增 usage / session / potluck 并发写入集成验证；`tests/sqlite-cli-client.test.js` 新增多 client 同 DB 路径 FIFO 串行验证。
- `5.5.c`：同一 token / usage snapshot / potluck full-store 重放后记录数不增殖；重叠 flush 调用不会重复提交首批 batch。
- `5.5.d`：`tests/provider-pool-manager.test.js` 使用 fake timers 验证空队列返回、in-flight flush、follow-up flush 与 debounce/merge 边界。
- `5.5.e`：跨域 replacement / upsert 明确采用“最后写入胜出”语义；Provider runtime mutation 在 follow-up flush 中带出最新 `isDisabled` 状态，而不是靠竞态蒙对。

### 本轮复测命令与结果

#### 命令 1：5.5 定向回归

```bash
npx jest --runInBand \
  tests/provider-pool-manager.test.js \
  tests/runtime-storage-extended.test.js \
  tests/sqlite-cli-client.test.js
```

结果：

- `3` 个 test suites 全部通过。
- `29` 个 tests 全部通过。

#### 命令 2：并发相关相邻回归

```bash
npx jest --runInBand \
  tests/provider-pool-manager.test.js \
  tests/runtime-storage-extended.test.js \
  tests/sqlite-cli-client.test.js \
  tests/dual-write-runtime-storage.test.js \
  tests/runtime-storage.test.js
```

结果：

- `5` 个 test suites 全部通过。
- `40` 个 tests 全部通过。

### 结论

当前 `5.5.a ~ 5.5.e` 已具备明确测试入口、并发边界断言和复测结果，因此 `5.5` 可以判定为 **已完成**。

## 5.1 Provider 池 CRUD / UUID / Quick Link / Batch Import 收尾回归

这轮不是重复跑一遍 happy path，而是把 `5.1.i`、`5.1.j`、`5.1.l` 剩下那些最容易嘴硬装完成的空洞补齐。

### 本轮新增验证点

- `provider-api` 新增分页与排序回归：`/api/providers/:type?page=2&limit=2&sort=asc` 只返回期望切片，但 `totalCount` / `healthyCount` / `usageCount` 仍按全集合统计。
- Grok batch import 新增上限校验：支持通过 `GROK_BATCH_IMPORT_LIMIT` 控制阈值，超限请求直接 `400`，避免一次性把批量导入玩成自杀。
- batch import 持久化失败新增回归：fallback 关闭时应返回错误，且旧 compat snapshot 不被污染。
- dual-write secondary write 失败新增回归：错误需通过 `provider-api` diagnostics 暴露，且不得误触发 file fallback。
- sqlite provider replace 写失败新增回归：底层写入失败后旧 provider snapshot 仍可完整读回。
- `listCredentialAssets()` 新增 `sort/filter/pagination` DAO 单元测试，覆盖 SQL 构造、敏感字符转义、空结果集与 provider 过滤。

### 本轮复测命令

```bash
npx jest --runInBand \
  tests/provider-api-runtime-storage.test.js \
  tests/provider-api.test.js \
  tests/runtime-storage.test.js \
  tests/sqlite-runtime-storage-dao.test.js \
  tests/dual-write-runtime-storage.test.js

npx jest --runInBand \
  tests/provider-api-supertest-runtime-storage.test.js \
  tests/provider-pool-manager.test.js \
  tests/runtime-storage-extended.test.js \
  tests/provider-storage-mapper.test.js \
  tests/runtime-storage-registry.test.js
```

结果：

- 第一组 `5` 个 test suites、`51` 个 tests 全部通过。
- 第二组 `5` 个 test suites、`39` 个 tests 全部通过。
- 合计本轮追加回归 `10` 个 test suites、`90` 个 tests 全部通过。

### 收尾结论

- `5.1.i` 已完成：空名称、超长名称、非法 `providerType`、UUID 冲突、重复 token / credential、无效 batch payload、分页边界和批量导入上限均已有显式断言。
- `5.1.j` 已完成：单条写入失败、batch import 持久化失败、sqlite replace 写失败、广播失败、dual-write 次写失败、DB 不可用错误暴露与 flush 重试调度均已有回归。
- `5.1.l` 已完成：Provider 相关 DAO 单测已覆盖 `sort=asc|desc`、filter/pagination、敏感字符转义、空结果集与 compat snapshot 行投影。

所以别再假装 `5.1` 还差半口气了，这一项现在可以判定为 **已完成**。

## 5.6 大池性能边界验证

这轮补的是 `tasks.md` 中 `5.6.a ~ 5.6.d`，重点不是拿一组小数据装作压测过，而是把分页导出 / 恢复页大小、十万级选点热路径和大池边界样本都固化成可复现测试。

### 本轮实现补强

- `src/storage/backends/sqlite-runtime-storage.js` 现在真正接入 `RUNTIME_STORAGE_COMPAT_EXPORT_PAGE_SIZE` 与 `RUNTIME_STORAGE_STARTUP_RESTORE_PAGE_SIZE`，不再只是把配置摆在诊断里当摆设。
- compat export 从“一次性全表拉平”改成按 provider page 分段读取：先查 `COUNT(*)`，再按 `LIMIT/OFFSET` 读取 provider rows，并按当前页 `provider_id` 拉取 secret / credential 关联数据。
- startup / reload 读取 `loadProviderPoolsSnapshot()` 默认走 restore page size，确保恢复路径和 compat export 使用不同的分页窗口。
- `tests/runtime-storage-large-pool.test.js` 新增大池边界用例，覆盖 `0`、`1`、`1000`、`1001`、`2001`、`100000` provider，以及重复 credential / orphan 异常记录混入场景。

### 本轮复测命令

```bash
npm test -- --runTestsByPath \
  tests/runtime-storage-large-pool.test.js \
  tests/sqlite-runtime-storage-dao.test.js \
  tests/provider-pool-manager.test.js \
  tests/runtime-storage.test.js
```

结果：

- `4` 个 test suites 全部通过。
- `45` 个 tests 全部通过。
- Jest 总耗时约 `2.35s`。

### 5.6.a 选点 / 分页查询 / compat snapshot

- `tests/runtime-storage-large-pool.test.js` 验证 `ProviderPoolManager.selectProvider()` 在 `100000` provider 池下走分组热路径：首组 `100` 个节点全部不健康时，会跳到下一组选择 `grok-000100`，并推进 `_groupCursor` 到下一组。
- 同文件验证 compat export 在 `1000` / `1001` 边界下分别产生 `1` 页 / `2` 页 provider 查询，确保分页不是嘴上说说。
- `tests/sqlite-runtime-storage-dao.test.js` 追加 SQL 断言：默认 compat export 首批 provider 查询包含 `LIMIT 1000 OFFSET 0`，并按页限定 `provider_id IN (...)` 拉取 secret / credential。

### 5.6.b 批量 flush / 恢复加载 / 分段预热边界

- `tests/provider-pool-manager.test.js` 现有 flush 分批回归继续验证 runtime flush 会按 `batchSize` 切批提交，不会退回逐条 durable commit。
- `tests/runtime-storage-large-pool.test.js` 验证 `loadProviderPoolsSnapshot()` 在 `2001` provider 边界下按 restore page size 走两页查询：`LIMIT 2000 OFFSET 0` 与 `LIMIT 2000 OFFSET 2000`。
- `SqliteRuntimeStorage.getInfo()` 现已暴露 `compatExportPageSize` / `startupRestorePageSize`，便于运行时诊断恢复窗口配置。

### 5.6.c compat export 时间 / 内存窗口

- `tests/runtime-storage-large-pool.test.js` 使用 mocked paged query 构造 `100000` provider compat export 场景，断言最终仅产生 `100` 轮 provider page 查询、`100` 轮 secret 查询和 `100` 轮 credential 查询。
- 同一用例要求导出在宽松 `10s` 窗口内完成；本轮回归通过，说明分页实现至少把单次查询峰值和 query fan-out 控制在设计目标线内。
- 当前 compat export 仍会把最终 compat snapshot 全量组装进内存，这符合“导出 durable 快照”职责边界，但也意味着十万级导出仍以总输出体积为上限，不会神奇变成零内存。

### 5.6.d 边界样本结论

- `0` / `1` / `1000` / `1001`：已通过分页边界回归。
- `2001`：已通过 startup restore page size 回归。
- `100000` provider：已通过 compat export 和 grouped selection 热路径回归。
- 重复 credential：同一 provider 返回多条 credential binding 时，compat snapshot 仍按第一条有效路径输出，不会把重复记录炸成多份 provider。
- 异常记录混入：orphan secret / credential row 在没有匹配 provider registration 时会被 compat snapshot 忽略，不会污染正常导出结果。

### 结论

当前 `5.6.a ~ 5.6.d` 已具备实现落点、测试入口、边界样本与复测结果，因此 `5.6` 可以判定为 **已完成**。