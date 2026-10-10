# Catty 服务器管理 Agent — 总体开发计划

Decision note: `../notes/proposed/architecture/2026-10-10-catty-server-ops-agent.md`
Branch: `feat/catty-server-management` (from `catty-main`)
Started: 2026-10-10

This is a long, staged change. Each phase is independently reviewable and leaves the tree
green; the plan document is the only thing that tracks the whole arc.

## 目标

把 Catty 从"Netcatty 全能助手"重写为**个人服务器管理 agent**：纯交互式、无常驻无定时，
以"计划 → 一次批准 → 执行 → 验证 → 结论+证据"为主循环，工具面从 73 个收敛到 ~20 个，
管理面（vault 库存 CRUD）移出，仅保留可编辑的主机备注作为跨会话机器档案。

## 分支与节奏

- 长期分支 `feat/catty-server-management`，按 phase 提交，增量推送。
- 每个 phase 结束必须通过：`node --test --import tsx <相关测试>`、`npx eslint <改动文件>`、
  `npm run generate:capability-tools && git diff --exit-code .../cattyToolSpecs.json`（涉及工具面时）。
- Phase 间不合并到 `catty-main`，全部完成后由 owner 决定合并或走 PR。

## 阶段总览

| Phase | 内容 | 为什么这个顺序 |
|---|---|---|
| 1 | 计划-审批-执行循环（新事件 + plan gate + `submit_plan` 工具 + UI） | 用户选择的地基；没有它，后面的批量/档案都挂在旧的逐条审批上 |
| 2 | 工具面收敛 + 提示词重写（catalog 分层、删 legacy executor、MCP/CLI 不变） | 角色落地；同时把"成本/选择噪声"问题一次解决 |
| 3 | 跨机协调（batch / compare）+ 跨会话写锁 | 依赖 1 的计划语义（批量的每台结果进计划）与 2 的工具面 |
| 4 | 机器档案（host notes 结构化 + 跨会话注入 + 脱敏） | 依赖 2 中保留的 `host_notes_*` 口径 |
| 5 | skill + runbook 双层、后备通道预检、收尾（note → implemented） | 前四层就位后，巡检与安全预检才有落点 |

## Phase 1 — 计划-审批-执行

目标：主交互从"每个写工具弹一次审批"变为"模型提交计划 → 用户批准一次 → 执行"；偏离计划时停下询问；Observer 仍全拒写。

改动点：

- `infrastructure/ai/harness/types.ts`：新增 `plan_proposed` / `plan_resolved` 事件与 `PlanStep` 类型。
- `infrastructure/ai/shared/planGate.ts`（新）：`proposePlan()` / `resolvePlan()` / `onPlanProposed()` /
  `replayPendingPlans()`，复用 `approvalConstants` 的 idle/hard deadline；超时按拒绝处理且绝不自动批准。
  同时提供 `isToolCoveredByApprovedPlan(chatSessionId, toolName, args)` 供审批绕过。
- `infrastructure/ai/harness/cattyToolApproval.ts`：confirm 模式下，命中已批准计划的步骤不再逐条询问；
  未命中仍走 `approvalGate`。红线性能力（Phase 5 定义）永远询问。
- catalog：新增 `harness.plan.submit`（localExecution，write=false，无需审批），
  `capabilityTools.executeLocalCattyCapability` 实现 → 调用 `proposePlan`，把用户决定回给模型。
- `systemPrompt.ts`：服务器管理目的 + 提交计划的要求（步骤须含目标机/命令/理由/验证方式/偏离即停）。
- UI：`AIChatSidePanel` / `ChatMessageList` 渲染计划卡片（步骤、批准/拒绝/要求修改按钮），
  `ChatInput` 支持批准；trace 与活动视图显示计划事件。
- 顺手归一：Catty `usage` 事件补齐 cached/reasoning 口径（对齐 Pi driver），
  避免同一产品两套成本展示。

验收：

- 一个"改配置并验证"的 turn 只出现一次计划批准，不再逐条弹审批。
- 计划被拒 → 模型收到拒绝原因并不执行；超时 → 拒绝。
- 偏离计划（执行中需要计划外的高风险动作）→ 停下并询问。
- Observer 模式仍拒绝一切写操作与计划执行。
- 每个动作与每个计划事件都在 trace 中可查。

检查：`node --test --import tsx infrastructure/ai/harness/...`（新增 planGate 用例）、
`npx eslint infra.../shared/planGate.ts infra.../harness/{types,cattyToolApproval}.ts`。

状态：进行中（事件协议 + planGate 先行）

## Phase 2 — 工具面收敛与角色落地

目标：sidebar 工具集由 catalog 角色分类派生，仅保留感知/变更/档案三类；提示词以服务器管理为目的。

改动点：

- catalog 增加角色标注（`agentKinds` 或 `surfaces.catty`），`codegen/toolSurfaces.cjs` 据此生成；
  `harness.plan.submit` 之外保留 `session.environment`、`terminal.*`、`harness.terminal.read_context`、
  sftp 读写/传输、`portforward.tunnels.list`、`host_notes_get/set`。
- 移出：vault 主机/组/笔记/片段/脚本 CRUD、附件、`vault_*` 权限类、端口转发规则 CRUD、`workspace_*`。
- 删除 `infrastructure/ai/cattyAgent/executor.ts` 中无调用者的 legacy `createToolExecutor`。
- `buildSystemPrompt` 重写：目的、四类任务（诊断/变更/巡检/搬运）、跨机一致性、验证要求、
  scope/会话/权限动态段，静态前缀保持逐轮稳定。

验收：

- 生成的 sidebar 工具数 ≈ 20，且不含 host_notes 之外的 vault CRUD。
- `npm run generate:capability-tools` 后 `git diff --exit-code .../cattyToolSpecs.json` 无差异。
- MCP `netcatty-mcp-server` 与 CLI 工具清单与本次提交前一致（除 catalog 有意变更）。
- 现有 harness 测试（contextManager / capabilityTools / approval / compaction）保持通过。

## Phase 3 — 跨机协调与写锁

目标：多机批量执行与一致性对比；写锁从 `(chatSession, session)` 收紧到按 session 跨会话互斥。

改动点：

- `shared/sessionExecutionQueue.ts` / `capabilityTools.resolveSessionQueueKey`：写操作按 `terminalSessionId`
  全进程互斥，读操作保持宽松。
- catalog 新增 batch 执行能力（多 sessionId、per-host 结果、失败隔离）与 compare 能力
  （N 台取同一信息 → 结构化差异 + 结论）。
- 批量结果进入计划事件与最终"结论 + 证据摘要"。

验收：

- 两个 chat 会话对同一主机的写调用串行（测试覆盖）。
- 一批 3 台中 1 台失败 → 其余两台结果正常，汇总标记失败主机与原因。
- compare 输出结构化差异表与一句话结论。

## Phase 4 — 机器档案

目标：跨会话记住每台机器的状态与操作，落在用户可编辑的 vault 主机备注中。

改动点：

- `host_notes_get/set` 保留并定义结构化记录格式（固定 header block：机器角色、最近操作、已知风险、
  巡检结论）；agent 自动写，用户可编辑。
- system prompt 增加"机器档案"段（从 scope 内主机的备注读取，缺失则说明未知）。
- 脱敏：写入前 `redactSecretsForModel`，读取进模型前同样处理。

验收：

- 新会话能说出上一会话对该主机做过什么（来自备注）。
- 备注中的秘钥类内容不会进入模型上下文。
- 用户手工编辑备注后，agent 下一轮读取到的是编辑后的内容。

## Phase 5 — 巡检 skill / runbook、后备通道预检、收尾

改动点：

- 复用 user skills，新增 runbook 层（带参数与步骤模板）；巡检 = 选择 skill/runbook 后提交计划。
- 后备通道预检：代理相关变更前，计划必须包含四项检查（存在备用活连接、备用路径实测可达、
  当前配置已备份、恢复步骤写明）及其结果；检查失败即拦截，除非用户明确"继续"。
- 收尾：把 note 改写为 `implemented/` 现在时；更新本计划状态；跑预推送检查清单。

验收：

- 一次代理相关变更的计划中可见四项检查与结果；任一项失败则计划不被批准。
- 巡检 skill 跑通并产出"结论 + 证据摘要"。
- 五个 smoke 场景全部通过（见 note 的 Acceptance criteria）。

## 贯穿要求

- 不在渲染层临时过滤工具；曝光一律走 catalog 角色分类 + codegen。
- 无后台/定时执行：不引入常驻进程、timer、自动触发。
- 每个 phase 的 commit 只做该 phase 的事，不夹带无关修复。
- 用户可见文本遵循 `netcatty-prose-standard`；本地化跟进（中英一致）。

## 进度记录

- [x] 需求逼问与定义（见 note）
- [x] 计划文档建立
- [x] Phase 1 事件协议与 planGate
- [x] Phase 1 `submit_plan` 工具与提示词
- [x] Phase 1 计划卡片 UI
- [ ] Phase 2 工具面收敛
- [ ] Phase 3 跨机协调与写锁
- [ ] Phase 4 机器档案
- [ ] Phase 5 巡检 skill/runbook、后备通道预检、收尾
