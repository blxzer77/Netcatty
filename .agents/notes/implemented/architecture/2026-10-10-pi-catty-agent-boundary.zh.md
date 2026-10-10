# Agent Note: Pi 与 Catty 是产品支持的 Agent
Status: implemented

## Problem

Netcatty 原本带有较宽的 Agent 注册表和设置入口，而这个 fork 需要提供稳定的 Catty 体验和一等 Pi Agent。若发现、选择和设置页面继续保留各类供应商入口，产品支持范围会不清晰，打包和生命周期测试也会增加不必要的路径。

## Decision

产品内支持的 Agent 固定为 Catty 和 Pi。Catty 保留现有流式路径，Pi 通过 AI bridge 作为一等驱动接入，包含发现、设置、事件转换、取消和专项测试。Agent 选择、设置、本地化和发送资格只暴露这两个产品选项。

不属于产品入口的供应商适配器，只有在上游兼容路径确实需要时才可以留在源码中；它们不得被默认发现或选择。新增支持的 Agent 必须同时补齐驱动、注册表、发现、生命周期、用户可见行为和测试。

## Alternatives considered

**保留所有上游 Agent。** 可以保留上游覆盖面，但会让 fork 的支持承诺含糊，并保留未经过本项目打包验证的路径。

**只支持 Pi。** 可以进一步简化界面，但会移除 Catty，而 Catty 仍是本 fork 的内置 Agent 和现有用户路径。

**只在界面隐藏其他 Agent。** 发现和 bridge 仍会不一致，旧配置仍可能选择一个不受支持的运行时。

## Consequences

Pi 驱动和 Catty 路径共享现有的标准化事件协议。设置和本地化必须保持两个 Agent 的列表一致。以后增加受支持的 Agent 时，需要同时提供架构决策、发现、生命周期、测试和打包证据。

## Verification

Pi 驱动、注册表、发现、状态、设置生命周期、发送资格和打包测试已经一起通过。Windows 目录打包也已完成，并确认包含修补后的 `node-pty` 运行时。
