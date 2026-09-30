# Agent Note: Adopt ponygo governance

Status: implemented

## Problem

dsh-plugins 仓库需要一套工程化治理体系来约束后续远程 SSH 插件的演化：决策需要留痕、承诺需要可验证、文档需要有家。没有治理根时，这些约定只能靠自觉遵守，随规模变化必然衰减。

## Decision

采纳 `ponygo` 作为工程化治理元框架：运行 `ponygo init` 生成 `.agents/` + `.meta/` 双根骨架，填写宪法槽位（项目名 dsh-plugin-remote-ssh、成熟度目标 L2），运行 `ponygo sync` 投影常载命约，`.meta/meta.yaml` 的 `level` 置为 `1`。

## Alternatives considered

- 不引入治理、直接写插件代码：短期最快，但决策无载体、承诺无门禁，后续多轮迭代必然丢失上下文；落选。
- 引入重型流程框架（如全套 CI 矩阵 + 评审委员会）：当前仓库零代码、单人单插件，小项目为分层而分层是白付延迟；落选。按 ponygo 停止线原则，宁可粗糙、不可缺席。

## Consequences

- 后续非平凡变更先 ADR 后代码，记录落在 `.agents/notes/`。
- 升 L2 时需落地第一个非零退出门禁并把 `level` 改为 `2`。
