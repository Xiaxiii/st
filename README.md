# Infinite Economy & State

SillyTavern extension for an infinite-flow card. It keeps a chat-scoped economic ledger, synchronizes score changes from assistant messages, and renders a compact state panel.

## Features

- Chat-scoped persistence through `chatMetadata` with localStorage fallback.
- Available score, frozen score, total assets, inventory, active game, and recent ledger.
- Dice high/low, odd/even, slots, and a simple blackjack-like game.
- Escrow-style score transfer for black-market or contract transactions.
- Assistant-message reconciliation for score changes.
- State context injection through `setExtensionPrompt` so the next generation sees the authoritative ledger.
- History replay on startup/chat switch to reduce long-chat memory loss.
- Export JSON ledger.

## Install

1. Put this repository on GitHub.
2. In SillyTavern open Extensions -> Manage extensions -> Install extension.
3. Paste the Git URL.
4. Enable `Infinite Economy & State`.

The repository must contain `manifest.json`, `index.js`, `core.js`, and `style.css` in its root.

## Card compatibility

The extension is designed for the supplied `♾️` card. It reads these fields from the card status block when present:

- `地点`
- `时间`
- `日期`
- `等级`
- `位格`
- `积分`
- `待清算`
- `任务`
- `道具`
- `在场`

The extension's program ledger is authoritative for score, frozen score, inventory, and active games. The original card may still render its own `<状态栏>` beautifier; the new extension panel is intentionally separate, so it does not collide with the existing `状态栏` and `直播` regex scripts.

## Economy synchronization

The parser supports explicit markers and ordinary prose.

Recommended marker:

```text
[积分变动：-300]
```

Optional structured marker:

```text
<经济事件>
变动：-300
原因：游戏失败
</经济事件>
```

It also understands common prose such as:

```text
游戏输了300积分
获得500积分奖励
```

The status block can act as a consistency check:

```text
积分：700（↓300）
```

If the prose and status block disagree, the extension records a warning and keeps the explicit prose event as the transaction source. If no prose event exists, a changed status balance is imported as a delta.

## Important narrative rule

For best reliability, add a short rule to the card/world book:

```text
【经济扩展接口】
- 涉及{{user}}积分、奖励、消费、下注、交易、罚款或道具变化时，正文结算后输出一行明确标记：
  [积分变动：+N] 或 [积分变动：-N]
- N必须是本轮实际发生的净变化，只记录一次。
- 扩展账本优先于模型记忆；状态栏中的积分和道具必须继承扩展注入的权威值。
- 扩展已通过按钮完成的下注、交易、奖励，不要在正文中重复生成同一笔经济事件；如需表现结果，可以描述结果但不再次扣加积分。
- 自由集市仍禁止裸转积分；涉及角色交易时使用系统托管、黑市契约或明确的交易结算。
```

## Current scope

This is a local-first MVP. It does not yet provide a true shared multi-user server economy, NPC AI offers, item escrow, or automatic parsing of every possible Chinese phrasing. Ambiguous prose may be ignored or shown as a ledger warning rather than guessed.
