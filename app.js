/* 报价助手前端逻辑：登录 / DS 风格对话报价 / 缺项手动填价 / 历史回看 / 管理员账号管理 */
(function () {
  'use strict';

  const API = String((window.APP_CONFIG && window.APP_CONFIG.API_BASE) || '').replace(/\/+$/, '');
  console.log('[报价系统] app.js build v20260618-2（机型批量删除 / 规则导入追加 / 规则框加宽）'); // 版本标记：F12 可确认浏览器加载的是哪个版本

  // ---------- 状态 ----------
  let token = localStorage.getItem('qa_token') || '';
  let me = null;              // {username, role}
  let chatContext = [];       // 发给后端的对话上下文 [{role, content}]
  let history = [];
  let cardSeq = 0;
  const cards = {};           // cardId -> { quote, manual, overrides, editing, ... }
  let sending = false;
  let priceData = null;       // 配件价格表缓存（/api/catalog）
  let priceMachineId = null;  // 价格表当前查看的机型
  let priceKeyword = '';      // 价格表搜索关键词

  // ---------- 工具 ----------
  const $ = (s) => document.querySelector(s);

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }

  function fmt(n) {
    return Number(n || 0).toLocaleString('zh-CN');
  }

  // 价格统一比较：null/undefined/空串都视为「未填」
  function normPrice(v) {
    return v === null || v === undefined || v === '' ? '' : String(v);
  }

  async function api(method, path, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    let res;
    try {
      res = await fetch(API + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    } catch (e) {
      throw new Error('网络错误：无法连接后端服务');
    }
    let data = {};
    try { data = await res.json(); } catch (e) { /* ignore */ }
    if (!res.ok) {
      if (res.status === 401 && me && path !== '/api/login') doLogout(true);
      throw new Error(data.error || ('请求失败（' + res.status + '）'));
    }
    return data;
  }

  function copyText(text, btn) {
    const done = () => {
      if (!btn) return;
      const old = btn.textContent;
      btn.textContent = '已复制 ✓';
      setTimeout(() => (btn.textContent = old), 1200);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
    } else {
      fallbackCopy(text, done);
    }
  }

  function fallbackCopy(text, done) {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e) { /* ignore */ }
    document.body.removeChild(ta);
    done();
  }

  // ---------- 登录 / 登出 ----------
  async function doLogin() {
    const u = $('#login-user').value.trim();
    const p = $('#login-pass').value;
    if (!u || !p) { $('#login-err').textContent = '请输入账号和密码'; return; }
    $('#login-err').textContent = '';
    const btn = $('#login-btn');
    btn.disabled = true;
    try {
      const r = await api('POST', '/api/login', { username: u, password: p });
      token = r.token;
      localStorage.setItem('qa_token', token);
      me = { username: r.username, role: r.role };
      enterApp();
    } catch (e) {
      $('#login-err').textContent = e.message;
    } finally {
      btn.disabled = false;
    }
  }

  function doLogout(expired) {
    token = '';
    me = null;
    chatContext = [];
    localStorage.removeItem('qa_token');
    $('#app-view').classList.add('hidden');
    $('#login-view').classList.remove('hidden');
    $('#login-pass').value = '';
    if (expired) $('#login-err').textContent = '登录已失效，请重新登录';
  }

  function enterApp() {
    $('#login-view').classList.add('hidden');
    $('#app-view').classList.remove('hidden');
    const who = $('#whoami');
    who.textContent = me.username;
    if (me.role === 'admin') {
      const b = el('span', 'badge', '管理员');
      who.appendChild(b);
      $('#btn-admin').classList.remove('hidden');
    } else {
      $('#btn-admin').classList.add('hidden');
    }
    newChat();
    loadHistory();
    $('#input').focus();
  }

  // ---------- 对话 ----------
  function scrollBottom() {
    const m = $('#messages');
    m.scrollTop = m.scrollHeight;
  }

  function showWelcome() {
    const wrap = el('div', 'msg assistant');
    const avatar = el('div', 'avatar', 'AI');
    const content = el('div', 'assistant-content');
    const p = el('div', 'reply-text',
      '你好，我是服务器报价助手 👋\n' +
      '你可以这样用：\n' +
      '· 指定机型选配：「5280M6，2颗6330N，512G内存，8块1.2T SAS，双口万兆」\n' +
      '· 只说需求，我自动选总价最低的机型：「要一台48核、256G内存、4块8T SATA盘的机器」\n' +
      '· 咨询报价原则：「5466M6 内存怎么插」「5280M6 两个显卡怎么配」');
    content.appendChild(p);
    wrap.appendChild(avatar);
    wrap.appendChild(content);
    $('#messages').appendChild(wrap);
  }

  function newChat() {
    chatContext = [];
    cardsClear();
    $('#messages').innerHTML = '';
    showWelcome();
  }

  function cardsClear() {
    Object.keys(cards).forEach((k) => delete cards[k]);
  }

  function appendUserMsg(text) {
    const wrap = el('div', 'msg user');
    wrap.appendChild(el('div', 'bubble', text));
    $('#messages').appendChild(wrap);
    scrollBottom();
  }

  function appendTyping() {
    const wrap = el('div', 'msg assistant');
    const avatar = el('div', 'avatar', 'AI');
    const content = el('div', 'assistant-content');
    const t = el('div', 'typing');
    t.appendChild(el('i'));
    t.appendChild(el('i'));
    t.appendChild(el('i'));
    content.appendChild(t);
    wrap.appendChild(avatar);
    wrap.appendChild(content);
    $('#messages').appendChild(wrap);
    scrollBottom();
    return wrap;
  }

  function appendAssistantMsg(reply, quote) {
    const wrap = el('div', 'msg assistant');
    const avatar = el('div', 'avatar', 'AI');
    const content = el('div', 'assistant-content');
    if (reply) content.appendChild(el('div', 'reply-text', reply));
    if (quote) content.appendChild(buildQuoteCard(quote));
    if (!reply && !quote) content.appendChild(el('div', 'reply-text', '（空回复）'));
    wrap.appendChild(avatar);
    wrap.appendChild(content);
    $('#messages').appendChild(wrap);
    scrollBottom();
  }

  function setSending(on) {
    $('#send').disabled = on;
  }

  async function send() {
    const ta = $('#input');
    const text = ta.value.trim();
    if (!text || sending) return;
    ta.value = '';
    ta.style.height = 'auto';
    appendUserMsg(text);
    chatContext.push({ role: 'user', content: text });
    sending = true;
    setSending(true);
    const tip = appendTyping();
    try {
      const r = await api('POST', '/api/chat', { messages: chatContext });
      tip.remove();
      appendAssistantMsg(r.reply, r.quote || null);
      chatContext.push({ role: 'assistant', content: r.contextSummary || r.reply || '' });
    } catch (e) {
      tip.remove();
      appendAssistantMsg('出错了：' + e.message, null);
    } finally {
      sending = false;
      setSending(false);
      $('#input').focus();
    }
  }

  // ---------- 报价卡片 ----------
  function buildQuoteCard(quote) {
    const id = 'c' + (++cardSeq);
    const c = {
      id, quote,
      manual: {},      // 缺项手动填价 {name:{price,qty}}
      overrides: {},   // 改价（仅本次报价生效）{name: price}
      editing: null,   // 正在改价的行 {name, value}
      pre: null, tableWrap: null, totalEl: null,
      currentSimple: '', currentDetail: '',
    };
    cards[id] = c;

    const card = el('div', 'quote-card');
    card.dataset.cardId = id;

    const head = el('div', 'qc-head');
    head.appendChild(el('span', 'qc-machine',
      quote.machine + (quote.machineVariant ? '（' + quote.machineVariant + '）' : '')));
    const total = el('span', 'qc-total', '合计：¥ ' + fmt(quote.total));
    total.dataset.role = 'total';
    head.appendChild(total);
    card.appendChild(head);
    c.totalEl = total;

    const tabs = el('div', 'qc-tabs');
    const tabSimple = el('button', 'qc-tab', '简洁版');
    const tabDetail = el('button', 'qc-tab active', '复杂版');
    tabs.appendChild(tabSimple);
    tabs.appendChild(tabDetail);
    card.appendChild(tabs);

    const paneSimple = el('div', 'qc-pane hidden');
    const pre = el('pre', 'simple-pre');
    paneSimple.appendChild(pre);
    const paneDetail = el('div', 'qc-pane');
    const tableWrap = el('div');
    paneDetail.appendChild(tableWrap);
    if (quote.missing && quote.missing.length) {
      paneDetail.appendChild(buildMissingSection(id, quote.missing));
    }
    card.appendChild(paneSimple);
    card.appendChild(paneDetail);
    c.pre = pre;
    c.tableWrap = tableWrap;
    recomputeCard(id); // 渲染初始简洁版/复杂版（与后端格式一致）

    if (quote.checks && quote.checks.length) {
      const d = el('div', 'qc-checks');
      d.appendChild(el('div', 'qc-sub', '✅ 规则自查'));
      quote.checks.forEach((c) => d.appendChild(el('div', 'qc-line', '· ' + c)));
      card.appendChild(d);
    }
    if (quote.notes && quote.notes.length) {
      const d = el('div', 'qc-notes');
      d.appendChild(el('div', 'qc-sub', 'ℹ️ 提醒'));
      quote.notes.forEach((c) => d.appendChild(el('div', 'qc-line', '· ' + c)));
      card.appendChild(d);
    }

    const foot = el('div', 'qc-foot');
    const bCopyS = el('button', 'qc-btn', '复制简洁版');
    const bCopyD = el('button', 'qc-btn', '复制复杂版');
    const bSave = el('button', 'qc-btn primary', '保存到历史');
    bCopyS.onclick = () => copyText(c.currentSimple, bCopyS);
    bCopyD.onclick = () => copyText(c.currentDetail, bCopyD);
    bSave.onclick = () => saveCard(id, bSave);
    foot.appendChild(bCopyS);
    foot.appendChild(bCopyD);
    foot.appendChild(bSave);
    card.appendChild(foot);

    tabSimple.onclick = () => {
      tabSimple.classList.add('active'); tabDetail.classList.remove('active');
      paneSimple.classList.remove('hidden'); paneDetail.classList.add('hidden');
    };
    tabDetail.onclick = () => {
      tabDetail.classList.add('active'); tabSimple.classList.remove('active');
      paneDetail.classList.remove('hidden'); paneSimple.classList.add('hidden');
    };

    return card;
  }

  function buildDetailTable(items, total) {
    const tbl = el('table');
    const thead = el('thead');
    const trh = el('tr');
    ['配件', '单价', '数量', '小计'].forEach((h, i) => {
      const th = el('th', i >= 1 ? 'num' : '', h);
      trh.appendChild(th);
    });
    thead.appendChild(trh);
    tbl.appendChild(thead);
    const tbody = el('tbody');
    (items || []).forEach((it) => {
      const tr = el('tr');
      tr.appendChild(el('td', '', it.name));
      tr.appendChild(el('td', 'num', fmt(it.price)));
      tr.appendChild(el('td', 'num', '×' + it.qty));
      tr.appendChild(el('td', 'num', fmt(it.subtotal)));
      tbody.appendChild(tr);
    });
    if (total !== null && total !== undefined) {
      const trT = el('tr', 'qc-total-row');
      const tdT = el('td', 'qc-total-label', '合计金额');
      tdT.colSpan = 3;
      trT.appendChild(tdT);
      trT.appendChild(el('td', 'num qc-total-num', fmt(total)));
      tbody.appendChild(trT);
    }
    tbl.appendChild(tbody);
    return tbl;
  }

  function buildMissingSection(cardId, missing) {
    const sec = el('div', 'qc-missing');
    sec.appendChild(el('div', 'qc-sub warn', '⚠️ 缺项（知识库中无价格，填价后将计入简洁版、复杂版表格与合计）'));
    missing.forEach((m) => {
      const row = el('div', 'missing-row');
      row.appendChild(el('span', 'm-name', m.name + (m.reason ? '（' + m.reason + '）' : '')));
      const qty = el('input', 'm-input');
      qty.type = 'number'; qty.min = '1'; qty.value = '1'; qty.title = '数量';
      const price = el('input', 'm-input');
      price.type = 'number'; price.min = '0'; price.placeholder = '单价'; price.title = '单价';
      const update = () => updateManual(cardId, m.name, price.value, qty.value);
      qty.oninput = update;
      price.oninput = update;
      row.appendChild(qty);
      row.appendChild(price);
      sec.appendChild(row);
    });
    return sec;
  }

  function updateManual(cardId, name, priceVal, qtyVal) {
    const c = cards[cardId];
    if (!c) return;
    const price = Math.max(0, Number(priceVal) || 0);
    const qty = Math.max(1, parseInt(qtyVal, 10) || 1);
    if (price > 0) c.manual[name] = { price, qty };
    else delete c.manual[name];
    recomputeCard(cardId);
  }

  function manualEntries(c) {
    return Object.keys(c.manual).map((name) => {
      const m = c.manual[name];
      return { name, note: '手动填价', price: m.price, qty: m.qty, subtotal: m.price * m.qty };
    });
  }

  // 目录件按「本次改价」计算生效单价（知识库价格本身不变）
  function effectiveItems(c) {
    return (c.quote.items || []).map((i) => {
      const overridden = c.overrides && c.overrides[i.name] !== undefined;
      const price = overridden ? c.overrides[i.name] : i.price;
      return Object.assign({}, i, { price, subtotal: price * i.qty, overridden });
    });
  }

  function originalPrice(c, name) {
    const it = (c.quote.items || []).find((i) => i.name === name);
    return it ? it.price : null;
  }

  function startEditPrice(c, name) {
    c.editing = { name, value: String(c.overrides[name] !== undefined ? c.overrides[name] : originalPrice(c, name)) };
    renderCardTable(c);
  }

  function confirmEditPrice(c) {
    if (!c.editing) return;
    const name = c.editing.name;
    const v = String(c.editing.value).trim();
    const num = Number(v);
    const orig = originalPrice(c, name);
    if (v === '' || !isFinite(num) || num < 0) {
      c.editing = null; // 非法输入视为取消
    } else if (orig !== null && num === orig) {
      delete c.overrides[name]; // 改回原价 = 取消改价
      c.editing = null;
    } else {
      c.overrides[name] = num;
      c.editing = null;
    }
    recomputeCard(c.id);
  }

  function cancelEditPrice(c) {
    c.editing = null;
    renderCardTable(c);
  }

  // 报价卡里替换配件：点配件名 → 输入关键词模糊搜索目录 → 点选即替换（数量保留）
  function pickSuggestion(c, oldName, s) {
    const arr = c.quote.items || [];
    const k = arr.findIndex((i) => i.name === oldName);
    c.nameEditing = null;
    if (k < 0) { renderCardTable(c); return; }
    const qty = arr[k].qty;
    arr[k] = {
      name: s.name, short: s.name, category: s.category || 'other', qty,
      price: s.price, note: s.note || '', subtotal: s.price * qty,
    };
    if (c.overrides) delete c.overrides[oldName]; // 换配件后旧改价不再适用
    recomputeCard(c.id);
  }

  // 报价卡里删除一行配件（目录件与手动填价行都可以删）
  function deleteCardRow(c, row) {
    if (!confirm('从本次报价中删除「' + row.name + '」？')) return;
    if (row.manual) {
      delete c.manual[row.name];
    } else {
      c.quote.items = (c.quote.items || []).filter((i) => i.name !== row.name);
      if (c.overrides) delete c.overrides[row.name];
    }
    recomputeCard(c.id);
  }

  // 复杂版表格（可改价）：每行带「改价/插入/删除」，仅影响本次报价
  function buildEditableTable(c) {
    const rows = effectiveItems(c).concat(manualEntries(c));
    const total = rows.reduce((s, i) => s + (i.subtotal || 0), 0);
    const tbl = el('table');
    const thead = el('thead');
    const trh = el('tr');
    ['配件', '单价', '数量', '小计', '操作'].forEach((h, i) => {
      const th = el('th', i >= 1 && i <= 3 ? 'num' : (i === 4 ? 'op-col' : ''), h);
      trh.appendChild(th);
    });
    thead.appendChild(trh);
    tbl.appendChild(thead);
    const tbody = el('tbody');

    // 「插入配件」输入行：点某行的「插入」后显示在该行下方（可搜目录，也可自定义名称手填价）
    let addRowPlaced = false;
    const appendAddRow = () => {
      addRowPlaced = true;
      const tr = el('tr', 'add-row');
      const tdN = el('td');
      const wrap = el('div', 'fz-wrap');
      const inN = el('input', 'edit-input fz-input');
      inN.type = 'text';
      inN.placeholder = '配件名：可搜索目录，也可自定义';
      inN.value = c.adding.name;
      const list = el('div', 'fz-list hidden');
      const renderList = () => {
        list.innerHTML = '';
        const sugs = c.adding.suggestions || [];
        if (!sugs.length) {
          if ((c.adding.name || '').trim()) {
            list.classList.remove('hidden');
            list.appendChild(el('div', 'fz-hint', '未匹配到目录配件 — 按 Enter / 确定 保存为自定义配件'));
          } else {
            list.classList.add('hidden');
          }
          return;
        }
        list.classList.remove('hidden');
        sugs.forEach((s) => {
          const opt = el('div', 'fz-item', s.name);
          opt.appendChild(el('span', 'fz-price', '¥' + fmt(s.price)));
          opt.onmousedown = (e) => { e.preventDefault(); pickAddSuggestion(c, s); };
          list.appendChild(opt);
        });
      };
      inN.oninput = () => {
        c.adding.name = inN.value;
        c.adding.picked = null;
        if (c.adding.timer) clearTimeout(c.adding.timer);
        c.adding.timer = setTimeout(async () => {
          try {
            const r = await api('GET', '/api/catalog-search?machine=' +
              encodeURIComponent(c.quote.machine) + '&q=' + encodeURIComponent(c.adding.name));
            c.adding.suggestions = r.items || [];
          } catch (e) { c.adding.suggestions = []; }
          renderList();
        }, 200);
      };
      inN.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); confirmAdd(c); } };
      wrap.appendChild(inN);
      wrap.appendChild(list);
      tdN.appendChild(wrap);
      tr.appendChild(tdN);

      const tdP = el('td', 'num');
      const inP = el('input', 'edit-input');
      inP.type = 'number';
      inP.min = '0';
      inP.placeholder = '单价';
      inP.value = c.adding.price;
      inP.oninput = () => { c.adding.price = inP.value; c.adding.picked = null; };
      tdP.appendChild(inP);
      tr.appendChild(tdP);

      const tdQ = el('td', 'num');
      const inQ = el('input', 'edit-input');
      inQ.type = 'number';
      inQ.min = '1';
      inQ.value = String(c.adding.qty || 1);
      inQ.oninput = () => { c.adding.qty = inQ.value; };
      tdQ.appendChild(inQ);
      tr.appendChild(tdQ);

      tr.appendChild(el('td', 'num', ''));
      const tdO = el('td', 'op-col');
      const ok = el('button', 'btn-edit ok', '确定');
      ok.onclick = () => confirmAdd(c);
      const cancel = el('button', 'btn-edit', '取消');
      cancel.onclick = () => { c.adding = null; renderCardTable(c); };
      tdO.appendChild(ok);
      tdO.appendChild(document.createTextNode(' '));
      tdO.appendChild(cancel);
      tr.appendChild(tdO);
      tbody.appendChild(tr);
      setTimeout(() => { inN.focus(); }, 0);
    };

    rows.forEach((row) => {
      const tr = el('tr');

      // 配件名列：点击可改（模糊搜索目录后点选替换），手动填价行不可改
      const tdName = el('td', 'qc-name-cell');
      const editingName = !!(c.nameEditing && c.nameEditing.oldName === row.name && !row.manual);
      if (editingName) {
        const wrap = el('div', 'fz-wrap');
        const input = el('input', 'edit-input fz-input');
        input.type = 'text';
        input.value = c.nameEditing.value;
        const list = el('div', 'fz-list hidden');
        const renderList = () => {
          list.innerHTML = '';
          const sugs = c.nameEditing.suggestions || [];
          if (!sugs.length) {
            // 没有匹配：显示提示（按 Enter 保存自定义），不隐藏下拉
            if ((c.nameEditing.value || '').trim()) {
              list.classList.remove('hidden');
              list.appendChild(el('div', 'fz-hint', '未匹配到目录配件 — 按 Enter 保存为自定义配件'));
            } else {
              list.classList.add('hidden');
            }
            return;
          }
          list.classList.remove('hidden');
          sugs.forEach((s) => {
            const opt = el('div', 'fz-item', s.name);
            opt.appendChild(el('span', 'fz-price', '¥' + fmt(s.price)));
            opt.onmousedown = (e) => { e.preventDefault(); pickSuggestion(c, row.name, s); };
            list.appendChild(opt);
          });
        };
        input.oninput = () => {
          c.nameEditing.value = input.value;
          if (c.nameEditing.timer) clearTimeout(c.nameEditing.timer);
          c.nameEditing.timer = setTimeout(async () => {
            try {
              const r = await api('GET', '/api/catalog-search?machine=' +
                encodeURIComponent(c.quote.machine) + '&q=' + encodeURIComponent(c.nameEditing.value));
              c.nameEditing.suggestions = r.items || [];
            } catch (e) { c.nameEditing.suggestions = []; }
            renderList();
          }, 200);
        };
        input.onkeydown = (e) => {
          if (e.key === 'Enter') {
            // 模糊匹配不到也允许保存：按 Enter 即用输入内容作为自定义配件名
            e.preventDefault();
            commitCustomName(c, row.name, input.value);
          }
          if (e.key === 'Escape') { e.preventDefault(); c.nameEditing = null; renderCardTable(c); }
        };
        wrap.appendChild(input);
        wrap.appendChild(list);
        tdName.appendChild(wrap);
        setTimeout(() => { input.focus(); input.select(); }, 0);
        renderList();
      } else {
        const nameSpan = el('span', row.manual ? '' : 'qc-name-editable', row.name);
        if (!row.manual) {
          nameSpan.title = '点击修改配件（输入关键词模糊搜索目录）';
          nameSpan.onclick = () => {
            c.nameEditing = { oldName: row.name, value: row.name, suggestions: [], timer: null };
            renderCardTable(c);
          };
        }
        tdName.appendChild(nameSpan);
      }
      tr.appendChild(tdName);

      const tdPrice = el('td', 'num');
      const isEditing = !!(c.editing && c.editing.name === row.name && !row.manual);
      if (isEditing) {
        const input = el('input', 'edit-input');
        input.type = 'number';
        input.min = '0';
        input.value = c.editing.value;
        input.oninput = () => { c.editing.value = input.value; };
        input.onkeydown = (e) => {
          if (e.key === 'Enter') { e.preventDefault(); confirmEditPrice(c); }
          if (e.key === 'Escape') { e.preventDefault(); cancelEditPrice(c); }
        };
        tdPrice.appendChild(input);
        setTimeout(() => { input.focus(); input.select(); }, 0);
      } else {
        tdPrice.appendChild(el('span', '', fmt(row.price)));
      }
      tr.appendChild(tdPrice);

      tr.appendChild(el('td', 'num', '×' + row.qty));
      tr.appendChild(el('td', 'num', fmt(row.subtotal)));

      const tdOp = el('td', 'op-col');
      if (editingName) {
        const cancel = el('button', 'btn-edit', '取消');
        cancel.onclick = () => { c.nameEditing = null; renderCardTable(c); };
        tdOp.appendChild(cancel);
      } else if (isEditing) {
        const ok = el('button', 'btn-edit ok', '确定');
        ok.onclick = () => confirmEditPrice(c);
        const cancel = el('button', 'btn-edit', '取消');
        cancel.onclick = () => cancelEditPrice(c);
        tdOp.appendChild(ok);
        tdOp.appendChild(document.createTextNode(' '));
        tdOp.appendChild(cancel);
      } else if (!row.manual) {
        const btn = el('button', 'btn-edit', '改价');
        btn.title = '仅修改本次报价，不改知识库价格';
        btn.onclick = () => startEditPrice(c, row.name);
        const ins = el('button', 'btn-edit', '插入');
        ins.title = '在这行下面插入一个新配件';
        ins.onclick = () => {
          c.adding = { name: '', qty: 1, price: '', picked: null, suggestions: [], timer: null, after: row.name };
          renderCardTable(c);
        };
        const del = el('button', 'btn-edit danger', '删除');
        del.onclick = () => deleteCardRow(c, row);
        tdOp.appendChild(btn);
        tdOp.appendChild(document.createTextNode(' '));
        tdOp.appendChild(ins);
        tdOp.appendChild(document.createTextNode(' '));
        tdOp.appendChild(del);
      } else {
        const ins = el('button', 'btn-edit', '插入');
        ins.title = '在这行下面插入一个新配件';
        ins.onclick = () => {
          c.adding = { name: '', qty: 1, price: '', picked: null, suggestions: [], timer: null, after: row.name };
          renderCardTable(c);
        };
        const del = el('button', 'btn-edit danger', '删除');
        del.onclick = () => deleteCardRow(c, row);
        tdOp.appendChild(el('span', 'op-hint', '手动 '));
        tdOp.appendChild(ins);
        tdOp.appendChild(document.createTextNode(' '));
        tdOp.appendChild(del);
      }
      tr.appendChild(tdOp);
      tbody.appendChild(tr);
      // 行级插入：在点击「插入」的那行下面显示输入行
      if (c.adding && c.adding.after === row.name) appendAddRow();
    });
    if (c.adding && !addRowPlaced) appendAddRow(); // 兜底：引用行不存在时显示在末尾

    // 合计金额行：所有配件之下
    const trT = el('tr', 'qc-total-row');
    const tdT = el('td', 'qc-total-label', '合计金额');
    tdT.colSpan = 3;
    trT.appendChild(tdT);
    trT.appendChild(el('td', 'num qc-total-num', '¥' + fmt(total)));
    trT.appendChild(el('td', ''));
    tbody.appendChild(trT);

    tbl.appendChild(tbody);
    return tbl;
  }

  // 把某行改名保存为自定义配件（目录里没有也能存）：转为手动填价行，价格沿用当前价
  function commitCustomName(c, oldName, rawName) {
    const newName = String(rawName || '').trim();
    if (!newName || newName === oldName) { c.nameEditing = null; renderCardTable(c); return; }
    const arr = c.quote.items || [];
    const k = arr.findIndex((i) => i.name === oldName);
    if (k >= 0) {
      const it = arr[k];
      const price = (c.overrides && c.overrides[oldName] !== undefined) ? c.overrides[oldName] : it.price;
      arr.splice(k, 1);
      if (c.overrides) delete c.overrides[oldName];
      c.manual[newName] = { qty: it.qty, price };
    }
    c.nameEditing = null;
    recomputeCard(c.id);
  }

  // 补配件：点选目录建议 → 按目录价加入；自定义名 → 按手填价加入
  function pickAddSuggestion(c, s) {
    c.adding.name = s.name;
    c.adding.price = String(s.price != null ? s.price : '');
    c.adding.picked = s;
    confirmAdd(c);
  }

  function confirmAdd(c) {
    const name = String(c.adding.name || '').trim();
    if (!name) { alert('请填写配件名（可搜索目录或自定义）'); return; }
    const qty = Math.max(1, parseInt(c.adding.qty, 10) || 1);
    const after = c.adding.after || null;
    if (c.adding.picked && c.adding.picked.name === name) {
      const s = c.adding.picked;
      const newItem = { name: s.name, short: s.name, category: s.category || 'other', qty, price: s.price, note: s.note || '' };
      c.quote.items = c.quote.items || [];
      // 插在引用行（目录件）的下面
      const k = after ? c.quote.items.findIndex((i) => i.name === after) : -1;
      if (k >= 0) c.quote.items.splice(k + 1, 0, newItem);
      else c.quote.items.push(newItem);
    } else {
      const entry = { qty, price: Math.max(0, Number(c.adding.price) || 0) };
      if (after && c.manual[after]) {
        // 引用行是手动件：保持手动件之间的先后顺序，插在它后面
        const next = {};
        Object.keys(c.manual).forEach((k) => {
          next[k] = c.manual[k];
          if (k === after) next[name] = entry;
        });
        c.manual = next;
      } else {
        c.manual[name] = entry; // 手动件统一显示在目录件之后
      }
    }
    c.adding = null;
    recomputeCard(c.id);
  }

  function renderCardTable(c) {
    if (!c.tableWrap) return;
    c.tableWrap.innerHTML = '';
    c.tableWrap.appendChild(buildEditableTable(c));
  }

  // 缺项填价/改价后：重算合计，并同步进简洁版文字与复杂版表格
  function recomputeCard(cardId) {
    const c = cards[cardId];
    if (!c) return;
    const manual = manualEntries(c);
    const items = effectiveItems(c);
    let total = 0;
    items.forEach((i) => (total += i.subtotal));
    manual.forEach((m) => (total += m.subtotal));

    // 简洁版：目录件用简称，缺项用名称，空格分隔 + 总价行
    const parts = items.map((i) => (i.qty > 1 ? i.short + '×' + i.qty : i.short));
    manual.forEach((m) => parts.push(m.qty > 1 ? m.name + '×' + m.qty : m.name));
    c.currentSimple = parts.join(' ') + '\n总价：' + total;
    if (c.pre) c.pre.textContent = c.currentSimple;

    // 复杂版表格（含改价与缺项行）
    renderCardTable(c);

    // 复杂版复制用 TSV（制表符分隔，粘贴进 Excel/WPS 自动分列成表格），不含备注列
    const tsv = ['配件\t单价\t数量\t小计'];
    items.forEach((i) => tsv.push(i.name + '\t' + i.price + '\t' + i.qty + '\t' + i.subtotal));
    manual.forEach((m) => tsv.push(m.name + '\t' + m.price + '\t' + m.qty + '\t' + m.subtotal));
    // 合计金额占位空列，让金额与小计列对齐
    tsv.push('合计金额\t\t\t' + total);
    c.currentDetail = tsv.join('\n');

    if (c.totalEl) c.totalEl.textContent = '合计：¥ ' + fmt(total);
  }

  // 保存报价：先问一句「这份报价给谁」，便于历史记录按客户查找
  function saveCard(cardId, btn) {
    const c = cards[cardId];
    if (!c) return;
    openModal('保存报价到历史');
    const body = $('#modal-body');
    body.appendChild(el('div', 'modal-hint', '记录这份报价是给谁的（客户/单位名称），便于以后按客户查找；可留空。'));
    const row = el('div', 'form-row item-field');
    row.appendChild(el('label', '', '客户'));
    const inClient = el('input', 'edit-input wide');
    inClient.type = 'text';
    inClient.maxLength = 60;
    inClient.placeholder = '如：济南某某科技有限公司';
    row.appendChild(inClient);
    body.appendChild(row);
    const btns = el('div', 'form-row');
    const ok = el('button', 'btn-edit ok', '保存');
    const cancel = el('button', 'btn-edit', '取消');
    btns.appendChild(ok);
    btns.appendChild(document.createTextNode(' '));
    btns.appendChild(cancel);
    body.appendChild(btns);
    cancel.onclick = closeModal;
    ok.onclick = async () => {
      const clientName = inClient.value.trim();
      closeModal();
      btn.disabled = true;
      btn.textContent = '保存中…';
      try {
        await api('POST', '/api/history', {
          clientName,
          text: (c.quote.requirement && c.quote.requirement.summary) || '',
          machine: c.quote.machine,
          machineVariant: c.quote.machineVariant,
          items: collectCardItems(c),
          missing: c.quote.missing || [],
        });
        btn.textContent = '已保存 ✓';
        loadHistory();
      } catch (e) {
        alert('保存失败：' + e.message);
        btn.disabled = false;
        btn.textContent = '保存到历史';
      }
    };
    setTimeout(() => { inClient.focus(); }, 0);
  }

  // 收集本次报价的配件（目录件 + 手动件），供服务端按生效价重渲染
  function collectCardItems(c) {
    const items = effectiveItems(c).map((i) => {
      const o = { name: i.name, qty: i.qty };
      if (i.overridden) { o.price = i.price; o.override = true; } // 改价仅本次生效，随本次报价入库
      return o;
    });
    Object.keys(c.manual).forEach((name) => {
      const m = c.manual[name];
      items.push({ name, qty: m.qty, price: m.price });
    });
    return items;
  }

  // ---------- 历史 ----------
  async function loadHistory() {
    try {
      const r = await api('GET', '/api/history');
      history = r.history || [];
      renderHistoryList();
    } catch (e) { /* 忽略 */ }
  }

  function renderHistoryList() {
    const list = $('#history-list');
    list.innerHTML = '';
    if (!history.length) {
      list.appendChild(el('div', 'history-item', '暂无历史报价'));
      return;
    }
    history.forEach((h) => {
      const item = el('div', 'history-item');
      const d = new Date(h.createdAt);
      const dateStr = d.getMonth() + 1 + '-' + d.getDate() + ' ' +
        String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
      item.appendChild(el('div', 'hi-title',
        (h.clientName ? '给「' + h.clientName + '」· ' : '') + (h.machine || '报价') + ' · ¥' + fmt(h.total)));
      item.appendChild(el('div', 'hi-sub', dateStr));
      const del = el('button', 'hi-del', '✕');
      del.title = '删除这条历史报价';
      del.onclick = async (e) => {
        e.stopPropagation();
        if (!confirm('删除这条历史报价？删除后不可恢复。')) return;
        try {
          await api('DELETE', '/api/history/' + encodeURIComponent(h.id));
          loadHistory();
        } catch (err) { alert(err.message); }
      };
      item.appendChild(del);
      item.onclick = () => openHistoryModal(h);
      list.appendChild(item);
    });
  }

  // ---------- 页面切换与配件价格表 ----------
  const CAT_LABELS = {
    bare: '空机', cpu: 'CPU', memory: '内存', disk: '硬盘', backplane: '硬盘背板',
    raid: '阵列卡/RAID', nic: '网卡', hba: 'HBA卡', power: '电源', riser: 'PCI转接卡',
    other: '其他',
  };
  const CAT_ORDER = ['bare', 'cpu', 'memory', 'disk', 'backplane', 'raid', 'nic', 'hba', 'power', 'riser', 'other'];

  function showPage(p) {
    $('#chat-page').classList.toggle('hidden', p !== 'chat');
    $('#price-page').classList.toggle('hidden', p !== 'price');
    $('#btn-prices').classList.toggle('active', p === 'price');
    if (p === 'price') loadPriceData();
  }

  let priceEdit = null; // 价格表改价进行中 {name, value}
  let priceBatch = null; // 批量编辑进行中 {edits: {原始名: {name, price}}}
  let priceTotalMode = false; // 当前显示「总表」而不是某个机型
  let priceTotal = []; // 总表条目（apiCatalog 返回）
  let dragMachineId = null; // 拖动排序中正在拖的机型 id

  async function loadPriceData() {
    const box = $('#price-content');
    box.innerHTML = '';
    box.appendChild(el('div', 'modal-hint', '加载中…'));
    try {
      const r = await api('GET', '/api/catalog');
      priceData = r.machines || [];
      priceTotal = r.totalSheet || [];
      if (!priceTotalMode && !priceMachineId || !priceData.some((m) => m.id === priceMachineId)) {
        const priced = priceData.find((m) => m.priced);
        priceMachineId = priced ? priced.id : (priceData[0] && priceData[0].id);
      }
    } catch (e) {
      box.innerHTML = '';
      box.appendChild(el('div', 'modal-hint', '加载失败：' + e.message));
      return;
    }
    renderPricePage();
  }

  function renderPricePage() {
    const isAdmin = me && me.role === 'admin';
    const tabs = $('#price-tabs');
    tabs.innerHTML = '';
    // 总表页签：与所有机型并列
    const bTotal = el('button', 'price-tab' + (priceTotalMode ? ' active' : ''), '📌 总表');
    bTotal.title = '所有已知配件的价格基准：改总表价格，所有同名配件同步';
    bTotal.onclick = () => { priceTotalMode = true; priceEdit = null; priceBatch = null; renderPricePage(); };
    tabs.appendChild(bTotal);
    (priceData || []).forEach((m) => {
      const b = el('button', 'price-tab' + (!priceTotalMode && m.id === priceMachineId ? ' active' : '') + (m.priced ? '' : ' disabled'),
        m.family + (m.priced ? '' : '（暂无价格）'));
      if (m.priced || me.role === 'admin') {
        b.onclick = () => { priceMachineId = m.id; priceTotalMode = false; priceEdit = null; priceBatch = null; renderPricePage(); };
      }
      // 管理员可拖动页签调整机型顺序
      if (isAdmin) {
        b.draggable = true;
        b.title = m.family + '（拖动可调整机型顺序）';
        b.ondragstart = (e) => {
          dragMachineId = m.id;
          e.dataTransfer.effectAllowed = 'move';
          try { e.dataTransfer.setData('text/plain', m.id); } catch (err) { /* 忽略 */ }
        };
        b.ondragover = (e) => { e.preventDefault(); };
        b.ondrop = (e) => { e.preventDefault(); reorderMachineDrag(dragMachineId, m.id); };
        b.ondragend = () => { dragMachineId = null; };
      }
      tabs.appendChild(b);
    });

    if (isAdmin && !priceTotalMode && priceMachineId) {
      const cur = (priceData || []).find((x) => x.id === priceMachineId);
      const ops = el('div', 'price-toolbar machine-ops');

      const bNew = el('button', 'btn-edit ok', '＋ 新增机型');
      bNew.onclick = () => openMachineModal();
      ops.appendChild(bNew);

      const bRules = el('button', 'btn-edit', '✎ 选型规则');
      bRules.title = '查看/编辑该机型的报价原则（选型规则），可手动编辑或导入 md/txt 文件';
      bRules.onclick = () => openRulesModal();
      ops.appendChild(bRules);
      ops.appendChild(document.createTextNode(' '));

      const bRename = el('button', 'btn-edit', '✎ 改机型名');
      bRename.title = '只改显示名，内部数据不受影响';
      bRename.onclick = () => openRenameModal();
      ops.appendChild(bRename);

      const bDel = el('button', 'btn-edit danger', '🗑 删除机型');
      bDel.title = '删除该机型及其配件与改价记录（内置机型不支持）';
      bDel.onclick = () => deleteMachine();
      ops.appendChild(bDel);
      ops.appendChild(document.createTextNode(' '));

      if (cur && !cur.priced) {
        ops.appendChild(el('span', 'op-hint', ' 新机型还没有配件：用「批量导入」补充；未填选型规则时 AI 暂不自动选配它'));
      }
      ops.appendChild(el('span', 'op-hint', ' 机型顺序：直接拖动上方页签调整'));
      tabs.appendChild(ops);
    }
    renderPriceTable();
  }

  // 拖动排序：把 src 拖到 dst 的位置后整体保存
  async function reorderMachineDrag(srcId, dstId) {
    if (!srcId || !dstId || srcId === dstId) return;
    const ids = (priceData || []).map((m) => m.id);
    const from = ids.indexOf(srcId);
    const to = ids.indexOf(dstId);
    if (from < 0 || to < 0) return;
    ids.splice(to, 0, ids.splice(from, 1)[0]);
    try {
      await api('POST', '/api/machine', { action: 'reorder', order: ids });
      await loadPriceData();
    } catch (e) { alert(e.message); }
  }

  // 删除机型（仅在线新增的机型；内置机型后端会拒绝）
  async function deleteMachine() {
    const m = (priceData || []).find((x) => x.id === priceMachineId);
    if (!m) return;
    if (!confirm('删除机型「' + m.family + '」？\n其配件、改价记录、选型规则将一并删除，且不可恢复。')) return;
    try {
      await api('DELETE', '/api/machine/' + encodeURIComponent(m.id));
      priceTotalMode = false;
      priceMachineId = null;
      await loadPriceData();
    } catch (e) { alert(e.message); }
  }

  // 查看/编辑机型选型规则（报价原则）：手动编辑或导入 md/txt 文件
  function openRulesModal() {
    const m = (priceData || []).find((x) => x.id === priceMachineId);
    if (!m) return;
    openModal('选型规则 — ' + m.family);
    const body = $('#modal-body');
    body.appendChild(el('div', 'modal-hint',
      '这是 AI 给该机型选配件时必须遵守的规则（报价原则）。改完立即对 AI 报价生效；填了规则、有配件的机型即可被 AI 选配。导入 .md/.txt 文件会【追加】到现有规则后面，不会覆盖（doc/docx 请先另存为 txt）。'));
    const ta = el('textarea', 'edit-input wide rules-ta');
    ta.rows = 12;
    ta.value = m.rulesMd || '';
    ta.placeholder = '报价原则（选型规则）：AI 选配该机型时必须遵守的规则';
    body.appendChild(ta);

    const fileRow = el('div', 'form-row');
    const file = el('input');
    file.type = 'file';
    file.accept = '.md,.markdown,.txt,.text,.doc,.docx';
    const bFile = el('button', 'btn-edit', '📂 导入 md/txt 文件');
    bFile.onclick = () => file.click();
    const fileHint = el('span', 'op-hint', '');
    file.onchange = () => {
      const f = file.files && file.files[0];
      if (!f) return;
      const reader = new FileReader();
      reader.onload = () => {
        const text = String(reader.result || '');
        if (text.indexOf('\u0000') !== -1) {
          alert('这个文件看起来是二进制格式（doc/docx）。请先用 Word/WPS「另存为 → 纯文本(.txt)」再导入。');
          return;
        }
        // 追加而不是替换：新内容粘在原有规则后面，管理员可再手动编辑后保存
        const cur = ta.value.replace(/\s+$/, '');
        ta.value = (cur ? cur + '\n\n' : '') + text.trim();
        fileHint.textContent = '已追加到现有规则后面：' + f.name + '（可继续编辑，点「保存规则」生效）';
      };
      reader.readAsText(f, 'utf-8');
    };
    fileRow.appendChild(bFile);
    fileRow.appendChild(document.createTextNode(' '));
    fileRow.appendChild(fileHint);
    file.style.display = 'none';
    fileRow.appendChild(file);
    body.appendChild(fileRow);

    const btns = el('div', 'form-row');
    const ok = el('button', 'btn-edit ok', '保存规则');
    const cancel = el('button', 'btn-edit', '取消');
    btns.appendChild(ok);
    btns.appendChild(document.createTextNode(' '));
    btns.appendChild(cancel);
    body.appendChild(btns);
    cancel.onclick = closeModal;
    ok.onclick = async () => {
      try {
        await api('POST', '/api/machine', { action: 'rules', id: m.id, rulesMd: ta.value });
        closeModal();
        await loadPriceData();
      } catch (e) { alert(e.message); }
    };
  }

  // 新增机型：名称必填；报价原则可粘贴或复制现有机型，留空则 AI 暂不选配该机型
  function openMachineModal() {
    openModal('新增机型');
    const body = $('#modal-body');
    body.appendChild(el('div', 'modal-hint',
      '建好后默认没有配件，用「批量导入」补充（配件内容与价格统一在总表维护）。报价原则可留空——留空时 AI 暂不自动选配它，用户点名时仍可报价。'));

    const mkField = (labelText, input) => {
      const row = el('div', 'form-row item-field');
      row.appendChild(el('label', '', labelText));
      row.appendChild(input);
      return row;
    };
    const inName = el('input', 'edit-input wide');
    inName.type = 'text';
    inName.placeholder = '机型名称，如：NF5180M6';
    const taRules = el('textarea', 'edit-input wide');
    taRules.rows = 5;
    taRules.placeholder = '报价原则（可留空）：AI 选配该机型时必须遵守的规则';
    const selCopy = el('select', 'edit-input wide');
    const o0 = el('option', '', '不复制报价原则');
    o0.value = '';
    selCopy.appendChild(o0);
    (priceData || []).forEach((m) => {
      const o = el('option', '', '复制「' + m.family + '」的报价原则');
      o.value = m.id;
      selCopy.appendChild(o);
    });
    body.appendChild(mkField('名称', inName));
    body.appendChild(mkField('报价原则', taRules));
    body.appendChild(mkField('或复制', selCopy));

    const row = el('div', 'form-row');
    const ok = el('button', 'btn-edit ok', '创建');
    const cancel = el('button', 'btn-edit', '取消');
    row.appendChild(ok);
    row.appendChild(document.createTextNode(' '));
    row.appendChild(cancel);
    body.appendChild(row);
    cancel.onclick = closeModal;
    ok.onclick = async () => {
      try {
        await api('POST', '/api/machine', {
          action: 'create',
          name: inName.value,
          rulesMd: taRules.value,
          copyFrom: selCopy.value || undefined,
        });
        closeModal();
        await loadPriceData();
      } catch (e) { alert(e.message); }
    };
  }

  // 改机型显示名（内部代号不变，改价/配件/历史数据不受影响）
  function openRenameModal() {
    const m = (priceData || []).find((x) => x.id === priceMachineId);
    if (!m) return;
    openModal('改机型名（只改显示名）');
    const body = $('#modal-body');
    const inName = el('input', 'edit-input wide');
    inName.type = 'text';
    inName.value = m.family;
    const row = el('div', 'form-row item-field');
    row.appendChild(el('label', '', '名称'));
    row.appendChild(inName);
    body.appendChild(row);
    const btns = el('div', 'form-row');
    const ok = el('button', 'btn-edit ok', '保存');
    const cancel = el('button', 'btn-edit', '取消');
    btns.appendChild(ok);
    btns.appendChild(document.createTextNode(' '));
    btns.appendChild(cancel);
    body.appendChild(btns);
    cancel.onclick = closeModal;
    ok.onclick = async () => {
      try {
        await api('POST', '/api/machine', { action: 'rename', id: m.id, name: inName.value });
        closeModal();
        await loadPriceData();
      } catch (e) { alert(e.message); }
    };
  }

  // 批量导入：从总表或其他机型勾选配件导入当前机型（机型来源的名称自动替换机型代号，总表原样导入）
  function openImportModal() {
    const target = priceMachineId;
    const targetM = (priceData || []).find((x) => x.id === target);
    if (!targetM) return;
    const sources = [{ id: '__TOTAL__', family: '📌 总表（按名字原样导入）' }]
      .concat((priceData || []).filter((m) => m.id !== target));
    openModal('批量导入配件到「' + targetM.family + '」');
    const body = $('#modal-body');

    const selRow = el('div', 'form-row item-field');
    selRow.appendChild(el('label', '', '来源机型'));
    const sel = el('select', 'edit-input wide');
    sources.forEach((m) => {
      const o = el('option', '', m.family);
      o.value = m.id;
      sel.appendChild(o);
    });
    selRow.appendChild(sel);
    body.appendChild(selRow);

    const checked = new Set();
    const info = el('div', 'modal-hint', '已勾选 0 项');
    const kwRow = el('div', 'form-row item-field');
    kwRow.appendChild(el('label', '', '搜索'));
    const inKw = el('input', 'edit-input wide');
    inKw.type = 'text';
    inKw.placeholder = '按名称/参数过滤';
    kwRow.appendChild(inKw);
    body.appendChild(kwRow);

    const list = el('div', 'imp-list');
    body.appendChild(list);

    const btnRow = el('div', 'form-row');
    const bAll = el('button', 'btn-edit', '全选(筛选结果)');
    const bNone = el('button', 'btn-edit', '清空勾选');
    const bGo = el('button', 'btn-edit ok', '导入勾选项');
    btnRow.appendChild(bAll);
    btnRow.appendChild(document.createTextNode(' '));
    btnRow.appendChild(bNone);
    btnRow.appendChild(document.createTextNode(' '));
    btnRow.appendChild(bGo);
    body.appendChild(btnRow);
    body.appendChild(info);

    function sourceItems() {
      const kw = inKw.value.trim().toLowerCase();
      let list;
      if (sel.value === '__TOTAL__') {
        list = priceTotal.filter((i) =>
          !kw || ((i.name + ' ' + (i.short || '') + ' ' + (i.note || '')).toLowerCase().includes(kw)));
      } else {
        const src = (priceData || []).find((m) => m.id === sel.value);
        list = ((src && src.items) || []).filter((i) =>
          !kw || ((i.name + ' ' + (i.short || '') + ' ' + (i.note || '')).toLowerCase().includes(kw)));
      }
      // 按名称字典序排列，与价格表一致，便于查找
      return list.sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh-Hans-CN'));
    }
    function renderList() {
      list.innerHTML = '';
      const items = sourceItems();
      // 与价格表/总表一致：按配件分类分组（同一顺序），组内按名称字典序
      const groups = [];
      CAT_ORDER.forEach((cat) => {
        const g = items.filter((i) => (i.category || 'other') === cat);
        if (g.length) groups.push([CAT_LABELS[cat] || cat, g]);
      });
      items.filter((i) => CAT_ORDER.indexOf(i.category || 'other') === -1).forEach((i) => {
        groups.push([i.category || 'other', [i]]);
      });
      if (!items.length) {
        info.textContent = '没有匹配的配件，已勾选 ' + checked.size + ' 项';
        return;
      }
      groups.forEach(([label, g]) => {
        const head = el('div', 'imp-group');
        const allNames = g.map((i) => i.name);
        const cbAll = el('input');
        cbAll.type = 'checkbox';
        cbAll.checked = allNames.length > 0 && allNames.every((n) => checked.has(n));
        cbAll.title = '全选/取消本类';
        cbAll.onchange = () => {
          allNames.forEach((n) => (cbAll.checked ? checked.add(n) : checked.delete(n)));
          renderList();
        };
        head.appendChild(cbAll);
        head.appendChild(el('span', '', label + '（勾选=全选本类）'));
        list.appendChild(head);
        g.forEach((i) => {
          const r = el('div', 'imp-row');
          const cb = el('input');
          cb.type = 'checkbox';
          cb.checked = checked.has(i.name);
          cb.onchange = () => {
            if (cb.checked) checked.add(i.name); else checked.delete(i.name);
            info.textContent = '已勾选 ' + checked.size + ' 项';
          };
          const lab = el('label', '', i.name);
          r.appendChild(cb);
          r.appendChild(lab);
          r.appendChild(el('span', 'fz-price', i.price === null || i.price === undefined ? '—' : '¥' + fmt(i.price)));
          list.appendChild(r);
        });
      });
      info.textContent = '已勾选 ' + checked.size + ' 项';
    }
    sel.onchange = () => { checked.clear(); renderList(); };
    inKw.oninput = renderList;
    bAll.onclick = () => { sourceItems().forEach((i) => checked.add(i.name)); renderList(); };
    bNone.onclick = () => { checked.clear(); renderList(); };
    bGo.onclick = async () => {
      if (!checked.size) { alert('请先勾选要导入的配件'); return; }
      try {
        const r = await api('POST', '/api/catalog-items-import', {
          machine: target, source: sel.value, names: Array.from(checked),
        });
        closeModal();
        await loadPriceData();
        alert('导入完成：' + r.imported + ' 个' + (r.skipped && r.skipped.length ? '，跳过 ' + r.skipped.length + ' 个（目标机型已有同名或来源缺失）' : ''));
      } catch (e) { alert(e.message); }
    };
    renderList();
  }

  // 管理员改价（持久生效，存服务端）：报价与价格表口径同步；改价即彻底改，改错了就再改一次
  async function savePriceOverride(machineId, name, price) {
    await api('POST', '/api/price-override', { machine: machineId, name, price });
    priceEdit = null;
    await loadPriceData();
  }

  // 批量编辑保存：只提交真正改动的行（改名/改价/删除），一次原子写入（总表模式走总表接口，删除写穿各机型）
  async function saveBatchEdits(items, machineId) {
    const isTotal = !machineId;
    const changes = [];
    for (const orig of Object.keys(priceBatch.edits)) {
      if (priceBatch.deletions && priceBatch.deletions.has(orig)) continue; // 待删行不提交修改
      const e = priceBatch.edits[orig];
      const cur = (items || []).find((i) => i.name === orig);
      if (!cur) continue; // 行已被其他操作删掉
      const newName = String(e.name || '').trim();
      const nameChanged = newName !== orig;
      const priceChanged = normPrice(e.price) !== normPrice(cur.price);
      if (!nameChanged && !priceChanged) continue;
      if (!newName) { alert('配件名不能为空（' + orig + '），请填好再保存'); return; }
      changes.push({
        oldName: orig,
        item: {
          name: newName,
          short: cur.short,
          category: cur.category,
          // 总表允许空价格（null）；机型配件必须要有价格
          price: isTotal ? (normPrice(e.price) === '' ? null : Number(e.price)) : (isFinite(Number(e.price)) ? e.price : cur.price),
          note: cur.note || '',
          attrs: cur.attrs || null,
          maxQty: cur.maxQty || null,
        },
      });
    }
    const deletions = isTotal && priceBatch.deletions ? Array.from(priceBatch.deletions) : [];
    if (!changes.length && !deletions.length) { priceBatch = null; renderPriceTable(); return; }
    if (deletions.length) {
      if (!confirm('将保存 ' + changes.length + ' 条修改，并删除 ' + deletions.length +
        ' 个配件：\n' + deletions.join('、') +
        '\n\n⚠️ 各机型里的同名配件将一并删除，且不可恢复。确定？')) return;
    }
    try {
      if (machineId) await api('POST', '/api/catalog-items-batch', { machine: machineId, changes });
      else await api('POST', '/api/total-items-batch', { changes, deletions });
      priceBatch = null;
      await loadPriceData();
    } catch (e) { alert(e.message); }
  }

  // 机型内批量删除：仅从本机型移除所选配件，总表与其他机型完全不受影响
  async function confirmMachineDeletes(m) {
    const names = Array.from(priceBatch.deletions);
    if (!names.length) { alert('还没有标记要删除的配件：点每行的「删除」先标记'); return; }
    if (!confirm('将从机型「' + m.family + '」移除 ' + names.length + ' 个配件：\n' + names.join('、') +
      '\n\n仅影响本机型；总表与其他机型不受影响。确定？')) return;
    try {
      await api('POST', '/api/catalog-items-batch', { machine: m.id, deletions: names });
      priceBatch = null;
      await loadPriceData();
    } catch (e) { alert(e.message); }
  }

  // 管理员配件增删改（持久生效）：LLM 报价、价格表、校验统一使用生效目录。isTotal=true 时操作总表。
  function openItemModal(machineId, item, isTotal) {
    const isEdit = !!item;
    openModal(isEdit ? '编辑配件' : '新增配件');
    const body = $('#modal-body');
    const hint = el('div', 'modal-hint',
      '名称与参数说明要写清楚（型号/规格/容量/接口等），AI 报价按这里的内容理解并选用配件，无需改任何提示词。');
    body.appendChild(hint);

    const mkField = (labelText, input) => {
      const row = el('div', 'form-row item-field');
      const lab = el('label', '', labelText);
      row.appendChild(lab);
      row.appendChild(input);
      return row;
    };

    const inName = el('input', 'edit-input wide');
    inName.type = 'text';
    inName.value = isEdit ? item.name : '';
    inName.placeholder = '如：64GB DDR5 RDIMM 5600';

    const selCat = el('select', 'edit-input wide');
    const cats = CAT_ORDER.slice();
    if (isEdit && item.category && cats.indexOf(item.category) === -1) cats.push(item.category);
    cats.forEach((c) => {
      const opt = el('option', '', CAT_LABELS[c] || c);
      opt.value = c;
      if ((isEdit ? item.category : 'other') === c) opt.selected = true;
      selCat.appendChild(opt);
    });

    const inPrice = el('input', 'edit-input wide');
    inPrice.type = 'number';
    inPrice.min = '0';
    inPrice.value = isEdit && item.price !== null && item.price !== undefined ? String(item.price) : '';
    inPrice.placeholder = isTotal ? '单价（可留空，稍后在总表补价）' : '单价（元）';

    const inNote = el('textarea', 'edit-input wide');
    inNote.rows = 3;
    inNote.placeholder = '参数说明：内存条数/频率、盘位接口、电源瓦数、槽位宽度等，AI 据此判断兼容与规则';
    inNote.value = isEdit ? (item.note || '') : '';

    const inAttrs = el('textarea', 'edit-input wide');
    inAttrs.rows = 2;
    inAttrs.placeholder = '附加参数 JSON（可选），如 {"capacityGB":64}';
    inAttrs.value = isEdit && item.attrs ? JSON.stringify(item.attrs) : '';

    body.appendChild(mkField('名称', inName));
    body.appendChild(mkField('分类', selCat));
    body.appendChild(mkField('单价', inPrice));
    body.appendChild(mkField('参数说明', inNote));
    body.appendChild(mkField('附加参数', inAttrs));

    const row = el('div', 'form-row');
    const ok = el('button', 'btn-edit ok', '保存');
    const cancel = el('button', 'btn-edit', '取消');
    row.appendChild(ok);
    row.appendChild(document.createTextNode(' '));
    row.appendChild(cancel);
    body.appendChild(row);

    cancel.onclick = closeModal;
    ok.onclick = async () => {
      if (isTotal) {
        // 客户端先行校验：空名 / 与总表重复，直接弹窗拒绝，不发请求
        const nm = inName.value.trim();
        if (!nm) { alert('配件名不能为空，请填写名称'); return; }
        if ((!isEdit || nm !== item.name) && priceTotal.some((t) => t.name === nm)) {
          alert('总表中已有同名配件：「' + nm + '」。\n请换一个名字，或直接编辑那个配件。');
          return;
        }
      }
      let attrs = null;
      const attrsRaw = inAttrs.value.trim();
      if (attrsRaw) {
        try { attrs = JSON.parse(attrsRaw); } catch (e) { alert('附加参数不是合法 JSON'); return; }
      }
      const payload = {
        machine: machineId,
        oldName: isEdit ? item.name : undefined,
        item: {
          name: inName.value,
          short: isEdit ? (item.short || undefined) : undefined, // 编辑时保留原简称
          category: selCat.value,
          price: inPrice.value,
          note: inNote.value,
          attrs,
          maxQty: isEdit ? (item.maxQty || undefined) : undefined,
        },
      };
      try {
        if (isTotal) await api('POST', '/api/total-item', { oldName: isEdit ? item.name : undefined, item: payload.item });
        else await api('POST', '/api/catalog-item', payload);
        closeModal();
        await loadPriceData();
      } catch (err) {
        alert(err.message);
      }
    };
  }

  async function deleteCatalogItem(machineId, item, isTotal) {
    if (isTotal) {
      if (!confirm('从总表删除「' + item.name + '」？\n⚠️ 所有机型里的同名配件将一并删除，且不可恢复！')) return;
      try {
        await api('DELETE', '/api/total-item/' + encodeURIComponent(item.name));
        await loadPriceData();
      } catch (e) { alert(e.message); }
      return;
    }
    if (!confirm('删除配件「' + item.name + '」？删除立即生效并同步给所有用户（AI 也不再选用它）。')) return;
    try {
      await api('DELETE', '/api/catalog-item/' + encodeURIComponent(machineId) + '/' + encodeURIComponent(item.name));
      await loadPriceData();
    } catch (err) {
      alert(err.message);
    }
  }

  // 把所有机型里有、总表里没有的配件加入总表
  async function syncTotal() {
    try {
      const r = await api('POST', '/api/total-sync');
      await loadPriceData();
      alert(r.added ? '已把 ' + r.added + ' 个新配件加入总表' : '总表已是最新（没有需要新增的配件）');
    } catch (e) { alert(e.message); }
  }

  // 总表视图：所有已知配件的价格基准。改总表价 → 所有机型同名配件的报价同步使用总表价。
  function renderTotalTable() {
    const box = $('#price-content');
    box.innerHTML = '';
    const isAdmin = me && me.role === 'admin';
    box.appendChild(el('div', 'price-banner admin',
      '总表 = 所有配件的唯一主数据：修改总表（价格/描述/名称/分类）会立即写穿到所有机型里的同名配件；删除总表配件时，所有机型里的同名配件一并删除。' +
      '机型页的「批量导入」可直接从总表选配件。'));

    if (isAdmin) {
      const toolbar = el('div', 'price-toolbar');
      if (!priceBatch) {
        const addBtn = el('button', 'btn-edit ok', '+ 新增配件');
        addBtn.onclick = () => openItemModal(null, null, true);
        toolbar.appendChild(addBtn);
        toolbar.appendChild(document.createTextNode(' '));
        const batchBtn = el('button', 'btn-edit', '批量编辑');
        batchBtn.title = '直接在表格里一次改多个配件的名称和价格，也可勾选删除';
        batchBtn.onclick = () => { priceBatch = { edits: {}, deletions: new Set() }; renderPriceTable(); };
        toolbar.appendChild(batchBtn);
        toolbar.appendChild(document.createTextNode(' '));
        const syncBtn = el('button', 'btn-edit', '⇩ 同步所有机型配件进总表');
        syncBtn.title = '把所有机型里有、总表里没有的配件加入总表（按名字去重）';
        syncBtn.onclick = () => syncTotal();
        toolbar.appendChild(syncBtn);
      } else {
        const saveBtn = el('button', 'btn-edit ok', '保存全部修改');
        saveBtn.onclick = () => saveBatchEdits(priceTotal, null);
        const cancelBtn = el('button', 'btn-edit', '取消批量');
        cancelBtn.onclick = () => { priceBatch = null; renderPriceTable(); };
        toolbar.appendChild(saveBtn);
        toolbar.appendChild(document.createTextNode(' '));
        toolbar.appendChild(cancelBtn);
        toolbar.appendChild(el('span', 'op-hint', ' 直接改名称和价格（可留空，稍后补）；点「删除」标记要删的行（再点撤销），改完点「保存全部修改」'));
      }
      box.appendChild(toolbar);
    }

    const kw = priceKeyword.trim().toLowerCase();
    const rows = priceTotal.filter((i) =>
      !kw || ((i.name + ' ' + (i.short || '') + ' ' + (i.note || '')).toLowerCase().includes(kw)));

    const cols = isAdmin ? ['配件', '单价', '操作'] : ['配件', '单价'];
    const tbl = el('table');
    const thead = el('thead');
    const trh = el('tr');
    cols.forEach((h, i) => {
      const th = el('th', i === 1 ? 'num' : (i === 2 ? 'op-col' : ''), h);
      trh.appendChild(th);
    });
    thead.appendChild(trh);
    tbl.appendChild(thead);

    const tbody = el('tbody');
    let shown = 0;
    const groups = [];
    CAT_ORDER.forEach((cat) => {
      const list = rows.filter((i) => (i.category || 'other') === cat);
      list.sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh-Hans-CN'));
      if (list.length) groups.push([cat, list]);
    });
    rows.filter((i) => CAT_ORDER.indexOf(i.category || 'other') === -1).forEach((i) => {
      groups.push([i.category || 'other', [i]]);
    });

    groups.forEach(([cat, list]) => {
      const ctr = el('tr', 'cat-row');
      const ctd = el('td', '', '📌 ' + (CAT_LABELS[cat] || cat));
      ctd.colSpan = cols.length;
      ctr.appendChild(ctd);
      tbody.appendChild(ctr);
      list.forEach((i) => {
        const tr = el('tr');
        const toBeDeleted = !!(priceBatch && priceBatch.deletions && priceBatch.deletions.has(i.name));
        const tdName = el('td');
        if (priceBatch) {
          const e0 = priceBatch.edits[i.name] || (priceBatch.edits[i.name] = { name: i.name, price: i.price });
          const inN = el('input', 'edit-input batch-name');
          inN.type = 'text';
          inN.value = e0.name;
          inN.oninput = () => {
            e0.name = inN.value;
            tr.classList.toggle('batch-changed',
              e0.name !== i.name || normPrice(e0.price) !== normPrice(i.price));
          };
          tdName.appendChild(inN);
        } else {
          tdName.appendChild(document.createTextNode(i.name));
        }
        tr.appendChild(tdName);

        const tdPrice = el('td', 'num');
        if (priceBatch) {
          const e0 = priceBatch.edits[i.name];
          const inP = el('input', 'edit-input');
          inP.type = 'number';
          inP.min = '0';
          inP.placeholder = '可留空';
          inP.value = e0.price === null || e0.price === undefined ? '' : String(e0.price);
          inP.oninput = () => {
            e0.price = inP.value;
            tr.classList.toggle('batch-changed',
              e0.name !== i.name || normPrice(e0.price) !== normPrice(i.price));
          };
          tdPrice.appendChild(inP);
        } else {
          tdPrice.appendChild(el('span', '', i.price === null || i.price === undefined ? '—' : fmt(i.price)));
        }
        tr.appendChild(tdPrice);

        if (isAdmin) {
          const tdOp = el('td', 'op-col');
          if (priceBatch) {
            const delBtn = el('button', 'btn-edit danger', toBeDeleted ? '撤销删除' : '删除');
            delBtn.onclick = () => {
              if (priceBatch.deletions.has(i.name)) priceBatch.deletions.delete(i.name);
              else priceBatch.deletions.add(i.name);
              renderPriceTable();
            };
            tdOp.appendChild(delBtn);
          } else {
            const editBtn = el('button', 'btn-edit', '编辑');
            editBtn.onclick = () => openItemModal(null, i, true);
            const delBtn = el('button', 'btn-edit danger', '删除');
            delBtn.onclick = () => deleteCatalogItem(null, i, true);
            tdOp.appendChild(editBtn);
            tdOp.appendChild(document.createTextNode(' '));
            tdOp.appendChild(delBtn);
          }
          tr.appendChild(tdOp);
        }
        if (toBeDeleted) tr.classList.add('batch-del');
        tbody.appendChild(tr);
        shown++;
      });
    });
    tbl.appendChild(tbody);
    if (!shown) {
      box.appendChild(el('div', 'modal-hint', '总表还没有配件：点「⇩ 同步所有机型配件进总表」或「+ 新增配件」'));
      return;
    }
    box.appendChild(tbl);
  }

  function renderPriceTable() {
    if (priceTotalMode) return renderTotalTable();
    const box = $('#price-content');
    box.innerHTML = '';
    const m = (priceData || []).find((x) => x.id === priceMachineId);
    if (!m) return;
    const isAdmin = me && me.role === 'admin';

    if (isAdmin) {
      box.appendChild(el('div', 'price-banner admin',
        '配件的名称/价格/描述统一在「📌 总表」编辑（修改会写穿到这里）；本页用「批量导入」加配件、「批量删除」清理导入失误——批量删除只删本机型，总表与其他机型不受影响。'));
      const toolbar = el('div', 'price-toolbar');
      if (priceBatch && priceBatch.mode === 'machine-delete') {
        const delBtn = el('button', 'btn-edit danger', '删除所选（' + priceBatch.deletions.size + '）');
        delBtn.onclick = () => confirmMachineDeletes(m);
        const cancelBtn = el('button', 'btn-edit', '取消');
        cancelBtn.onclick = () => { priceBatch = null; renderPriceTable(); };
        toolbar.appendChild(delBtn);
        toolbar.appendChild(document.createTextNode(' '));
        toolbar.appendChild(cancelBtn);
        toolbar.appendChild(el('span', 'op-hint', ' 点每行「删除」标记（再点撤销），确认后仅从本机型移除'));
      } else {
        const impBtn = el('button', 'btn-edit', '批量导入');
        impBtn.title = '从总表或其他机型勾选配件批量导入当前机型';
        impBtn.onclick = () => openImportModal();
        toolbar.appendChild(impBtn);
        toolbar.appendChild(document.createTextNode(' '));
        const delBtn = el('button', 'btn-edit danger', '批量删除');
        delBtn.title = '标记多个配件，一次从本机型移除（总表不受影响）';
        delBtn.onclick = () => { priceBatch = { mode: 'machine-delete', deletions: new Set() }; renderPriceTable(); };
        toolbar.appendChild(delBtn);
      }
      box.appendChild(toolbar);
    }

    const kw = priceKeyword.trim().toLowerCase();
    const rows = (m.items || []).filter((i) =>
      !kw || ((i.name + ' ' + (i.short || '') + ' ' + (i.note || '')).toLowerCase().includes(kw)));

    const delMode = !!(priceBatch && priceBatch.mode === 'machine-delete');
    const cols = delMode ? ['配件', '单价', '操作'] : ['配件', '单价'];
    const tbl = el('table');
    const thead = el('thead');
    const trh = el('tr');
    cols.forEach((h, i) => {
      const th = el('th', i === 1 ? 'num' : (i === 2 ? 'op-col' : ''), h);
      trh.appendChild(th);
    });
    thead.appendChild(trh);
    tbl.appendChild(thead);

    const tbody = el('tbody');
    let shown = 0;
    const groups = [];
    CAT_ORDER.forEach((cat) => {
      const list = rows.filter((i) => (i.category || 'other') === cat);
      // 组内按名称字典序固定排序：新增/改名/导入的配件不再跑到列表末尾
      list.sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh-Hans-CN'));
      if (list.length) groups.push([cat, list]);
    });
    rows.filter((i) => CAT_ORDER.indexOf(i.category || 'other') === -1).forEach((i) => {
      groups.push([i.category || 'other', [i]]);
    });

    groups.forEach(([cat, list]) => {
      const ctr = el('tr', 'cat-row');
      const ctd = el('td', '', CAT_LABELS[cat] || cat);
      ctd.colSpan = cols.length;
      ctr.appendChild(ctd);
      tbody.appendChild(ctr);
      list.forEach((i) => {
        const tr = el('tr');
        tr.appendChild(el('td', '', i.name));
        tr.appendChild(el('td', 'num', i.price === null || i.price === undefined ? '—' : fmt(i.price)));
        if (delMode) {
          const toBeDeleted = priceBatch.deletions.has(i.name);
          const tdOp = el('td', 'op-col');
          const delBtn = el('button', 'btn-edit danger', toBeDeleted ? '撤销删除' : '删除');
          delBtn.onclick = () => {
            if (priceBatch.deletions.has(i.name)) priceBatch.deletions.delete(i.name);
            else priceBatch.deletions.add(i.name);
            renderPriceTable();
          };
          tdOp.appendChild(delBtn);
          tr.appendChild(tdOp);
          if (toBeDeleted) tr.classList.add('batch-del');
        }
        tbody.appendChild(tr);
        shown++;
      });
    });
    tbl.appendChild(tbody);

    if (!shown) {
      box.appendChild(el('div', 'modal-hint', '没有匹配的配件'));
      return;
    }
    box.appendChild(tbl);
  }

  // ---------- 弹窗 ----------
  function openModal(title) {
    $('#modal-title').textContent = title;
    $('#modal-body').innerHTML = '';
    $('#modal-mask').classList.remove('hidden');
  }

  function closeModal() {
    $('#modal-mask').classList.add('hidden');
    $('#modal-body').innerHTML = '';
  }

  function openHistoryModal(h) {
    openModal((h.clientName ? '给「' + h.clientName + '」· ' : '') + (h.machine || '报价') + ' · 合计 ¥' + fmt(h.total));
    const body = $('#modal-body');
    if (h.text) body.appendChild(el('div', 'qc-line', '需求：' + h.text));
    if (h.clientName) body.appendChild(el('div', 'qc-line', '客户：' + h.clientName));
    if (h.machineVariant) body.appendChild(el('div', 'qc-line', '版本：' + h.machineVariant));

    body.appendChild(el('div', 'qc-sub', '简洁版'));
    body.appendChild(el('pre', 'modal-pre', h.simple));

    body.appendChild(el('div', 'qc-sub', '复杂版'));
    body.appendChild(buildDetailTable(h.items, h.total));
    if (h.missing && h.missing.length) {
      const d = el('div', 'qc-sub warn', '缺项');
      body.appendChild(d);
      h.missing.forEach((m) => body.appendChild(el('div', 'qc-line', '· ' + m.name + (m.reason ? '（' + m.reason + '）' : ''))));
    }
    body.appendChild(el('div', 'qc-line', '总价：' + fmt(h.total)));

    const foot = el('div', 'form-row');
    const b1 = el('button', '', '复制简洁版');
    const b2 = el('button', '', '复制复杂版');
    b1.onclick = () => copyText(h.simple, b1);
    b2.onclick = () => copyText(h.detail, b2);
    foot.appendChild(b1);
    foot.appendChild(b2);
    body.appendChild(foot);
  }

  async function openAdminModal() {
    openModal('账号管理');
    const body = $('#modal-body');

    const form = el('div', 'form-row');
    const inUser = el('input'); inUser.placeholder = '新账号（2-32位）';
    const inPass = el('input'); inPass.type = 'password'; inPass.placeholder = '初始密码（至少6位）';
    const btnAdd = el('button', '', '添加账号');
    form.appendChild(inUser); form.appendChild(inPass); form.appendChild(btnAdd);
    body.appendChild(form);
    const hint = el('div', 'modal-hint', '说明：删除账号后，该账号立即失去所有权限，其历史报价一并删除。管理员账号不可删除。');
    body.appendChild(hint);

    const listBox = el('div');
    body.appendChild(listBox);

    async function refresh() {
      listBox.innerHTML = '';
      try {
        const r = await api('GET', '/api/users');
        (r.users || []).forEach((u) => {
          const row = el('div', 'user-row');
          row.appendChild(el('span', 'u-name', u.username));
          row.appendChild(el('span', 'u-role', u.role === 'admin' ? '管理员' : '普通用户'));
          const del = el('button', 'u-del', '删除');
          if (u.role === 'admin') { del.disabled = true; del.textContent = '不可删除'; }
          del.onclick = async () => {
            if (!confirm('确定删除账号「' + u.username + '」？该账号将立即失去所有权限。')) return;
            try {
              await api('DELETE', '/api/users/' + encodeURIComponent(u.username));
              refresh();
            } catch (e) { alert(e.message); }
          };
          row.appendChild(del);
          listBox.appendChild(row);
        });
      } catch (e) {
        listBox.appendChild(el('div', 'modal-hint', e.message));
      }
    }

    btnAdd.onclick = async () => {
      const username = inUser.value.trim();
      const password = inPass.value;
      if (!username || !password) { alert('请输入账号和密码'); return; }
      btnAdd.disabled = true;
      try {
        await api('POST', '/api/users', { username, password });
        inUser.value = ''; inPass.value = '';
        refresh();
      } catch (e) { alert(e.message); }
      finally { btnAdd.disabled = false; }
    };

    refresh();
  }

  function openChangePassModal() {
    openModal('修改密码');
    const body = $('#modal-body');
    const inOld = el('input'); inOld.type = 'password'; inOld.placeholder = '原密码';
    const inNew = el('input'); inNew.type = 'password'; inNew.placeholder = '新密码（至少6位）';
    const inNew2 = el('input'); inNew2.type = 'password'; inNew2.placeholder = '再输一遍新密码';
    const btn = el('button', '', '确认修改');
    const row = el('div');
    [inOld, inNew, inNew2].forEach((x) => { x.style.marginBottom = '10px'; x.style.width = '100%'; x.style.padding = '9px 10px'; x.style.border = '1px solid #d9dce1'; x.style.borderRadius = '8px'; row.appendChild(x); });
    row.appendChild(btn);
    body.appendChild(row);
    btn.onclick = async () => {
      if (inNew.value !== inNew2.value) { alert('两次输入的新密码不一致'); return; }
      btn.disabled = true;
      try {
        await api('POST', '/api/change-password', { oldPassword: inOld.value, newPassword: inNew.value });
        alert('修改成功，下次登录请使用新密码');
        closeModal();
      } catch (e) { alert(e.message); }
      finally { btn.disabled = false; }
    };
  }

  // ---------- 事件绑定 ----------
  $('#login-btn').onclick = doLogin;
  $('#login-pass').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
  $('#login-user').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
  $('#send').onclick = send;
  $('#new-chat').onclick = () => { showPage('chat'); newChat(); };
  $('#btn-prices').onclick = () => showPage('price');
  $('#btn-logout').onclick = () => doLogout(false);
  $('#btn-admin').onclick = openAdminModal;
  $('#btn-change-pass').onclick = openChangePassModal;
  $('#modal-close').onclick = closeModal;
  // 弹窗只通过「保存/取消/✕」关闭：点窗格外部不退出，防止误触丢失正在编辑的内容

  const ta = $('#input');
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
  });
  ta.addEventListener('input', () => {
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 160) + 'px';
  });

  $('#price-search').addEventListener('input', () => {
    priceKeyword = $('#price-search').value;
    renderPriceTable();
  });

  // ---------- 启动 ----------
  function showLogin() {
    $('#login-view').classList.remove('hidden');
  }

  if (token) {
    // 已有 token：尝试恢复会话
    api('GET', '/api/me')
      .then((r) => { me = { username: r.username, role: r.role }; enterApp(); })
      .catch(() => { token = ''; localStorage.removeItem('qa_token'); showLogin(); });
  } else {
    showLogin();
  }
})();
