# Runtime Storage Migration

## Default Auth Authority

- 默认 `RUNTIME_STORAGE_BACKEND=db`
- 默认 `AUTH_STORAGE_MODE=db_only`
- 在 `db_only` 下，`configs/pwd` 与 `configs/token-store.json` 不再作为运行时权威读写源
- 文件权威仅用于一次性迁移与兼容回滚工单

## Startup Auto Migration (db_only)

当满足以下条件时，启动阶段会自动执行迁移：

- `AUTH_STORAGE_MODE=db_only`
- `RUNTIME_STORAGE_BACKEND=db`
- 检测到 legacy auth 源（`pwd`、token-store、credential source）且尚未写入 auth 迁移标记

迁移步骤：

1. 导入 provider/credential/runtime 基础域
2. 导入 auth 权威：`runtime_settings(auth_password/admin)` 与 `credential_secret_blobs`
3. 执行校验；失败即 fail-fast，阻止服务继续启动

## CLI

统一入口：

```bash
pnpm run runtime-storage:admin -- <command>
```

常用命令：

- `migrate`
- `verify`
- `verify-auth`
- `export-legacy`
- `rollback`
- `rollback-auth`
- `list-runs`
- `show-run`

推荐流程：

```bash
pnpm run runtime-storage:admin -- migrate
pnpm run runtime-storage:admin -- migrate --execute
pnpm run runtime-storage:admin -- verify --fail-on-diff
pnpm run runtime-storage:admin -- verify-auth
```
