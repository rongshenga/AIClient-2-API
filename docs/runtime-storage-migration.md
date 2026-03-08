# Runtime Storage 迁移运维说明

## 适用范围

- `provider_pools.json` 初始化导入
- `usage-cache.json` 导入与兼容导出
- `usage refresh task` 状态持久化与重启中断标记
- `token-store.json` 管理员会话导入与恢复
- `api-potluck-data.json`、`api-potluck-keys.json` 导入与兼容导出
- 迁移差异校验、回滚与灰度切换

## CLI 入口

使用统一入口：

```bash
npm run runtime-storage:admin -- <command> [options]
```

也可以直接执行：

```bash
node src/scripts/runtime-storage-admin.js <command> [options]
```

## 数据库初始化与路径

- 默认 SQLite 路径：`configs/runtime/runtime-storage.sqlite`
- 默认迁移制品目录：`configs/runtime/migrations/<runId>/`
- `migrate`、`verify`、`export-legacy`、`list-runs`、`show-run` 在访问数据库前都会自动初始化 schema；不需要额外执行单独的 `init` 命令
- 如果需要自定义路径，可通过 `configs/config.json` 中的 `RUNTIME_STORAGE_DB_PATH`、`RUNTIME_STORAGE_MIGRATION_ARTIFACT_ROOT` 覆盖，或在 CLI 上追加 `--runtime-storage-db-path`、`--artifact-root`
- 生产切换前建议先确认宿主机已安装 `sqlite3` CLI，并且数据库目录具备读写权限

## 常用命令

### 1. 迁移预演

默认 `migrate` 为 `dry-run`，不会写入数据库，只会生成迁移制品、兼容导出和差异报告。

```bash
npm run runtime-storage:admin -- migrate \
  --config configs/config.json
```

### 2. 执行迁移

```bash
npm run runtime-storage:admin -- migrate \
  --config configs/config.json \
  --execute
```

需要断点续跑或按批次演练时，可附加：

```bash
npm run runtime-storage:admin -- migrate \
  --config configs/config.json \
  --execute \
  --run-id <runId> \
  --resume \
  --step-batch-size 2
```

如果目标数据库已有旧数据，需要显式允许覆盖：

```bash
npm run runtime-storage:admin -- migrate \
  --config configs/config.json \
  --execute \
  --force
```

如果要把十万级 provider 导入压得更狠一点，可追加性能参数：

```bash
npm run runtime-storage:admin -- migrate \
  --config configs/config.json \
  --execute \
  --prepare-concurrency 8 \
  --insert-batch-size 400 \
  --progress-interval 1000
```

说明：

- `--prepare-concurrency` 用于并发预读 credential 文件；默认会按约 `80%` 逻辑 CPU 核数取值
- `--insert-batch-size` 用于控制多行 `INSERT` 的批大小；数据量很大时通常比逐条 `INSERT` 快得多
- 看到 `Provider snapshot progress: N/N` 后，如果紧接着出现 `Executing provider snapshot SQL payload`，说明已经进入 SQLite 批量写入/提交阶段，不是卡死
- 不带 `--execute` 的 `migrate` 仍是 `dry-run` 预演，只生成制品和校验报告，不写入数据库

### 3. 校验与差异报告

```bash
npm run runtime-storage:admin -- verify \
  --config configs/config.json \
  --run-id <runId> \
  --fail-on-diff
```

如需把 counts / checksum / anomaly policy 一并作为 cutover gate 强制校验，可加：

```bash
npm run runtime-storage:admin -- verify \
  --config configs/config.json \
  --run-id <runId> \
  --enforce-cutover-gate \
  --max-anomaly-count 0
```

### 4. 兼容导出

导出 `provider_pools.json`：

```bash
npm run runtime-storage:admin -- export-legacy \
  --config configs/config.json \
  --domains provider-pools \
  --output-file configs/provider_pools.exported.json
```

导出全部兼容文件：

```bash
npm run runtime-storage:admin -- export-legacy \
  --config configs/config.json \
  --domains provider-pools,usage-cache,api-potluck-data,api-potluck-keys \
  --output-dir configs/runtime/compat-export
```

说明：管理员会话迁移到 `admin_sessions` 后只保留 `token_hash` 与会话元数据，`export-legacy` 会在命令输出里给出 `adminSessions` 摘要数量，但不会重新导出原始 `token-store.json` 明文 token。

### 5. 回滚

```bash
npm run runtime-storage:admin -- rollback \
  --config configs/config.json \
  --run-id <runId>
```

如果只恢复数据库，不覆盖当前 legacy 文件：

```bash
npm run runtime-storage:admin -- rollback \
  --config configs/config.json \
  --run-id <runId> \
  --skip-legacy-files
```

### 6. SQLite CLI benchmark

```bash
npm run runtime-storage:benchmark -- \
  --config configs/config.json \
  --output-file /tmp/runtime-storage-benchmark.json
```

说明：

- benchmark 会创建临时 sqlite 文件，不会默认污染生产数据库
- 输出 JSON 包含 CLI 启动开销、单条 / 64 条 / 200 条 runtime flush 延迟、调用频率窗口和最终 assessment
- 如需保留中间制品，可追加 `--keep-artifacts`

## 迁移制品目录

默认目录：`configs/runtime/migrations/<runId>/`

- `manifest.json`：迁移元数据、源摘要、制品路径
- `source/`：迁移前 legacy 文件备份
- `before/`：迁移前 SQLite 备份（含 `-wal` / `-shm`）
- `export/`：迁移后兼容导出结果
- `reports/diff-report.json`：结构化差异报告
- `reports/diff-report.md`：面向运维的 Markdown 报告
- `reports/acceptance-summary.json`：记录数、checksum、异常摘要、cutover gate 与回滚点摘要
- `reports/acceptance-summary.md`：面向运维的验收摘要 Markdown

## 差异报告覆盖域

当前差异报告至少覆盖以下核心域：

- `providerRegistry`
- `runtimeState`
- `credentialBinding`
- `usagePlugin`

其中 `usagePlugin` 进一步包含：

- `usageCache`
- `apiPotluckData`
- `apiPotluckKeys`

## 灰度切换建议

### 阶段 A：文件权威 + 迁移预演

- `RUNTIME_STORAGE_BACKEND=file`
- `RUNTIME_STORAGE_DUAL_WRITE=false`
- 执行 `migrate` dry-run，确认差异报告为 `pass`

### 阶段 B：文件权威 + 离线迁移

- 仍保持 `RUNTIME_STORAGE_BACKEND=file`
- 执行 `migrate --execute`
- 执行 `verify --run-id <runId> --fail-on-diff`

### 阶段 C：数据库读权威 + 双写兼容

- `RUNTIME_STORAGE_BACKEND=db`
- `RUNTIME_STORAGE_DUAL_WRITE=true`
- 保留 `provider_pools.json` 作为兼容副本，不再视为权威源

### 阶段 D：数据库权威 + 显式兼容导出

- `RUNTIME_STORAGE_BACKEND=db`
- `RUNTIME_STORAGE_DUAL_WRITE=false`
- 仅在备份、校验、人工恢复时执行 `export-legacy`

## 运行时诊断与自动回退

### `RUNTIME_STORAGE_INFO` 诊断字段

数据库模式或双写模式下，当前进程会把运行时诊断信息同步到 `currentConfig.RUNTIME_STORAGE_INFO`。重点字段如下：

- `backend` / `requestedBackend` / `activeBackend`：当前请求模式、实际生效后端与最终激活后端
- `authoritativeSource`：当前权威源，取值为 `file` 或 `database`
- `dualWriteEnabled` / `fallbackEnabled`：双写与自动回退是否生效
- `featureFlagRollback`：若需要切回文件模式，建议应用的 feature flag 配置
- `crashRecovery`：固定的 durable 边界、允许丢失的未 flush 窗口，以及异常退出后的恢复语义摘要
- `lastCompatLoad` / `lastMutation` / `lastFlush` / `lastExport` / `lastValidation`：最近一次兼容快照读取、写入、flush、导出、校验的结果摘要
- `lastFallback` / `lastError`：最近一次自动回退与错误诊断信息

### Provider mutation 失败诊断

- 大多数 `provider-api` mutation 失败时会返回结构化错误对象：`message`、`code`、`phase`、`domain`、`retryable`、`traceId`。
- 响应中的 `diagnostics` 会附带 `runtimeStorage` 与 `runtimeStorageError`，便于把接口报错与底层存储失败关联起来。
- `grok_batch_import` 为保持兼容，仍返回扁平 `success: false` / `error` 结构，但同样会附带 `diagnostics`。

### 自动回退触发条件

满足以下条件时，系统会把运行态 feature flag 自动切回文件模式，并记录到 `lastFallback` 与 `featureFlagRollback`：

- 数据库后端初始化失败，且 `RUNTIME_STORAGE_FALLBACK_TO_FILE !== false`
- 数据库或 dual-write 主写路径发生 mutation / flush / export / compat read 失败，且不是 `secondary_*` 次写失败
- 迁移校验 `verify` 返回 `overallStatus !== 'pass'`，包括 compat diff 校验失败

自动回退后的进程内配置会同步改为：

- `RUNTIME_STORAGE_BACKEND='file'`
- `RUNTIME_STORAGE_DUAL_WRITE=false`

此后当前操作会在文件后端重试一次，避免因为数据库瞬时异常把 Web UI mutation 直接打挂。

如果显式设置 `RUNTIME_STORAGE_FALLBACK_TO_FILE=false`，系统不会自动降级，而是保留原始错误并通过接口/日志暴露诊断信息，适合压测或强校验阶段定位问题。
## Credential / Secret 迁移边界

- 第一阶段继续保留 `configs/<provider>/` 下的凭据原文件，作为导入来源、备份材料与人工恢复兼容层。
- 凭据索引、去重、稳定主键与绑定关系以数据库为准，不再依赖目录扫描结果直接决定绑定状态。
- `provider_pools.json` 中的内联 secret 在导入后落到 `provider_inline_secrets`，后续以数据库记录为权威源。
- 文件型凭据会拆分为 `credential_assets`、`credential_bindings` 与 `credential_file_index`，兼容导出时再投影回 legacy 路径字段。
- `service-manager auto-link` / batch import 只负责发现候选 credential 文件，实际去重和绑定写入走 runtime storage。

## 回滚流程

推荐顺序：

1. 停止服务，避免新的运行态写入。
2. 执行 `rollback --run-id <runId>`。
3. 将配置切回：
   - `RUNTIME_STORAGE_BACKEND=file`
   - `RUNTIME_STORAGE_DUAL_WRITE=false`
4. 重启服务。
5. 再执行一次 `verify` 或人工核对兼容导出文件。

## 备份恢复说明

- 每次执行迁移都会自动备份：
  - `provider_pools.json`
  - `usage-cache.json`
  - `api-potluck-data.json`
  - `api-potluck-keys.json`
  - `runtime-storage.sqlite` 与其 `-wal` / `-shm`
- 如果迁移前数据库不存在，回滚后数据库会恢复到“迁移前不存在或为空”的状态。

## 会话与插件恢复验证

### 管理员会话

- `RUNTIME_STORAGE_BACKEND=db` 时，后台登录会话写入 `admin_sessions`。
- 执行迁移命令时，旧 `configs/token-store.json` 会先基线回填到 `admin_sessions`；如果未跑迁移，首次读取会话时仍会按需懒导入数据库。
- 切到数据库权威后，`api-potluck` 管理接口也复用同一套会话校验链路，不再各自直读旧文件。

### Usage refresh task

- 异步用量刷新任务会写入 `usage_refresh_tasks`。
- 如果服务在任务运行中重启，旧 `running` 任务不会继续执行，而是会在启动时标记为 `failed`，错误信息为“任务被进程重启中断”这一类语义。
- 运维侧不要把这类任务当成“自动续跑”；需要的话重新触发刷新。

### Crash recovery durable boundary

- 只有已提交事务与已成功完成的 runtime flush batch 会成为 durable 数据。
- 允许丢失的仅限于最近一次未 flush 窗口内的 Provider 热状态增量；compat export 不会把这些内存态伪装成可恢复备份。
- 未提交写入在异常退出后会被回滚，恢复后的 `diff-report.json` / `diff-report.md` 与 `RUNTIME_STORAGE_INFO.lastValidation` 会继续暴露 durable boundary 与丢失窗口摘要。

### API Potluck 运行态

- `api-potluck` 的配置、用户凭据引用、Key 配额与用量会在插件初始化时从数据库恢复。
- 仅 `file` 后端保留 `api-potluck-data.json` 的文件热更新监听；`db` / `dual-write` 模式下数据库是权威源，不再依赖 `fs.watch`。
- 若需要验证恢复效果，建议顺序执行：创建/修改 Key → 绑定凭据 → 重启服务 → 检查 Potluck 管理端和用户端接口返回是否一致。

## 高频写入验证

迁移后应重点验证 `provider_pools.json.*.tmp` 不再持续堆积。

建议命令：

```bash
find configs \( -name 'provider_pools.json.tmp' -o -name 'provider_pools.json.*.tmp' \) | wc -l
```

灰度期间应结合以下观察：

- `provider-pool-manager` 是否仍在走旧文件写路径
- `provider-api` mutation 是否仍直接写 `provider_pools.json`
- `service-manager auto-link` 是否仍直接覆盖 legacy 文件

如果这些旧路径仍在线，迁移工具只能证明“数据库通道可用”，不能证明“热路径已完全脱离旧文件”。

## 监控建议

- 每次迁移后保存 `diff-report.json` 与 `diff-report.md`
- 监控 SQLite 文件大小变化：`configs/runtime/runtime-storage.sqlite`
- 监控遗留临时文件数量：`provider_pools.json.*.tmp`
- 监控 `storage_migration_runs` 最近状态，避免 `failed` 长时间未处理

列出迁移记录：

```bash
npm run runtime-storage:admin -- list-runs --config configs/config.json
```

查看单次迁移详情：

```bash
npm run runtime-storage:admin -- show-run --config configs/config.json --run-id <runId>
```

## 已知边界

- 本工具负责旧文件与数据库之间的可验证迁移通道。
- `usage_refresh_tasks` 只保证状态可见与中断可追踪，不保证跨重启续跑。
- 本工具不替代运行时热路径改造。
- 如果 `provider-api`、`ProviderPoolManager`、`service-manager auto-link` 仍直写旧文件，需由对应子任务继续收口。
