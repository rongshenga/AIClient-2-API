# 5.4 SQLite CLI 性能验证记录

## 执行时间

- 本轮基准执行时间：2026-03-06 18:49:17（Asia/Shanghai）
- Benchmark JSON `generatedAt`：`2026-03-06T10:49:17.592Z`

## 执行命令

```bash
npm run runtime-storage:benchmark -- \
  --config configs/config.json \
  --output-file /tmp/runtime-storage-benchmark.json
```

等价命令：

```bash
node src/scripts/runtime-storage-admin.js benchmark \
  --config configs/config.json \
  --output-file /tmp/runtime-storage-benchmark.json
```

## Benchmark 环境

- Node.js：`v20.20.0`
- 平台：`darwin arm64`
- CPU 核数：`10`
- SQLite CLI：`sqlite3 3.43.2`
- 临时数据库：benchmark 使用临时目录与临时 sqlite 文件，不污染生产库

## 连接生命周期策略（5.4.a）

当前 SQLite CLI 后端策略如下：

- 每次 `exec` / `query` 启动一个短生命周期 `sqlite3` 进程
- 同一 `dbPath` 共享 FIFO 串行队列，避免并发 `database is locked (5)`
- DAO 层将同一批 flush SQL 合并成单个 `BEGIN IMMEDIATE; ... COMMIT;` payload
- 底层 busy retry 采用 `busyTimeoutMs=5000`、`maxRetryAttempts=2`、`retryDelayMs=75`

实测启动开销：

- `exec` 启动 `p95 = 5.612ms`，`p99 = 5.651ms`
- `query` 启动 `p95 = 5.124ms`，`p99 = 5.148ms`

结论：当前 `sqlite3` CLI 启动成本处于可接受区间，尚未逼近设计里需要升级驱动的告警线。

## 批量 SQL / flush 频率窗口（5.4.b）

基于默认 flush 策略：

- 防抖窗口：`1000ms`
- dirty threshold：`64`
- 单批次 flush 上限：`200`

实测结果：

| 场景 | batch size | measured exec calls | expected exec calls | p95 | flush window utilization | 估算吞吐 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| single runtime flush | 1 | 20 | 20 | 7.756ms | 0.78% | 128.93 flush/s |
| dirty threshold flush | 64 | 12 | 12 | 8.867ms | 0.89% | 8504.98 providers/s（avg） |
| full batch flush | 200 | 8 | 8 | 11.811ms | 1.18% | 18068.48 providers/s（avg） |

补充说明：

- benchmark 默认包含 `3` 次 warmup；评估时已显式扣除 warmup 对 `topLevelExecCalls` 的影响，避免把预热误判为调用放大
- `measuredExecCalls == expectedExecCalls`，说明 DAO 批量 SQL 没有在 executor 层被拆成多次顶层调用
- `200` 条批量 flush 的 `p95` 仅占 `1000ms` flush 窗口的 `1.18%`，距离需要升级驱动的风险线还很远

## 结论与瓶颈（5.4.c）

结论：**当前阶段继续使用 `sqlite3` CLI 是可接受的，不需要立刻升级为长驻 worker 或 native driver。**

原因：

- CLI 启动 `p95` 约 `5ms`，没有把单次 flush 的总时延拖到不可接受水平
- `64` / `200` 条事务 flush 都维持单次顶层 exec，不存在批量 SQL 被错误拆包的现象
- 最重的 `200` 条 batch `p95` 为 `11.811ms`，距离 `1000ms` debounce window 仍有充足余量

需要继续盯的指标：

- 若未来 `exec/query startup p95 > 25ms`，说明短生命周期进程模型开始明显拖后腿
- 若大批量 flush 持续接近 debounce window 的 `50%`，就该严肃评估长驻 worker
- 若大批量 flush 超过单个 flush window，或者出现真实吞吐场景下的队列堆积，再考虑迁移到 native driver / worker 进程

## 单元测试 / 回归覆盖（5.4.e）

已补齐并验证以下回归点：

- `tests/sqlite-cli-client.test.js`
  - 批量事务 SQL 仅触发一次 `sqlite3` spawn
  - retry 次数受 `maxRetryAttempts` 上限约束，不会无限放大进程调用
  - 同一 `dbPath` 多实例共享串行队列
- `tests/sqlite-runtime-storage-dao.test.js`
  - 空批次 `flushProviderRuntimeState([])` 跳过 `exec`
  - 多条 runtime flush 合并为单个事务 `exec`
  - DAO 层单次失败不会额外放大顶层 `exec` 调用
- `tests/runtime-storage-benchmark.test.js`
  - warmup 调用不会被误判成 flush batching 放大
  - measured exec calls 超过 expected rounds 时会正确标记 `inspect_flush_batching`

## 建议

- 5.4 在当前机器与默认参数下可以判定完成
- 真正需要继续深挖的，是 5.6 的十万级大池性能边界与 5.7 的 crash recovery，而不是继续对着 5ms 级别的 CLI 启动开销表演焦虑
