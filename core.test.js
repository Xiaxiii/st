import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createDefaultState,
    parseNarrativeEconomy,
    parseNarrativeState,
    reconcileAssistantMessage,
    placeBet,
    settleBet,
    transferScore
} from './core.js';

test('parses narrative loss and gain', () => {
    assert.equal(parseNarrativeEconomy('游戏输了300积分').delta, -300);
    assert.equal(parseNarrativeEconomy('获得500积分奖励').delta, 500);
});

test('explicit marker wins over prose parsing', () => {
    const parsed = parseNarrativeEconomy('看起来获得500积分，但实际结算为 [积分变动：-300]');
    assert.equal(parsed.delta, -300);
    assert.equal(parsed.events.length, 1);
});

test('parses card status fields and inventory', () => {
    const parsed = parseNarrativeState('<状态栏>\n地点：黑市\n等级：C\n位格：20\n积分：700（↓300）\n道具：治疗针 ×2、钥匙\n在场：陈谣\n</状态栏>');
    assert.equal(parsed.location, '黑市');
    assert.equal(parsed.level, 'C');
    assert.equal(parsed.scoreCurrent, 700);
    assert.equal(parsed.inventory[0].quantity, 2);
});

test('reconciles each assistant message once', () => {
    let state = createDefaultState(1000);
    state = reconcileAssistantMessage(state, '<状态栏>\n积分：1000\n</状态栏>', 'm1').state;
    const first = reconcileAssistantMessage(state, '游戏输了300积分\n<状态栏>\n积分：700（↓300）\n</状态栏>', 'm2');
    assert.equal(first.state.score, 700);
    const duplicate = reconcileAssistantMessage(first.state, '游戏输了300积分\n<状态栏>\n积分：700（↓300）\n</状态栏>', 'm2');
    assert.equal(duplicate.changed, false);
    assert.equal(duplicate.state.score, 700);
});

test('does not double count program settlement when prose repeats it', () => {
    let state = createDefaultState(1000);
    state = placeBet(state, 'dice-high', 100);
    state = settleBet(state, 0, 'loss', '骰子失败');
    const result = reconcileAssistantMessage(state, '系统宣布你输了100积分。<状态栏>\n积分：900（↓100）\n</状态栏>', 'm3');
    assert.equal(result.state.score, 900);
});

test('supports escrow transfer and rejects overspend', () => {
    let state = createDefaultState(1000);
    state = transferScore(state, 200, 'out', '购买治疗针');
    assert.equal(state.score, 800);
    assert.throws(() => transferScore(state, 900, 'out', '超额支付'), /可用积分不足/);
});
