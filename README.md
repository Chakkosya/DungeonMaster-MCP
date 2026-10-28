# DungeonMaster MCP

面向现有 QQ 群 AI 的 D&D 跑团 MCP 服务。QQ 群 AI 负责聊天和叙事，本服务通过远程 Streamable HTTP MCP 提供世界、玩家、角色、行动、骰子、战斗和存档的权威状态。Web 后台供服务器管理员配置 API Key 与查看运行情况。

## 组成

| 组件 | 职责 |
| --- | --- |
| `src/server.ts` | Fastify 管理 API、Web 静态页面、MCP 入口 |
| `src/mcp.ts` | 官方 TypeScript MCP SDK v2 的 Tools 与 Prompt |
| `src/game.ts`、`src/combat.ts` | 群世界、角色、行动、战斗与存档 |
| `src/worker.ts` | 自动存档、每日数据库备份与清理 |
| `sql/001_init.sql` | PostgreSQL 表、约束与索引 |
| `admin/` | React 管理页面 |
| `compose.yaml`、`Caddyfile` | PostgreSQL、服务端、Worker 与 HTTPS 入口 |

实时游戏状态保存在 PostgreSQL。每次成功的游戏操作在事务中提交；自动存档是独立的压缩历史检查点，每世界最多三份。手动存档每世界最多五份。
数据访问使用 `pg` 的参数化 SQL；世界锁、请求幂等、存档轮换和配额判断集中在 PostgreSQL 事务内。`backup_records` 同时记录备份任务状态与重试次数。

## 部署

Linux 服务器安装 Docker、Docker Compose 和 OpenSSL，准备指向服务器的域名，开放 80/443 端口。Compose 从 GHCR 拉取公开镜像 `ghcr.io/chakkosya/dungeonmaster-mcp:latest`；可先运行 `docker pull ghcr.io/chakkosya/dungeonmaster-mcp:latest` 检查访问。执行：

```sh
chmod +x deploy.sh update.sh backup.sh verify-backup.sh restore.sh logs.sh uninstall.sh
./deploy.sh
```

脚本会询问域名与管理员用户名，生成数据库密码和初始管理员密码，拉取镜像并启动服务。初始密码只在首次部署输出中显示，配置保存在权限受限的 `.env`。后台地址为 `https://域名/admin/`，MCP 地址为 `https://域名/mcp`。填 `localhost` 可在本机测试；Caddy 本地证书需要在测试机信任。健康检查为 `/healthz`，数据库就绪检查为 `/readyz`。

Compose 持久卷保存 PostgreSQL、Worker 备份和 Caddy 证书。`docker compose down` 保留数据。日常命令：

```sh
./update.sh
./backup.sh
./verify-backup.sh backups/dnd-文件.dump
./restore.sh backups/dnd-文件.dump
./logs.sh server
./uninstall.sh
```

`./uninstall.sh` 默认保留卷；`./uninstall.sh --delete-data` 需要输入确认语句。`restore.sh` 会覆盖当前数据库，也需要明确确认。

## 本地开发

Node.js 24、PostgreSQL 17：

```sh
npm ci
cd admin && npm ci && npm run build && cd ..
cp .env.example .env
# 调整 DATABASE_URL、ADMIN_USERNAME、ADMIN_PASSWORD、PUBLIC_URL
npm run build
npm run migrate
npm start
```

Worker 单独运行：`npm run worker`。测试：`npm test`。`ADMIN_PASSWORD` 首次初始化时至少 16 位。服务启动后，管理员在后台创建绑定 QQ 群的 MCP API Key。MCP 不需要额外的模型 API Key。

## QQ 群 AI 接入契约

现有 QQ AI 的 MCP 客户端需要支持远程 Streamable HTTP、Bearer 请求头，并由可信接入层在**每一次** MCP HTTP 请求中注入下列请求头：

| 请求头 | 内容 |
| --- | --- |
| `Authorization` | `Bearer dnd_...` |
| `X-QQ-Group-Id` | 消息所在 QQ 群的稳定 ID |
| `X-QQ-User-Id` | 真实发言人的稳定 QQ ID |
| `X-QQ-Message-Id` | QQ 消息唯一 ID |
| `X-QQ-Message-Time` | 可解析的消息时间，例如 ISO 8601 |
| `X-Request-Id` | 此次工具操作唯一 ID，重试时沿用 |

这些值必须来自 QQ 平台事件或受信任的接入层，不得由聊天文本或模型工具参数指定。MCP Key 代表机器人权限，QQ 发言人身份代表玩家权限，两层验证分别执行。Key 还须在后台绑定目标 QQ 群。若现有客户端只能由模型填写参数、不能注入可信发言人请求头，无法安全执行玩家角色、房主或存档操作；需在已有 QQ AI 的 MCP 接入层补齐上述字段。服务端不会自行读取 QQ 消息。

一个群可创建多个世界，房主通过 `select_active_world` 切换活跃世界。玩家各自使用真实 QQ 身份调用 `join_world` 后直接加入，无需房主批准，再调用 `create_character`、`set_player_ready`。战斗进行中暂不能加入。`leave_world` 将玩家标记为离线并保留角色和名额，重新调用 `join_world` 可回到原角色；房主移除成员会释放名额。2–10 人全部准备后房主调用 `start_campaign`。`get_group_context` 和 `get_recent_events` 可在 QQ AI 重启后恢复进度。

MCP 工具只返回数据，不向 QQ 群发消息。群内发布内容由 QQ AI 决定。`get_dm_story_context` 返回 DM 私有资料，不能原样转发到群聊。

### 权限

| 权限 | 主要用途 |
| --- | --- |
| `read` | 查看授权群的世界、角色、事件和公开剧情 |
| `world` | 创建世界 |
| `game` | 玩家加入、创建角色、提交行动、掷骰、战斗动作 |
| `dm` | 裁定行动、推进场景、保存与读取 DM 剧情、管理战斗 |
| `save` | 创建手动和自动存档 |
| `owner` | 与可信房主 QQ 身份共同授权房主操作 |

后台创建密钥时完整值只返回一次；数据库只保存校验摘要。停用或撤销后，新 MCP 请求立即被拒绝。后台可查看世界与成员、创建自动存档、管理手动存档、归档或恢复世界，以及清理回收站。后台采用独立登录 Session、HttpOnly Cookie、CSRF 请求头和登录限速。

## MCP Tools

基础：`get_server_info`、`get_dm_instructions`、`get_group_context`。

世界与成员：`create_world`、`list_worlds`、`get_world`、`update_world_settings`、`select_active_world`、`archive_world`、`resume_world`、`join_world`、`leave_world`、`list_players`、`transfer_world_owner`、`remove_player`、`set_player_ready`、`start_campaign`。

建团与角色：`start_session_zero`、`submit_world_preference`、`get_session_zero_status`、`finalize_world_config`、`create_character`、`get_character`、`list_characters`、`update_character`、`award_experience`、`grant_item`、`level_up_character`、`finish_long_rest`。

剧情与行动：`save_story_outline`、`update_story_outline`、`get_dm_story_context`、`get_public_story_context`、`get_current_scene`、`advance_scene`、`manage_npc`、`manage_quest`、`generate_ending_context`、`submit_action`、`get_pending_actions`、`resolve_action`、`get_recent_events`。

骰子与战斗：`roll_dice`、`start_combat`、`get_combat_state`、`submit_combat_action`、`cast_spell`、`death_save`、`use_item`、`end_turn`、`end_combat`。`cast_spell` 当前结算火焰箭（`fire_bolt`，戏法位填 `0`）、魔法飞弹（`magic_missile`）和疗伤术（`cure_wounds`）；目标使用战斗状态中的单位 ID，施法消耗本回合动作和相应法术位。DM 可调用 `finish_long_rest` 恢复符合休息条件的角色生命值与法术位。

存档与迁移：`get_current_save`、`list_save_versions`、`get_autosave_status`、`create_manual_save`、`create_autosave`、`request_restore_save`、`restore_save`、`list_world_branches`、`create_branch_from_save`、`switch_world_branch`、`request_delete_branch`、`confirm_delete_branch`、`get_storage_status`、`get_backup_status`、`request_delete_save`、`confirm_delete_save`、`recover_deleted_save`、`preview_cleanup`、`request_cleanup_save`、`cleanup_saves`、`request_delete_world`、`delete_world`、`recover_deleted_world`、`request_purge_world`、`purge_deleted_world`、`export_world`、`read_world_export_chunk`、`begin_world_import`、`upload_world_import_chunk`、`import_world`。

`dm_guide` 是 MCP Prompt；不能加载 Prompt 的客户端可调用 `get_dm_instructions`。`dnd://dm-guide` 与 `dnd://group-context` 是只读 MCP Resources。

## 存档与备份

Worker 每分钟检查一次自动存档条件：五次重要行动、发生变化满五分钟、战斗结束或 `advance_scene` 标注新章节/重大节点。新自动存档在数据库事务中写入和解压验证，然后淘汰最旧版本。当前状态始终独立持久化。单个世界的有效存档压缩数据默认限制为 200 MB。

`restore_save` 需要先调用 `request_restore_save`，再由可信房主提交十分钟有效的确认令牌；它会覆盖当前世界状态。删除手动存档和世界也采用请求、确认两步。手动存档删除后可在七天内恢复。每世界回收站默认最多十份、100 MB，可通过 `preview_cleanup` 查看，房主用 `request_cleanup_save`、`cleanup_saves` 永久清理；管理员也可在后台清理。每日数据库备份由 Worker 存入 Docker `backups` 卷，保留七份；后台可发起手动备份，保留最近十份。独立的主机备份使用 `./backup.sh`，可用 `./restore.sh` 恢复。请把备份文件或备份卷同步到其他机器或对象存储；与数据库同机的卷无法抵御整机磁盘损坏。

`create_branch_from_save` 会先保存当前活动分支，再从目标存档创建并切换到新分支；`switch_world_branch` 在切换前保存当前分支。每世界最多三个分支，非活动分支的压缩数据计入世界与服务器配额。删除非活动分支需要确认令牌。

世界当前状态可通过 MCP 分块导出、导入。房主调用 `export_world`，按返回的分块数量调用 `read_world_export_chunk` 并顺序保存 Base64 数据。导入时调用 `begin_world_import`、逐块调用 `upload_world_import_chunk`，最后调用 `import_world`。导入操作由源世界房主的同一 QQ ID 执行，生成新的世界 ID；导出和导入会话一小时后过期。

管理员可在「设置」中调整每世界存档容量、服务器存档容量、手动存档数、回收站容量与数量、Worker 备份容量和备份保留数。自动存档始终为三份。Worker 达到备份容量上限时先删除最旧的备份，并始终保留最近一次成功备份。

## SRD 许可

当前数值规则使用 SRD 5.1，包含角色升级经验门槛、熟练加值、职业生命骰的固定生命值增长、职业法术位表，以及火焰箭、魔法飞弹和疗伤术的战斗结算。

This work includes material taken from the System Reference Document 5.1 (“SRD 5.1”) by Wizards of the Coast LLC and available at https://dnd.wizards.com/resources/systems-reference-document. The SRD 5.1 is licensed under the Creative Commons Attribution 4.0 International License available at https://creativecommons.org/licenses/by/4.0/legalcode.

## 已知问题

- 当前规则实现覆盖角色基础数值约束、经验值升级、骰子、先攻、单次攻击、生命值、临时生命值、死亡豁免、治疗药水、三种法术和回合动作经济。其他职业特性、法术、状态效果、位置与施法距离、法术材料和其他道具尚未数值结算；这些规则的文字裁定不应视为服务端数值结算。
- `restore_save` 采用覆盖当前分支；需要保留当前进度时应使用 `create_branch_from_save`。分块世界迁移包含当前状态、成员、角色、剧情和战斗状态；历史存档、分支与事件历史需使用数据库备份迁移。
- 当前剧情摘要由 AI DM 在推进章节时写入。世界已有摘要时，Worker 会裁剪超过一万条且超过九十天的事件，并清理超过九十天的已结算行动和对应骰子明细。没有剧情摘要的世界仍需监控 PostgreSQL 占用。
- 尚未在真实 Docker 主机上验证 Compose 启动、HTTPS 证书签发及数据库备份恢复。
