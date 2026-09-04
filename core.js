export const STORAGE_KEY = 'infinite_economy_state_v1';

export function createDefaultState(initialScore = 1000) {
    return {
        version: 1,
        initialized: false,
        score: normalizeAmount(initialScore),
        frozenScore: 0,
        items: [],
        contracts: [],
        ledger: [],
        activeGame: null,
        pendingProgramDelta: null,
        processedMessages: [],
        lastNarrativeSync: null,
        lastStatus: {
            location: '回廊',
            time: '',
            date: '',
            level: 'D',
            rank: '',
            pending: '无',
            task: '休整期',
            presence: '无',
            rawItems: '无'
        }
    };
}

export function normalizeAmount(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.floor(n));
}

export function normalizeSignedAmount(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    return Math.trunc(n);
}

export function cloneState(state) {
    return JSON.parse(JSON.stringify(state));
}

export function hydrateState(raw, fallbackScore = 1000) {
    const base = createDefaultState(fallbackScore);
    if (!raw || typeof raw !== 'object') return base;
    const merged = {
        ...base,
        ...raw,
        lastStatus: { ...base.lastStatus, ...(raw.lastStatus || {}) },
        items: Array.isArray(raw.items) ? raw.items : [],
        contracts: Array.isArray(raw.contracts) ? raw.contracts : [],
        ledger: Array.isArray(raw.ledger) ? raw.ledger : [],
        processedMessages: Array.isArray(raw.processedMessages) ? raw.processedMessages : []
    };
    merged.score = normalizeAmount(merged.score);
    merged.frozenScore = normalizeAmount(merged.frozenScore);
    merged.processedMessages = merged.processedMessages.slice(-80);
    merged.ledger = merged.ledger.slice(-120);
    return merged;
}

export function parseAmount(text) {
    if (!text) return null;
    const normalized = String(text).replace(/,/g, '').replace(/，/g, '');
    const match = normalized.match(/(\d+(?:\.\d+)?)/);
    if (!match) return null;
    return normalizeAmount(match[1]);
}

function cleanText(text) {
    return String(text || '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/[`*_#>]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function getStatusBlock(text) {
    const source = String(text || '');
    const match = source.match(/<状态栏>([\s\S]*?)<\/状态栏>/i);
    return match ? match[1] : '';
}

function getField(block, name) {
    if (!block) return '';
    const escaped = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = block.match(new RegExp('(?:^|\\n)\\s*' + escaped + '[：:]\\s*([^\\n\\r]*)', 'i'));
    return match ? match[1].trim() : '';
}

function parseScoreLine(block) {
    const value = getField(block, '积分');
    if (!value) return { current: null, delta: null };
    const current = parseAmount(value);
    const deltaMatch = value.match(/[（(][^）)]*?([↑↓+＋−-])\s*(\d+)/);
    if (!deltaMatch) return { current, delta: null };
    const sign = /[↓−-]/.test(deltaMatch[1]) ? -1 : 1;
    return { current, delta: sign * normalizeAmount(deltaMatch[2]) };
}

function parseInventory(value) {
    if (!value || /^(无|暂无|没有)$/.test(value.trim())) return [];
    return value
        .split(/[、,，;；|｜]/)
        .map((part) => part.trim())
        .filter(Boolean)
        .map((part) => {
            const quantityMatch = part.match(/[×x*]\s*(\d+)/i);
            const quantity = quantityMatch ? normalizeAmount(quantityMatch[1]) : 1;
            const name = part.replace(/[×x*]\s*\d+/i, '').trim();
            return { name: name || part, quantity: quantity || 1 };
        });
}

export function parseNarrativeState(text, previous = {}) {
    const source = String(text || '');
    const block = getStatusBlock(source);
    const score = parseScoreLine(block);
    const next = {
        ...previous,
        location: getField(block, '地点') || previous.location || '回廊',
        time: getField(block, '时间') || previous.time || '',
        date: getField(block, '日期') || previous.date || '',
        level: (getField(block, '等级') || previous.level || 'D').match(/[SABCD]/i)?.[0]?.toUpperCase() || 'D',
        rank: getField(block, '位格') || previous.rank || '',
        pending: getField(block, '待清算') || previous.pending || '无',
        task: getField(block, '任务') || previous.task || '休整期',
        presence: getField(block, '在场') || previous.presence || '无',
        rawItems: getField(block, '道具') || previous.rawItems || '无',
        inventory: parseInventory(getField(block, '道具')),
        scoreCurrent: score.current,
        scoreDelta: score.delta,
        hasStatusBlock: Boolean(block)
    };
    return next;
}

const LOSS_PATTERNS = [
    /(?:游戏|赌局|赌博|赌输|输了|输掉|损失|亏损|赔付|赔了|支付|花费|扣除|缴纳|罚款|租金|抽成|手续费)[^。！？!?；;\n]{0,24}?(\d[\d,，]*(?:\.\d+)?)\s*(?:积分|分)?/g,
    /(?:扣|减|失去|损耗)除?\s*(\d[\d,，]*(?:\.\d+)?)\s*(?:积分|分)/g
];

const GAIN_PATTERNS = [
    /(?:获得|赢得|赢了|赢下|赚到|赚了|奖励|返还|退回|补偿|入账|增加|加上|得到)[^。！？!?；;\n]{0,24}?(\d[\d,，]*(?:\.\d+)?)\s*(?:积分|分)?/g,
    /(?:加|增加)\s*(\d[\d,，]*(?:\.\d+)?)\s*(?:积分|分)/g
];

function collectMatches(text, patterns, sign, kind) {
    const result = [];
    for (const pattern of patterns) {
        pattern.lastIndex = 0;
        let match;
        while ((match = pattern.exec(text))) {
            const amount = parseAmount(match[1]);
            if (!amount) continue;
            result.push({ kind, amount: sign * amount, text: match[0].trim() });
        }
    }
    return result;
}

export function parseNarrativeEconomy(text) {
    const source = cleanText(text);
    const losses = collectMatches(source, LOSS_PATTERNS, -1, 'narrative-loss');
    const gains = collectMatches(source, GAIN_PATTERNS, 1, 'narrative-gain');
    const explicit = [];
    const explicitRegex = /(?:\[积分变动[:：]\s*([+＋−-]?\d[\d,，]*)\]|<经济事件>\s*(?:变动|金额)[:：]\s*([+＋−-]?\d[\d,，]*)[\s\S]*?<\/经济事件>)/gi;
    let explicitMatch;
    while ((explicitMatch = explicitRegex.exec(String(text || '')))) {
        const raw = explicitMatch[1] || explicitMatch[2];
        const sign = /^[+＋]/.test(raw) ? 1 : /^[−-]/.test(raw) ? -1 : 1;
        const amount = parseAmount(String(raw).replace(/^[+＋−-]/, ''));
        if (amount) explicit.push({ kind: 'explicit', amount: sign * amount, text: explicitMatch[0].trim() });
    }
    const events = explicit.length ? explicit : [...losses, ...gains];
    const deduped = [];
    const seen = new Set();
    for (const event of events) {
        const key = `${event.amount}:${event.text}`;
        if (seen.has(key)) continue;
        seen.add(key);
        deduped.push(event);
    }
    return {
        events: deduped,
        delta: deduped.reduce((sum, event) => sum + event.amount, 0)
    };
}

export function getMessageId(message, index = 0) {
    if (!message) return `unknown-${index}`;
    return String(message.id || message.mes_id || message.send_date || message.timestamp || `index-${index}`);
}

export function reconcileAssistantMessage(state, text, messageId, options = {}) {
    const next = hydrateState(state);
    if (next.processedMessages.includes(messageId)) return { state: next, changed: false, events: [] };

    const parsedState = parseNarrativeState(text, next.lastStatus);
    const parsedEconomy = parseNarrativeEconomy(text);
    const hasExplicitScore = parsedState.scoreCurrent !== null;
    const narrativeDelta = parsedEconomy.delta;
    const before = next.score;
    const pendingProgramDelta = next.pendingProgramDelta;
    next.pendingProgramDelta = null;
    const duplicateProgramEvent = pendingProgramDelta && narrativeDelta !== 0 && narrativeDelta === pendingProgramDelta.amount;
    const effectiveNarrativeDelta = duplicateProgramEvent ? 0 : narrativeDelta;
    let appliedDelta = 0;
    let reason = '';

    const statusMatchesBalance = hasExplicitScore && parsedState.scoreCurrent === before;
    const statusMatchesNarrative = hasExplicitScore && parsedState.scoreCurrent === normalizeAmount(before + effectiveNarrativeDelta);

    if (!next.initialized && effectiveNarrativeDelta !== 0) {
        next.score = normalizeAmount(before + effectiveNarrativeDelta);
        appliedDelta = effectiveNarrativeDelta;
        next.initialized = true;
        reason = '正文经济事件';
    } else if (!next.initialized && hasExplicitScore) {
        next.score = normalizeAmount(parsedState.scoreCurrent);
        next.initialized = true;
        next.ledger.push({ type: 'sync', amount: next.score - before, balance: next.score, reason: '读取卡片初始状态栏', messageId });
        reason = 'initial-sync';
    } else if (effectiveNarrativeDelta !== 0) {
        next.score = normalizeAmount(next.score + effectiveNarrativeDelta);
        appliedDelta = effectiveNarrativeDelta;
        reason = '正文经济事件';
    } else if (hasExplicitScore && !statusMatchesBalance) {
        appliedDelta = normalizeSignedAmount(parsedState.scoreCurrent - next.score);
        next.score = normalizeAmount(parsedState.scoreCurrent);
        reason = '状态栏差额同步';
    }

    if (hasExplicitScore && effectiveNarrativeDelta !== 0 && !statusMatchesNarrative) {
        next.lastStatus.scoreWarning = `正文经济表达与状态栏不一致：正文推导 ${normalizeAmount(before + effectiveNarrativeDelta)}，状态栏 ${parsedState.scoreCurrent}；已采用正文经济事件`;
    } else if (statusMatchesBalance || statusMatchesNarrative) {
        delete next.lastStatus.scoreWarning;
    }

    if (!next.initialized) next.initialized = true;
    if (appliedDelta !== 0) {
        next.ledger.push({
            type: appliedDelta > 0 ? 'gain' : 'loss',
            amount: appliedDelta,
            balance: next.score,
            reason,
            messageId,
            source: parsedEconomy.events.map(event => event.text).join('；') || undefined
        });
    }

    next.lastStatus = {
        ...next.lastStatus,
        ...parsedState,
        scoreCurrent: undefined,
        scoreDelta: undefined,
        hasStatusBlock: undefined
    };
    if (parsedState.inventory && parsedState.inventory.length) next.items = parsedState.inventory;
    if (parsedState.rawItems === '无') next.items = [];
    next.lastNarrativeSync = new Date().toISOString();
    next.processedMessages.push(messageId);
    next.processedMessages = next.processedMessages.slice(-80);

    if (options.maxScore != null) next.score = Math.min(next.score, normalizeAmount(options.maxScore));
    return { state: next, changed: true, events: parsedEconomy.events, appliedDelta };
}

export function recordLedger(state, entry) {
    const next = hydrateState(state);
    next.ledger.push({
        ...entry,
        amount: normalizeSignedAmount(entry.amount),
        balance: next.score,
        at: entry.at || new Date().toISOString()
    });
    next.ledger = next.ledger.slice(-120);
    return next;
}

export function placeBet(state, game, amount, metadata = {}) {
    const stake = normalizeAmount(amount);
    const next = hydrateState(state);
    if (!stake || stake > next.score) throw new Error('可用积分不足');
    if (next.activeGame && next.activeGame.status === 'open') throw new Error('已有未结算的赌局');
    next.score -= stake;
    next.frozenScore += stake;
    next.activeGame = {
        id: `game-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        game,
        stake,
        status: 'open',
        metadata,
        createdAt: new Date().toISOString()
    };
    next.ledger.push({ type: 'freeze', amount: -stake, balance: next.score, reason: `下注：${game}`, game: next.activeGame.id });
    return next;
}

export function settleBet(state, payout, outcome, note = '') {
    const next = hydrateState(state);
    if (!next.activeGame) throw new Error('没有待结算的赌局');
    const total = normalizeAmount(payout);
    const stake = next.activeGame.stake;
    next.frozenScore = Math.max(0, next.frozenScore - stake);
    next.score += total;
    const net = total - stake;
    next.ledger.push({ type: outcome === 'win' ? 'win' : outcome === 'push' ? 'push' : 'loss', amount: net, balance: next.score, reason: note || `${next.activeGame.game}结算`, game: next.activeGame.id });
    next.pendingProgramDelta = { amount: net, reason: note || `${next.activeGame.game}结算` };
    next.activeGame = null;
    return next;
}

export function transferScore(state, amount, direction, reason = '托管交易') {
    const value = normalizeAmount(amount);
    const next = hydrateState(state);
    if (!value) throw new Error('金额必须大于 0');
    if (direction === 'out') {
        if (value > next.score) throw new Error('可用积分不足');
        next.score -= value;
    } else {
        next.score += value;
    }
    const delta = direction === 'out' ? -value : value;
    next.ledger.push({ type: direction === 'out' ? 'trade-out' : 'trade-in', amount: delta, balance: next.score, reason });
    next.pendingProgramDelta = { amount: delta, reason };
    return next;
}

export function formatStateBlock(state) {
    const s = hydrateState(state);
    const status = s.lastStatus || {};
    const inventory = s.items.length ? s.items.map(item => `${item.name}${item.quantity > 1 ? ` ×${item.quantity}` : ''}`).join('、') : (status.rawItems || '无');
    const recent = s.ledger.slice(-4).map(entry => `${entry.amount > 0 ? '+' : ''}${entry.amount}（${entry.reason}）`).join('；') || '无';
    return `<无限流经济账本>\n可用积分：${s.score}\n冻结积分：${s.frozenScore}\n总资产：${s.score + s.frozenScore}\n道具：${inventory}\n待处理赌局：${s.activeGame && s.activeGame.status === 'open' ? `${s.activeGame.game}，下注${s.activeGame.stake}` : '无'}\n最近流水：${recent}\n</无限流经济账本>`;
}

export function formatCanonicalStatus(state) {
    const s = hydrateState(state);
    const status = s.lastStatus || {};
    const scoreChange = s.ledger.length ? s.ledger[s.ledger.length - 1].amount : 0;
    const changeText = scoreChange > 0 ? `（↑${scoreChange}）` : scoreChange < 0 ? `（↓${Math.abs(scoreChange)}）` : '';
    const inventory = s.items.length ? s.items.map(item => `${item.name}${item.quantity > 1 ? ` ×${item.quantity}` : ''}`).join('、') : '无';
    return `<状态栏>\n地点：${status.location || '回廊'}\n时间：${status.time || '无'}　日期：${status.date || '无'}\n━━━━━━━━━━━━━━\n{{user}}：\n等级：${status.level || 'D'}\n位格：${status.rank || '未知'}\n积分：${s.score}${changeText}\n待清算：${status.pending || '无'}\n任务：${status.task || '休整期'}\n道具：${inventory}\n在场：${status.presence || '无'}\n━━━━━━━━━━━━━━\n</状态栏>`;
}

export function exportState(state) {
    return JSON.stringify(hydrateState(state), null, 2);
}

export function importState(text) {
    return hydrateState(JSON.parse(text));
}
