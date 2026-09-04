(async function () {
    'use strict';

    const ROOT = window.parent && window.parent.document ? window.parent : window;
    const DOC = ROOT.document;
    const EXTENSION_ID = 'infinite-economy-extension';
    const scriptUrl = document.currentScript && document.currentScript.src ? document.currentScript.src : '';

    async function loadCoreModule() {
        const candidates = [];
        if (scriptUrl) candidates.push(new URL('./core.js', scriptUrl).href);
        for (const script of Array.from(DOC.scripts || [])) {
            if (!script.src || !/\/index\.js(?:[?#]|$)/i.test(script.src)) continue;
            candidates.push(new URL('./core.js', script.src).href);
        }
        const baseCandidates = [
            '/scripts/extensions/third-party/st/core.js',
            '/scripts/extensions/third-party/infinite-economy-extension/core.js'
        ];
        for (const path of baseCandidates) candidates.push(new URL(path, location.origin).href);
        const urls = [...new Set(candidates)];
        let lastError = null;
        for (const url of urls) {
            try {
                const response = await fetch(url, { cache: 'no-store' });
                if (!response.ok) continue;
                const source = await response.text();
                const moduleUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
                try {
                    return await import(moduleUrl);
                } finally {
                    URL.revokeObjectURL(moduleUrl);
                }
            } catch (error) {
                lastError = error;
            }
        }
        throw lastError || new Error('找不到扩展核心文件 core.js');
    }

    try {
        const core = await loadCoreModule();
        if (ROOT.__INFINITE_ECONOMY_CLEANUP) ROOT.__INFINITE_ECONOMY_CLEANUP();

        const context = () => {
            try {
                return ROOT.SillyTavern && typeof ROOT.SillyTavern.getContext === 'function'
                    ? ROOT.SillyTavern.getContext()
                    : null;
            } catch (error) {
                return null;
            }
        };

        const getChatKey = () => {
            const ctx = context();
            const chatId = ctx && (ctx.chatId || ctx.this_chid || ctx.chatMetadata?.chat_id);
            const characterId = ctx && ctx.characterId;
            return `${characterId || 'character'}::${chatId || 'current'}`;
        };

        let activeChatKey = getChatKey();
        const localKey = () => `${core.STORAGE_KEY}::${activeChatKey}`;
        const loadState = () => {
            const ctx = context();
            let raw = null;
            try {
                if (ctx && ctx.chatMetadata && ctx.chatMetadata[EXTENSION_ID]) raw = ctx.chatMetadata[EXTENSION_ID];
            } catch (error) {}
            if (!raw) {
                try { raw = JSON.parse(ROOT.localStorage.getItem(localKey()) || 'null'); } catch (error) {}
            }
            return core.hydrateState(raw, 1000);
        };

        const saveState = async (state) => {
            const normalized = core.hydrateState(state);
            const ctx = context();
            let savedToMetadata = false;
            try {
                if (ctx && ctx.chatMetadata) {
                    ctx.chatMetadata[EXTENSION_ID] = normalized;
                    if (typeof ctx.saveMetadata === 'function') await ctx.saveMetadata();
                    savedToMetadata = true;
                }
            } catch (error) {}
            try { ROOT.localStorage.setItem(localKey(), JSON.stringify(normalized)); } catch (error) {}
            if (!savedToMetadata) return false;
            return true;
        };

        let state = loadState();
        let destroyed = false;
        const listeners = [];

        function escapeHtml(value) {
            return String(value == null ? '' : value).replace(/[&<>"']/g, (char) => ({
                '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
            })[char]);
        }

        function getCurrentChat() {
            const ctx = context();
            return ctx && Array.isArray(ctx.chat) ? ctx.chat : [];
        }

        function getLatestAssistant() {
            const chat = getCurrentChat();
            for (let i = chat.length - 1; i >= 0; i -= 1) {
                const message = chat[i];
                if (!message || message.is_user || message.is_system) continue;
                const text = typeof message.mes === 'string' ? message.mes : typeof message.message === 'string' ? message.message : '';
                return { message, text, id: core.getMessageId(message, i) };
            }
            return null;
        }

        async function reconcileChatHistory() {
            const chat = getCurrentChat();
            let changed = false;
            for (let i = 0; i < chat.length; i += 1) {
                const message = chat[i];
                if (!message || message.is_user || message.is_system) continue;
                const text = typeof message.mes === 'string' ? message.mes : typeof message.message === 'string' ? message.message : '';
                const id = core.getMessageId(message, i);
                const result = core.reconcileAssistantMessage(state, text, id);
                if (result.changed) {
                    state = result.state;
                    changed = true;
                }
            }
            if (changed) await saveState(state);
            return changed;
        }

        async function reconcileLatest() {
            await reconcileChatHistory();
            render();
            updatePrompt();
        }

        function updatePrompt() {
            const ctx = context();
            if (!ctx || typeof ctx.setExtensionPrompt !== 'function') return;
            const prompt = [
                '【无限流状态同步·程序权威】',
                '以下账本和状态由扩展维护，正文中的积分、冻结积分、道具和待处理赌局必须以此为准。',
                '每轮正文结束后仍需输出卡片要求的完整状态栏；其中积分和道具不得覆盖程序账本。',
                core.formatCanonicalStatus(state),
                core.formatStateBlock(state),
                state.lastStatus.scoreWarning ? `账本校验提示：${state.lastStatus.scoreWarning}` : ''
            ].filter(Boolean).join('\n');
            try {
                ctx.setExtensionPrompt(EXTENSION_ID, prompt, 1, 0, false);
            } catch (error) {}
        }

        function renderLedger() {
            const rows = state.ledger.slice(-8).reverse();
            if (!rows.length) return '<div class="ie-empty">暂无流水</div>';
            return rows.map((entry) => {
                const amount = Number(entry.amount || 0);
                const cls = amount > 0 ? 'gain' : amount < 0 ? 'loss' : 'neutral';
                const sign = amount > 0 ? '+' : '';
                return `<div class="ie-ledger-row"><span>${escapeHtml(entry.reason || entry.type || '记录')}</span><b class="${cls}">${sign}${amount}</b><small>${escapeHtml(entry.balance)}</small></div>`;
            }).join('');
        }

        function renderItems() {
            if (!state.items.length) return '<span class="ie-muted">无</span>';
            return state.items.map((item) => `<span class="ie-chip">${escapeHtml(item.name)} ×${escapeHtml(item.quantity || 1)}</span>`).join('');
        }

        function renderInlineStatus() {
            const candidates = Array.from(DOC.querySelectorAll('#chat .mes, .mes'));
            let message = null;
            for (let i = candidates.length - 1; i >= 0; i -= 1) {
                const candidate = candidates[i];
                if (candidate.classList.contains('is_user') || candidate.getAttribute('is_user') === 'true') continue;
                message = candidate;
                break;
            }
            if (!message) return;
            const host = message.querySelector('.mes_text') || message;
            let inline = message.querySelector('[data-ie-inline-status]');
            if (!inline) {
                inline = DOC.createElement('div');
                inline.dataset.ieInlineStatus = 'true';
                host.appendChild(inline);
            }
            const status = state.lastStatus || {};
            const inventory = state.items.length ? state.items.map(item => `${escapeHtml(item.name)} ×${escapeHtml(item.quantity || 1)}`).join('　') : '无';
            inline.innerHTML = `<div class="ie-inline-head"><span>∞ 程序状态</span><small>聊天独立账本</small></div><div class="ie-inline-grid"><span>积分 <b>${state.score.toLocaleString()}</b></span><span>冻结 <b>${state.frozenScore.toLocaleString()}</b></span><span>地点 <b>${escapeHtml(status.location || '回廊')}</b></span><span>任务 <b>${escapeHtml(status.task || '休整期')}</b></span></div><div class="ie-inline-line">道具：${inventory}</div>`;
        }

        function render() {
            if (destroyed) return;
            const panel = DOC.getElementById('ie-panel');
            if (!panel) return;
            panel.querySelector('[data-role="score"]').textContent = state.score.toLocaleString();
            panel.querySelector('[data-role="frozen"]').textContent = state.frozenScore.toLocaleString();
            panel.querySelector('[data-role="asset"]').textContent = (state.score + state.frozenScore).toLocaleString();
            panel.querySelector('[data-role="location"]').textContent = state.lastStatus.location || '回廊';
            panel.querySelector('[data-role="level"]').textContent = state.lastStatus.level || 'D';
            panel.querySelector('[data-role="rank"]').textContent = state.lastStatus.rank || '未知';
            panel.querySelector('[data-role="time"]').textContent = state.lastStatus.time || '无';
            panel.querySelector('[data-role="task"]').textContent = state.lastStatus.task || '休整期';
            panel.querySelector('[data-role="pending"]').textContent = state.lastStatus.pending || '无';
            panel.querySelector('[data-role="presence"]').textContent = state.lastStatus.presence || '无';
            panel.querySelector('[data-role="items"]').innerHTML = renderItems();
            panel.querySelector('[data-role="ledger"]').innerHTML = renderLedger();
            const game = state.activeGame && state.activeGame.status === 'open' ? `${state.activeGame.game} · 下注 ${state.activeGame.stake}` : '无';
            panel.querySelector('[data-role="game"]').textContent = game;
            const warning = state.lastStatus.scoreWarning || '';
            const warningEl = panel.querySelector('[data-role="warning"]');
            warningEl.textContent = warning;
            warningEl.hidden = !warning;
            renderInlineStatus();
        }

        function makeUi() {
            const style = DOC.createElement('style');
            style.id = 'ie-style';
            style.textContent = `
#ie-ball,#ie-panel,#ie-panel *{box-sizing:border-box}
#ie-ball{position:fixed;right:22px;top:210px;z-index:999990;width:50px;height:50px;border:1px solid rgba(235,200,120,.55);border-radius:14px;background:linear-gradient(145deg,#382d20,#17161a);color:#f5dca1;display:flex;align-items:center;justify-content:center;cursor:pointer;box-shadow:0 12px 28px rgba(0,0,0,.45),0 0 20px -7px rgba(235,200,120,.85);font:700 12px/1 "JetBrains Mono",monospace;user-select:none;touch-action:none}
#ie-ball:hover{border-color:#f5dca1} #ie-ball.ie-dragging{transition:none;transform:scale(1.03)}
#ie-panel{position:fixed;z-index:999989;width:min(380px,calc(100vw - 18px));max-height:min(82vh,720px);display:none;color:#f5f1e8;font-family:"Noto Sans SC","Microsoft YaHei",sans-serif;filter:drop-shadow(0 24px 50px rgba(0,0,0,.5))}
#ie-panel.ie-show{display:block}#ie-panel .ie-card{overflow:hidden;border:1px solid rgba(255,255,255,.14);border-radius:16px;background:linear-gradient(145deg,rgba(52,44,34,.98),rgba(22,22,25,.98));box-shadow:inset 0 1px 0 rgba(255,255,255,.16)}
#ie-panel .ie-head{padding:15px 17px 13px;border-bottom:1px solid rgba(255,255,255,.1);display:flex;align-items:flex-start;gap:11px}#ie-panel .ie-mark{width:32px;height:32px;flex:none;border-radius:10px;border:1px solid rgba(245,220,161,.35);display:flex;align-items:center;justify-content:center;color:#f5dca1;font-weight:800}#ie-panel .ie-title{font-family:"Noto Serif SC","Songti SC",serif;font-size:16px;font-weight:700;line-height:1.3}.ie-sub{margin-top:4px;color:#b9b0a1;font-size:10px}.ie-close{margin-left:auto;all:unset;width:26px;height:26px;border:1px solid rgba(255,255,255,.12);border-radius:8px;display:flex;align-items:center;justify-content:center;cursor:pointer;color:#b9b0a1}.ie-close:hover{color:#fff}
#ie-panel .ie-body{max-height:calc(min(82vh,720px) - 66px);overflow:auto;padding:13px 14px 15px}.ie-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:7px}.ie-stat{padding:10px 8px;border:1px solid rgba(255,255,255,.1);border-radius:11px;background:rgba(255,255,255,.045);text-align:center}.ie-label{color:#aa9f91;font-size:9px;letter-spacing:.08em}.ie-value{margin-top:5px;color:#fbf3dc;font:700 17px/1.1 "JetBrains Mono",monospace;overflow-wrap:anywhere}.ie-value.gold{color:#f5dca1}.ie-section{margin:14px 1px 7px;color:#e8c985;font-size:9px;letter-spacing:.2em}.ie-info{display:grid;grid-template-columns:1fr 1fr;gap:7px}.ie-line{min-width:0;padding:9px 10px;border:1px solid rgba(255,255,255,.09);border-radius:10px;background:rgba(255,255,255,.035)}.ie-line b{display:block;margin-top:4px;font-size:11px;line-height:1.5;overflow-wrap:anywhere}.ie-chips{display:flex;gap:6px;flex-wrap:wrap}.ie-chip{padding:4px 8px;border:1px solid rgba(158,224,184,.25);border-radius:14px;background:rgba(158,224,184,.06);font-size:10px;color:#c8dfcf}.ie-form{display:grid;grid-template-columns:1.2fr .8fr;gap:7px}.ie-form input,.ie-form select,.ie-form button{width:100%;min-height:34px;border-radius:9px;border:1px solid rgba(255,255,255,.13);background:rgba(9,10,12,.45);color:#f5f1e8;padding:7px 9px;font:inherit;font-size:11px}.ie-form button{cursor:pointer;background:rgba(245,220,161,.12);border-color:rgba(245,220,161,.32);color:#f5dca1;font-weight:700}.ie-form button:hover{background:rgba(245,220,161,.2)}.ie-form .wide{grid-column:1/-1}.ie-actions{display:grid;grid-template-columns:1fr 1fr;gap:7px}.ie-actions button{min-height:34px;border-radius:9px;border:1px solid rgba(255,255,255,.13);background:rgba(255,255,255,.055);color:#eee6d7;cursor:pointer;font-size:11px}.ie-actions button:hover{border-color:rgba(245,220,161,.4)}.ie-ledger{display:flex;flex-direction:column;gap:5px}.ie-ledger-row{display:grid;grid-template-columns:1fr auto auto;gap:8px;align-items:center;padding:7px 8px;border-radius:8px;background:rgba(255,255,255,.035);font-size:10px}.ie-ledger-row b{font:700 11px "JetBrains Mono",monospace}.ie-ledger-row b.gain{color:#9ee0b8}.ie-ledger-row b.loss{color:#efaa9d}.ie-ledger-row b.neutral{color:#c8c0b0}.ie-ledger-row small{color:#a99f90;font:10px "JetBrains Mono",monospace}.ie-empty,.ie-muted{color:#9c9388;font-size:10px}.ie-warning{margin-top:8px;padding:8px 9px;border:1px solid rgba(239,194,115,.35);border-radius:8px;color:#f1c981;background:rgba(239,194,115,.08);font-size:10px;line-height:1.5}.ie-hint{margin-top:8px;color:#999184;font-size:9px;line-height:1.5}.ie-inline-status{margin:12px 0 4px;padding:10px 12px;border:1px solid rgba(190,165,110,.4);border-radius:10px;background:linear-gradient(145deg,rgba(55,46,34,.95),rgba(25,24,26,.95));color:#eee4cf;box-shadow:0 8px 20px rgba(0,0,0,.22);font-family:"Noto Sans SC","Microsoft YaHei",sans-serif}.ie-inline-head{display:flex;justify-content:space-between;gap:12px;align-items:center;color:#f5dca1;font-weight:700;font-size:12px}.ie-inline-head small{color:#aaa091;font-weight:400;font-size:9px}.ie-inline-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px;margin-top:8px}.ie-inline-grid span,.ie-inline-line{min-width:0;color:#aca294;font-size:9px;line-height:1.45}.ie-inline-grid b{display:block;margin-top:2px;color:#fff5df;font:700 11px "JetBrains Mono",monospace;overflow-wrap:anywhere}.ie-inline-line{margin-top:7px;padding-top:7px;border-top:1px solid rgba(255,255,255,.1);overflow-wrap:anywhere}@media(max-width:520px){.ie-inline-grid{grid-template-columns:1fr 1fr}}@media(max-width:360px){.ie-grid{grid-template-columns:1fr 1fr}.ie-grid .ie-stat:last-child{grid-column:1/-1}}
`;
            DOC.head.appendChild(style);

            const ball = DOC.createElement('button');
            ball.id = 'ie-ball';
            ball.type = 'button';
            ball.title = '打开无限流经济状态';
            ball.textContent = '∞ ¥';
            DOC.body.appendChild(ball);

            const panel = DOC.createElement('div');
            panel.id = 'ie-panel';
            panel.innerHTML = `<div class="ie-card"><div class="ie-head"><div class="ie-mark">∞</div><div><div class="ie-title">无限流经济状态</div><div class="ie-sub">程序账本 · 正文同步 · 聊天独立</div></div><button class="ie-close" data-role="close" type="button" aria-label="关闭">×</button></div><div class="ie-body"><div class="ie-grid"><div class="ie-stat"><div class="ie-label">可用积分</div><div class="ie-value gold" data-role="score">0</div></div><div class="ie-stat"><div class="ie-label">冻结积分</div><div class="ie-value" data-role="frozen">0</div></div><div class="ie-stat"><div class="ie-label">总资产</div><div class="ie-value" data-role="asset">0</div></div></div><div class="ie-section">当前剧情</div><div class="ie-info"><div class="ie-line"><span class="ie-label">地点</span><b data-role="location">回廊</b></div><div class="ie-line"><span class="ie-label">时间</span><b data-role="time">无</b></div><div class="ie-line"><span class="ie-label">等级 / 位格</span><b><span data-role="level">D</span> / <span data-role="rank">未知</span></b></div><div class="ie-line"><span class="ie-label">任务</span><b data-role="task">休整期</b></div><div class="ie-line"><span class="ie-label">待清算</span><b data-role="pending">无</b></div><div class="ie-line"><span class="ie-label">在场</span><b data-role="presence">无</b></div></div><div class="ie-section">道具库存</div><div class="ie-chips" data-role="items"></div><div class="ie-section">快速下注</div><div class="ie-form"><select data-role="game"><option value="dice-high">骰子·比大小</option><option value="odd-even">骰子·猜单双</option><option value="slots">老虎机</option><option value="blackjack">简易21点</option></select><input data-role="bet" type="number" min="1" step="1" placeholder="下注积分"><button class="wide" data-role="play" type="button">下注并立即开局</button></div><div class="ie-section">托管交易</div><div class="ie-form"><select data-role="trade-direction"><option value="in">收入 / 对方支付</option><option value="out">支出 / 支付对方</option></select><input data-role="trade-amount" type="number" min="1" step="1" placeholder="交易金额"><input class="wide" data-role="trade-reason" type="text" placeholder="交易说明，例如：购买治疗针"><button class="wide" data-role="trade" type="button">确认托管结算</button></div><div class="ie-actions"><button data-role="settle" type="button">查看当前赌局</button><button data-role="export" type="button">导出账本</button></div><div class="ie-section">最近流水</div><div class="ie-ledger" data-role="ledger"></div><div class="ie-warning" data-role="warning" hidden></div><div class="ie-hint">正文中出现“输了300积分 / 获得500积分 / 积分：700（↓300）”时，下一次刷新会自动记入账本。状态栏中的积分仅作核对，账本优先。</div></div></div>`;
            DOC.body.appendChild(panel);
            return { ball, panel, style };
        }

        const ui = makeUi();
        let open = false;
        let pointer = null;
        let drag = false;
        let sx = 0;
        let sy = 0;
        let ox = 0;
        let oy = 0;

        const positionPanel = () => {
            if (!open) return;
            const br = ui.ball.getBoundingClientRect();
            ui.panel.style.visibility = 'hidden';
            ui.panel.style.display = 'block';
            const pw = ui.panel.offsetWidth;
            const ph = ui.panel.offsetHeight;
            ui.panel.style.visibility = '';
            let left = br.right - pw;
            let top = br.bottom + 8;
            if (top + ph > ROOT.innerHeight - 8) top = br.top - ph - 8;
            left = Math.min(Math.max(8, left), Math.max(8, ROOT.innerWidth - pw - 8));
            top = Math.min(Math.max(8, top), Math.max(8, ROOT.innerHeight - ph - 8));
            ui.panel.style.left = `${left}px`;
            ui.panel.style.top = `${top}px`;
        };

        const setOpen = (next) => {
            open = Boolean(next);
            ui.panel.classList.toggle('ie-show', open);
            if (open) requestAnimationFrame(positionPanel);
        };

        const addListener = (target, type, handler, options) => {
            target.addEventListener(type, handler, options);
            listeners.push(() => target.removeEventListener(type, handler, options));
        };

        addListener(ui.ball, 'click', () => { if (!drag) setOpen(!open); });
        addListener(ui.panel, 'click', (event) => event.stopPropagation());
        addListener(ui.panel.querySelector('[data-role="close"]'), 'click', () => setOpen(false));
        addListener(DOC, 'click', () => setOpen(false));
        addListener(ROOT, 'resize', positionPanel);
        addListener(ui.ball, 'pointerdown', (event) => {
            pointer = event.pointerId;
            drag = false;
            sx = event.clientX;
            sy = event.clientY;
            const rect = ui.ball.getBoundingClientRect();
            ox = rect.left;
            oy = rect.top;
            try { ui.ball.setPointerCapture(pointer); } catch (error) {}
        });
        addListener(ui.ball, 'pointermove', (event) => {
            if (pointer !== event.pointerId) return;
            const dx = event.clientX - sx;
            const dy = event.clientY - sy;
            if (!drag && Math.hypot(dx, dy) < 8) return;
            drag = true;
            ui.ball.classList.add('ie-dragging');
            ui.ball.style.left = `${Math.min(Math.max(7, ox + dx), ROOT.innerWidth - ui.ball.offsetWidth - 7)}px`;
            ui.ball.style.top = `${Math.min(Math.max(7, oy + dy), ROOT.innerHeight - ui.ball.offsetHeight - 7)}px`;
            ui.ball.style.right = 'auto';
            if (open) positionPanel();
        });
        addListener(ui.ball, 'pointerup', (event) => {
            if (pointer !== event.pointerId) return;
            pointer = null;
            ui.ball.classList.remove('ie-dragging');
            setTimeout(() => { drag = false; }, 60);
        });

        const getInputValue = (role) => ui.panel.querySelector(`[data-role="${role}"]`).value;
        const notify = (message) => {
            const warning = ui.panel.querySelector('[data-role="warning"]');
            warning.hidden = false;
            warning.textContent = message;
            setTimeout(() => {
                if (warning.textContent === message && !state.lastStatus.scoreWarning) warning.hidden = true;
            }, 3200);
        };

        addListener(ui.panel.querySelector('[data-role="play"]'), 'click', async () => {
            try {
                const game = getInputValue('game');
                const amount = core.normalizeAmount(getInputValue('bet'));
                state = core.placeBet(state, game, amount);
                const outcome = Math.random();
                let payout = 0;
                let result = 'loss';
                if (game === 'dice-high') {
                    const player = 1 + Math.floor(Math.random() * 6);
                    const house = 1 + Math.floor(Math.random() * 6);
                    if (player > house) { payout = amount * 2; result = 'win'; }
                    else if (player === house) { payout = amount; result = 'push'; }
                    notify(`骰子：你 ${player} · 庄 ${house} · ${result === 'win' ? '获胜' : result === 'push' ? '和局' : '失败'}`);
                } else if (game === 'odd-even') {
                    const dice = 1 + Math.floor(Math.random() * 6);
                    if (outcome < 0.5) { payout = amount * 2; result = 'win'; }
                    notify(`单双：点数 ${dice} · ${result === 'win' ? '猜中' : '猜错'}`);
                } else if (game === 'slots') {
                    const hit = outcome > 0.82;
                    payout = hit ? amount * 5 : 0;
                    result = hit ? 'win' : 'loss';
                    notify(`老虎机：${hit ? '三连奖励' : '未中奖'}`);
                } else {
                    const player = 16 + Math.floor(Math.random() * 7);
                    const dealer = 16 + Math.floor(Math.random() * 7);
                    if (player > dealer && player <= 21) { payout = amount * 2; result = 'win'; }
                    else if (player === dealer) { payout = amount; result = 'push'; }
                    notify(`21点：你 ${player} · 庄 ${dealer} · ${result === 'win' ? '获胜' : result === 'push' ? '和局' : '失败'}`);
                }
                state = core.settleBet(state, payout, result, `${game}自动结算`);
                await saveState(state);
                render();
                updatePrompt();
            } catch (error) { notify(error.message || '下注失败'); }
        });

        addListener(ui.panel.querySelector('[data-role="settle"]'), 'click', async () => {
            if (!state.activeGame || state.activeGame.status !== 'open') return notify('当前没有待结算赌局');
            notify('待结算赌局必须由游戏规则产生结果；请使用快速下注。');
        });

        addListener(ui.panel.querySelector('[data-role="trade"]'), 'click', async () => {
            try {
                const direction = getInputValue('trade-direction');
                const amount = core.normalizeAmount(getInputValue('trade-amount'));
                const reason = getInputValue('trade-reason').trim() || '托管交易';
                state = core.transferScore(state, amount, direction, reason);
                await saveState(state);
                render();
                updatePrompt();
                notify(`交易已入账：${direction === 'in' ? '+' : '-'}${amount}`);
            } catch (error) { notify(error.message || '交易失败'); }
        });

        addListener(ui.panel.querySelector('[data-role="export"]'), 'click', () => {
            const blob = new Blob([core.exportState(state)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const anchor = DOC.createElement('a');
            anchor.href = url;
            anchor.download = `infinite-economy-${Date.now()}.json`;
            anchor.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
        });

        const ctx = context();
        const eventTypes = ctx && ctx.event_types ? ctx.event_types : {};
        const eventSource = ctx && ctx.eventSource;
        if (eventSource && typeof eventSource.on === 'function') {
            const names = [eventTypes.CHARACTER_MESSAGE_RENDERED, eventTypes.MESSAGE_RECEIVED, eventTypes.CHAT_CHANGED, eventTypes.MESSAGE_EDITED];
            for (const name of names.filter(Boolean)) {
                const handler = async () => {
                    const nextKey = getChatKey();
                    if (nextKey !== activeChatKey) {
                        activeChatKey = nextKey;
                        state = loadState();
                        updatePrompt();
                    }
                    await reconcileLatest();
                };
                eventSource.on(name, handler);
                listeners.push(() => eventSource.off && eventSource.off(name, handler));
            }
        }

        await reconcileLatest();
        render();
        updatePrompt();

        ROOT.__INFINITE_ECONOMY_CLEANUP = () => {
            destroyed = true;
            listeners.splice(0).forEach((remove) => { try { remove(); } catch (error) {} });
            [ui.ball, ui.panel, ui.style].forEach((element) => { try { element.remove(); } catch (error) {} });
            try { if (ROOT.__INFINITE_ECONOMY_CLEANUP) ROOT.__INFINITE_ECONOMY_CLEANUP = null; } catch (error) {}
        };
    } catch (error) {
        console.error('[Infinite Economy] failed to initialize', error);
        try {
            const existing = DOC.getElementById('ie-load-error');
            if (existing) existing.remove();
            const notice = DOC.createElement('div');
            notice.id = 'ie-load-error';
            notice.textContent = `Infinite Economy 加载失败：${error.message || error}`;
            notice.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:999999;max-width:360px;padding:12px 14px;border:1px solid #c98b72;border-radius:10px;background:#2a1d1a;color:#ffe2d5;font:12px/1.5 sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.3)';
            DOC.body.appendChild(notice);
        } catch (noticeError) {}
    }
})();
