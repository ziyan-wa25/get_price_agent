/* 报价助手前端逻辑：登录 / DS 风格对话报价 / 缺项手动填价 / 历史回看 / 管理员账号管理 */
(function () {
  'use strict';

  const API = String((window.APP_CONFIG && window.APP_CONFIG.API_BASE) || '').replace(/\/+$/, '');

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

  function buildDetailTable(items) {
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

  // 复杂版表格（可改价）：每行带「改价」按钮，仅影响本次报价
  function buildEditableTable(c) {
    const rows = effectiveItems(c).concat(manualEntries(c));
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
    rows.forEach((row) => {
      const tr = el('tr');
      tr.appendChild(el('td', '', row.name));

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
      if (isEditing) {
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
        tdOp.appendChild(btn);
      } else {
        tdOp.appendChild(el('span', 'op-hint', '手动价'));
      }
      tr.appendChild(tdOp);
      tbody.appendChild(tr);
    });
    tbl.appendChild(tbody);
    return tbl;
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

    // 复杂版复制用 markdown（与后端格式一致，不含备注列）
    const md = ['| 配件 | 单价 | 数量 | 小计 |', '| --- | --- | --- | --- |'];
    items.forEach((i) =>
      md.push('| ' + i.name + ' | ' + i.price + ' | ' + i.qty + ' | ' + i.subtotal + ' |'));
    manual.forEach((m) =>
      md.push('| ' + m.name + ' | ' + m.price + ' | ' + m.qty + ' | ' + m.subtotal + ' |'));
    md.push('');
    md.push('总价：' + total);
    c.currentDetail = md.join('\n');

    if (c.totalEl) c.totalEl.textContent = '合计：¥ ' + fmt(total);
  }

  async function saveCard(cardId, btn) {
    const c = cards[cardId];
    if (!c) return;
    const items = effectiveItems(c).map((i) => {
      const o = { name: i.name, qty: i.qty };
      if (i.overridden) { o.price = i.price; o.override = true; } // 改价仅本次生效，随本次报价入库
      return o;
    });
    Object.keys(c.manual).forEach((name) => {
      const m = c.manual[name];
      items.push({ name, qty: m.qty, price: m.price });
    });
    btn.disabled = true;
    btn.textContent = '保存中…';
    try {
      await api('POST', '/api/history', {
        text: (c.quote.requirement && c.quote.requirement.summary) || '',
        machine: c.quote.machine,
        machineVariant: c.quote.machineVariant,
        items,
        missing: c.quote.missing || [],
      });
      btn.textContent = '已保存 ✓';
      loadHistory();
    } catch (e) {
      alert('保存失败：' + e.message);
      btn.disabled = false;
      btn.textContent = '保存到历史';
    }
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
      item.appendChild(el('div', 'hi-title', (h.machine || '报价') + ' · ¥' + fmt(h.total)));
      item.appendChild(el('div', 'hi-sub', dateStr));
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

  async function loadPriceData() {
    const box = $('#price-content');
    box.innerHTML = '';
    box.appendChild(el('div', 'modal-hint', '加载中…'));
    try {
      const r = await api('GET', '/api/catalog');
      priceData = r.machines || [];
      if (!priceMachineId || !priceData.some((m) => m.id === priceMachineId)) {
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
    const tabs = $('#price-tabs');
    tabs.innerHTML = '';
    (priceData || []).forEach((m) => {
      const b = el('button', 'price-tab' + (m.id === priceMachineId ? ' active' : '') + (m.priced ? '' : ' disabled'),
        m.family + (m.priced ? '' : '（暂无价格）'));
      if (m.priced) {
        b.onclick = () => { priceMachineId = m.id; priceEdit = null; renderPricePage(); };
      }
      tabs.appendChild(b);
    });
    renderPriceTable();
  }

  // 管理员改价（持久生效，存服务端）：报价与价格表口径同步；改价即彻底改，改错了就再改一次
  async function savePriceOverride(machineId, name, price) {
    await api('POST', '/api/price-override', { machine: machineId, name, price });
    priceEdit = null;
    await loadPriceData();
  }

  function renderPriceTable() {
    const box = $('#price-content');
    box.innerHTML = '';
    const m = (priceData || []).find((x) => x.id === priceMachineId);
    if (!m) return;
    const isAdmin = me && me.role === 'admin';

    if (isAdmin) {
      box.appendChild(el('div', 'price-banner admin',
        '管理员改价：点「改价」修改单价，改价即彻底改、持久生效（价格表与报价同步使用新价）。'));
    }

    const kw = priceKeyword.trim().toLowerCase();
    const rows = (m.items || []).filter((i) =>
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

        const tdPrice = el('td', 'num');
        const editing = !!(priceEdit && priceEdit.name === i.name);
        if (editing) {
          const input = el('input', 'edit-input');
          input.type = 'number';
          input.min = '0';
          input.value = priceEdit.value;
          input.oninput = () => { priceEdit.value = input.value; };
          input.onkeydown = (e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              savePriceOverride(m.id, i.name, priceEdit.value).catch((err) => alert(err.message));
            }
            if (e.key === 'Escape') { e.preventDefault(); priceEdit = null; renderPriceTable(); }
          };
          tdPrice.appendChild(input);
          setTimeout(() => { input.focus(); input.select(); }, 0);
        } else {
          tdPrice.appendChild(el('span', '',
            i.price === null || i.price === undefined ? '—' : fmt(i.price)));
        }
        tr.appendChild(tdPrice);

        if (isAdmin) {
          const tdOp = el('td', 'op-col');
          if (editing) {
            const ok = el('button', 'btn-edit ok', '确定');
            ok.onclick = () => savePriceOverride(m.id, i.name, priceEdit.value).catch((err) => alert(err.message));
            const cancel = el('button', 'btn-edit', '取消');
            cancel.onclick = () => { priceEdit = null; renderPriceTable(); };
            tdOp.appendChild(ok);
            tdOp.appendChild(document.createTextNode(' '));
            tdOp.appendChild(cancel);
          } else {
            const btn = el('button', 'btn-edit', '改价');
            btn.onclick = () => { priceEdit = { name: i.name, value: String(i.price) }; renderPriceTable(); };
            tdOp.appendChild(btn);
          }
          tr.appendChild(tdOp);
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
    openModal((h.machine || '报价') + ' · 合计 ¥' + fmt(h.total));
    const body = $('#modal-body');
    if (h.text) body.appendChild(el('div', 'qc-line', '需求：' + h.text));
    if (h.machineVariant) body.appendChild(el('div', 'qc-line', '版本：' + h.machineVariant));

    body.appendChild(el('div', 'qc-sub', '简洁版'));
    body.appendChild(el('pre', 'modal-pre', h.simple));

    body.appendChild(el('div', 'qc-sub', '复杂版'));
    body.appendChild(buildDetailTable(h.items));
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
  $('#modal-mask').addEventListener('click', (e) => { if (e.target === $('#modal-mask')) closeModal(); });

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
