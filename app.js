/* 报价助手前端逻辑：登录 / DS 风格对话报价 / 缺项手动填价 / 历史回看 / 管理员账号管理 */
(function () {
  'use strict';

  const API = String((window.APP_CONFIG && window.APP_CONFIG.API_BASE) || '').replace(/\/+$/, '');
  console.log('[报价系统] app.js build v20260619-16（零库存标红/fixed列宽/中文检索/重设密码弹窗/导出三列含库房/强制改密/批量改删一体）'); // 版本标记：F12 可确认浏览器加载的是哪个版本

  // ---------- 状态 ----------
  // 模拟登录：地址栏 ?imp=<token> → 存入本标签页的 sessionStorage（不影响 admin 自己标签页的登录态），并立即从地址栏抹掉
  (function () {
    const m = location.search.match(/[?&]imp=([^&]+)/);
    if (m) {
      try { sessionStorage.setItem('qa_imp_token', decodeURIComponent(m[1])); } catch (e) {}
      try { history.replaceState(null, '', location.pathname); } catch (e) {}
    }
  })();

  let token = localStorage.getItem('qa_token') || '';
  let impToken = sessionStorage.getItem('qa_imp_token') || '';
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
    const t = impToken || token; // 模拟登录标签页用被模拟者的身份
    if (t) headers['Authorization'] = 'Bearer ' + t;
    let res;
    try {
      res = await fetch(API + path, { method, headers, body: body ? JSON.stringify(body) : undefined, cache: 'no-store' }); // 禁用 HTTP 缓存：换账号后绝不允许命中上一任用户的响应
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
      sessionStorage.removeItem('qa_imp_token'); // 正式登录会覆盖模拟登录态
      impToken = '';
      me = { username: r.username, role: r.role, mustChange: !!r.mustChange };
      if (r.mustChange) { forceChangePassword(p); return; } // 仍用初始密码：必须先改密才能进入系统
      enterApp();
      enterApp();
    } catch (e) {
      $('#login-err').textContent = e.message;
    } finally {
      btn.disabled = false;
    }
  }

  // 强制修改初始密码：改成功前不进入系统
  function forceChangePassword(prefillOld) {
    openModal('安全要求：请先修改初始密码');
    const body = $('#modal-body');
    body.appendChild(el('div', 'modal-hint', '检测到该账号仍在使用初始密码。为安全起见，必须修改密码后才能使用系统。'));
    const iOld = el('input'); iOld.type = 'password'; iOld.placeholder = '当前密码（初始密码）'; iOld.value = prefillOld || '';
    const iNew = el('input'); iNew.type = 'password'; iNew.placeholder = '新密码（至少 6 位，不能与当前密码相同）';
    const iNew2 = el('input'); iNew2.type = 'password'; iNew2.placeholder = '确认新密码';
    body.appendChild(iOld); body.appendChild(iNew); body.appendChild(iNew2);
    const foot = el('div', 'form-row');
    const bOk = el('button', 'primary', '修改密码并进入系统');
    bOk.onclick = async () => {
      const np = iNew.value;
      if (np.length < 6) { alert('新密码至少 6 位'); return; }
      if (np !== iNew2.value) { alert('两次输入的新密码不一致'); return; }
      if (np === iOld.value) { alert('新密码不能与当前密码相同'); return; }
      bOk.disabled = true;
      try {
        await api('POST', '/api/change-password', { oldPassword: iOld.value, newPassword: np });
        me.mustChange = false;
        closeModal();
        enterApp();
      } catch (e) { alert(e.message); }
      finally { bOk.disabled = false; }
    };
    foot.appendChild(bOk);
    body.appendChild(foot);
  }

  function doLogout(expired) {
    token = '';
    me = null;
    chatContext = [];
    localStorage.removeItem('qa_token');
    sessionStorage.removeItem('qa_imp_token');
    impToken = '';
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
    // 模拟登录按需求与正常页面完全一致：不显示任何横幅/提示（退出=关闭该标签页，或重新正式登录）
    resetUserData(); // 清掉上一任用户留在内存里的页面数据（价格/库存/应收/历史），防止越权残留
    newChat();
    loadHistory();
    $('#input').focus();
  }

  // 切换账号时必须清空的按用户缓存 + 回到报价页
  function resetUserData() {
    stockData = null;
    stockBatchMode = null;
    stockEdits = {};
    stockDelSel = new Set();
    stockWhEdits = {};
    recvData = null;
    recvFilter = '';
    recvSel = new Set();
    recvClientFilter = '';
    priceData = null;
    priceTotal = [];
    priceMachineId = null;
    priceTotalMode = false;
    priceEdit = null;
    priceBatch = null;
    dragMachineId = null;
    history = [];
    $('#history-list').innerHTML = '';
    $('#price-content').innerHTML = '';
    $('#stock-content').innerHTML = '';
    $('#recv-content').innerHTML = '';
    $('#stock-info').innerHTML = '';
    $('#recv-info').innerHTML = '';
    $('#recv-filter').innerHTML = '';
    showPage('chat');
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
    const p = el('div', 'reply-text', '您好，亲爱的' + (me && me.username ? me.username : '') + '，我是您的AI助手，让我们开始一天愉快的工作吧！');
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
      (quote.machineFamily || quote.machine) + (quote.machineVariant ? '（' + quote.machineVariant + '）' : '')));
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

  // 单价/数量就地编辑：点击单元格直接进入输入状态（Enter/失焦保存，Esc 取消），目录件与手动件都支持
  function startEditCell(c, row, field) {
    c.nameEditing = null;
    c.editing = { name: row.name, field, value: field === 'qty' ? String(row.qty) : String(row.price) };
    renderCardTable(c);
  }

  function confirmEditCell(c) {
    if (!c.editing) return;
    const e = c.editing;
    c.editing = null; // 先清状态，防止 Enter 与失焦双重提交
    const num = Number(String(e.value).trim());
    const arr = c.quote.items || [];
    const k = arr.findIndex((i) => i.name === e.name);
    const isCatalog = k >= 0;
    if (e.field === 'qty') {
      const v = parseInt(e.value, 10);
      if (!isFinite(v) || v < 1) { renderCardTable(c); return; } // 非法数量视为取消
      if (isCatalog) arr[k].qty = v;
      else if (c.manual[e.name]) c.manual[e.name].qty = v;
    } else {
      if (e.value === '' || !isFinite(num) || num < 0) { renderCardTable(c); return; } // 非法价格视为取消
      if (isCatalog) {
        const orig = originalPrice(c, e.name);
        if (orig !== null && num === orig) delete c.overrides[e.name]; // 改回原价 = 取消改价
        else c.overrides[e.name] = num; // 仅本次报价生效，不改知识库价格
      } else if (c.manual[e.name]) {
        c.manual[e.name].price = num;
      }
    }
    recomputeCard(c.id);
  }

  function cancelEditCell(c) {
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
        // 搜索不准时的两种出路：总表里有 → 浏览总表选一个；总表里没有 → 自定义加入
        const addBtn = el('button', 'fz-add-custom', '➕ 把「' + (c.adding.name || '').trim() + '」按上方单价/数量加入本次报价');
        addBtn.type = 'button';
        addBtn.onmousedown = (e) => { e.preventDefault(); confirmAdd(c); };
        const tpBtn = el('button', 'fz-add-custom', '📚 从总表中加入…（浏览总表全部配件）');
        tpBtn.type = 'button';
        tpBtn.onmousedown = (e) => { e.preventDefault(); openTotalPicker(c, 'add'); };
        if (!sugs.length) {
          if ((c.adding.name || '').trim()) {
            list.classList.remove('hidden');
            list.appendChild(el('div', 'fz-hint', '未匹配到目录配件：'));
            list.appendChild(tpBtn);
            list.appendChild(addBtn);
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
        if ((c.adding.name || '').trim()) {
          list.appendChild(tpBtn);
          list.appendChild(addBtn);
        }
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
          // 搜索不准时的两种出路：总表里有 → 浏览总表选一个替换；总表里没有 → 自定义替换
          const addBtn = el('button', 'fz-add-custom', '➕ 用「' + (c.nameEditing.value || '').trim() + '」替换该配件（保留数量与改价）');
          addBtn.type = 'button';
          addBtn.onmousedown = (e) => { e.preventDefault(); commitCustomName(c, row.name, c.nameEditing.value); };
          const tpBtn = el('button', 'fz-add-custom', '📚 从总表中选择替换…（浏览总表全部配件）');
          tpBtn.type = 'button';
          tpBtn.onmousedown = (e) => { e.preventDefault(); openTotalPicker(c, 'rename', row.name); };
          if (!sugs.length) {
            // 没有匹配：显示提示（按 Enter 保存自定义），不隐藏下拉
            if ((c.nameEditing.value || '').trim()) {
              list.classList.remove('hidden');
              list.appendChild(el('div', 'fz-hint', '未匹配到目录配件：'));
              list.appendChild(tpBtn);
              list.appendChild(addBtn);
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
          if ((c.nameEditing.value || '').trim()) {
            list.appendChild(tpBtn);
            list.appendChild(addBtn);
          }
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
      const isEditing = !!(c.editing && c.editing.name === row.name);
      if (isEditing && c.editing.field === 'price') {
        const input = el('input', 'edit-input');
        input.type = 'number';
        input.min = '0';
        input.value = c.editing.value;
        input.oninput = () => { c.editing.value = input.value; };
        input.onkeydown = (e) => {
          if (e.key === 'Enter') { e.preventDefault(); confirmEditCell(c); }
          if (e.key === 'Escape') { e.preventDefault(); cancelEditCell(c); }
        };
        input.onblur = () => confirmEditCell(c);
        tdPrice.appendChild(input);
        setTimeout(() => { input.focus(); input.select(); }, 0);
      } else {
        const pSpan = el('span', 'cell-edit', fmt(row.price));
        pSpan.title = '点击修改单价（仅本次报价生效）';
        pSpan.onclick = () => startEditCell(c, row, 'price');
        tdPrice.appendChild(pSpan);
      }
      tr.appendChild(tdPrice);

      const tdQty = el('td', 'num');
      if (isEditing && c.editing.field === 'qty') {
        const input = el('input', 'edit-input');
        input.type = 'number';
        input.min = '1';
        input.value = c.editing.value;
        input.oninput = () => { c.editing.value = input.value; };
        input.onkeydown = (e) => {
          if (e.key === 'Enter') { e.preventDefault(); confirmEditCell(c); }
          if (e.key === 'Escape') { e.preventDefault(); cancelEditCell(c); }
        };
        input.onblur = () => confirmEditCell(c);
        tdQty.appendChild(input);
        setTimeout(() => { input.focus(); input.select(); }, 0);
      } else {
        const qSpan = el('span', 'cell-edit', '×' + row.qty);
        qSpan.title = '点击修改数量';
        qSpan.onclick = () => startEditCell(c, row, 'qty');
        tdQty.appendChild(qSpan);
      }
      tr.appendChild(tdQty);

      tr.appendChild(el('td', 'num', fmt(row.subtotal)));

      const tdOp = el('td', 'op-col');
      if (editingName) {
        const cancel = el('button', 'btn-edit', '取消');
        cancel.onclick = () => { c.nameEditing = null; renderCardTable(c); };
        tdOp.appendChild(cancel);
      } else if (isEditing) {
        const ok = el('button', 'btn-edit ok', '确定');
        ok.onclick = () => confirmEditCell(c);
        const cancel = el('button', 'btn-edit', '取消');
        cancel.onclick = () => cancelEditCell(c);
        tdOp.appendChild(ok);
        tdOp.appendChild(document.createTextNode(' '));
        tdOp.appendChild(cancel);
      } else if (!row.manual) {
        const ins = el('button', 'btn-edit', '插入');
        ins.title = '在这行下面插入一个新配件';
        ins.onclick = () => {
          c.adding = { name: '', qty: 1, price: '', picked: null, suggestions: [], timer: null, after: row.name };
          renderCardTable(c);
        };
        const del = el('button', 'btn-edit danger', '删除');
        del.onclick = () => deleteCardRow(c, row);
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

  // 从总表选择配件加入本次报价（搜索不准但总表里有时用）：mode 'add'=新增一行 / 'rename'=替换某行
  async function openTotalPicker(c, mode, oldName) {
    if (!priceTotal || !priceTotal.length) await loadPriceData(); // 报价页可能还没加载过目录
    openModal('从总表选择配件');
    const body = $('#modal-body');
    body.appendChild(el('div', 'modal-hint',
      mode === 'add'
        ? '在总表中找到想要的配件，点一下即按总表价加入本次报价（不影响总表）。'
        : '在总表中找到想要的配件，点一下即替换该配件（保留数量；本次改价失效）。'));
    const inQ = el('input', 'edit-input wide');
    inQ.type = 'text';
    inQ.placeholder = '在总表中搜索（名称/简称/描述）';
    const listBox = el('div', 'imp-list total-pick-list');
    body.appendChild(inQ);
    body.appendChild(listBox);
    const renderL = () => {
      listBox.innerHTML = '';
      const kw = inQ.value.trim().toLowerCase();
      const rows = priceTotal.filter((t) => !kw ||
        ((t.name + ' ' + (t.short || '') + ' ' + (t.note || '')).toLowerCase().includes(kw)));
      if (!rows.length) {
        listBox.appendChild(el('div', 'modal-hint', '总表中没有匹配的配件——关闭本窗，用下拉里的「把输入内容加入本次报价」自定义。'));
        return;
      }
      const groups = [];
      CAT_ORDER.forEach((cat) => {
        const list = rows.filter((t) => (t.category || 'other') === cat);
        list.sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh-Hans-CN'));
        if (list.length) groups.push([CAT_LABELS[cat] || cat, list]);
      });
      rows.filter((t) => CAT_ORDER.indexOf(t.category || 'other') === -1).forEach((t) => {
        groups.push([t.category || 'other', [t]]);
      });
      groups.forEach(([label, list]) => {
        listBox.appendChild(el('div', 'imp-group', label));
        list.forEach((t) => {
          const r = el('div', 'imp-row total-pick-row');
          const lab = el('label', '', t.name);
          lab.onmousedown = (e) => { e.preventDefault(); pickTotal(c, mode, oldName, t); };
          r.appendChild(lab);
          r.appendChild(el('span', 'fz-price', t.price === null || t.price === undefined ? '—' : '¥' + fmt(t.price)));
          listBox.appendChild(r);
        });
      });
    };
    inQ.oninput = () => renderL();
    renderL();
    setTimeout(() => { inQ.focus(); }, 0);
  }

  function pickTotal(c, mode, oldName, t) {
    closeModal();
    const s = { name: t.name, category: t.category || 'other', price: t.price == null ? 0 : t.price, note: t.note || '' };
    if (mode === 'add') {
      c.adding = c.adding || { name: '', qty: 1, price: '', picked: null, suggestions: [], timer: null, after: null };
      pickAddSuggestion(c, s); // 按总表价加入本次报价（数量沿用输入行的数量）
    } else {
      pickSuggestion(c, oldName, s); // 替换该配件（保留数量）
    }
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
  // ---------- 库存表（独立于报价/LLM） ----------
  const ROLE_LABELS = { admin: '管理员', user: '普通用户', uploader: '库存上传员', exporter: '库存导出员' };
  let stockData = null;      // GET /api/stock 结果：{items, lastImportAt, lastImportBy, lastPriceChangeAt, lastPriceChangeBy, canSeePrice, canImport, canExport, canEdit}
  let stockBatchMode = null; // null | 'edit'（admin：整行改+标记删除） | 'wh'（库存导出员：仅改备注库房）
  let stockEdits = {};       // 批量修改进行中的整行副本 {原始货品名称: {name, qty, cost, price, note, wh}}
  let stockDelSel = new Set(); // 批量删除勾选
  let stockWhEdits = {};     // 导出员的库房备注编辑副本 {原始货品名称: 新wh}

  async function loadStock() {
    const box = $('#stock-content');
    box.innerHTML = '';
    box.appendChild(el('div', 'modal-hint', '加载中…'));
    try {
      stockData = await api('GET', '/api/stock');
    } catch (e) {
      box.innerHTML = '';
      box.appendChild(el('div', 'modal-hint', '加载失败：' + e.message));
      return;
    }
    renderStockPage();
  }

  function stockFiltered() {
    const kw = ($('#stock-search').value || '').trim().toLowerCase();
    const items = (stockData && stockData.items) || [];
    if (!kw) return items;
    return items.filter((it) => String(it.name).toLowerCase().indexOf(kw) !== -1
      || String(it.note || '').toLowerCase().indexOf(kw) !== -1);
  }

  function fmtQty(n) { const x = Number(n) || 0; return Number.isInteger(x) ? x.toLocaleString('zh-CN') : String(x); }
  function fmtCost(n) { const x = Number(n) || 0; return x.toLocaleString('zh-CN', { maximumFractionDigits: 4 }); }
  function fmtSale(p) {
    const s = String(p == null ? '' : p).trim();
    return s === '' ? '—' : s; // 价格列不带人民币符号，原样显示
  }

  function renderStockPage() {
    const box = $('#stock-content');
    box.innerHTML = '';
    if (!stockData) return;
    const info = $('#stock-info');
    info.innerHTML = '';
    const t = stockData.lastImportAt
      ? new Date(stockData.lastImportAt).toLocaleString('zh-CN') + (stockData.lastImportBy ? '（' + stockData.lastImportBy + '）' : '')
      : '尚未导入过';
    info.appendChild(el('span', 'stock-import-time', '🕐 最近一次导入：' + t));
    const pt = stockData.lastPriceChangeAt
      ? new Date(stockData.lastPriceChangeAt).toLocaleString('zh-CN') + (stockData.lastPriceChangeBy ? '（' + stockData.lastPriceChangeBy + '）' : '')
      : '尚未修改过';
    info.appendChild(el('span', 'stock-import-time', '　💰 最后一次修改售价：' + pt));

    const bar = el('div', 'stock-toolbar');
    if (stockData.canEdit && stockBatchMode === 'edit') {
      bar.classList.add('sticky'); // 悬浮：向下滚动时保存按钮仍可点击
      bar.appendChild(el('span', 'stock-hint', '直接修改格子；勾选行=标记删除（红色显示），点「保存全部修改」一次提交'));
      const nChg = stockChangedRows().length;
      const nDel = stockDelSel.size;
      const bSave = el('button', 'primary', '💾 保存全部修改' + (nDel ? '（改 ' + nChg + ' / 删 ' + nDel + '）' : '（' + nChg + '）'));
      bSave.id = 'stock-save-btn';
      bSave.onclick = saveStockBatchEdit;
      const bCancel = el('button', '', '取消');
      bCancel.onclick = exitStockBatch;
      bar.appendChild(bSave);
      bar.appendChild(bCancel);
    } else if (!stockData.canEdit && me && me.role === 'exporter' && stockBatchMode === 'wh') {
      // 库存导出员专用：只能修改「备注（库房）」列
      bar.classList.add('sticky');
      bar.appendChild(el('span', 'stock-hint', '你只能修改「备注（库房）」列，其他内容不可修改；改完点「保存库房备注」一次提交'));
      const n = stockChangedWh().length;
      const bSave = el('button', 'primary', '💾 保存库房备注（' + n + '）');
      bSave.onclick = saveStockWhEdit;
      const bCancel = el('button', '', '取消');
      bCancel.onclick = exitStockBatch;
      bar.appendChild(bSave);
      bar.appendChild(bCancel);
    } else {
      if (stockData.canEdit) {
        const bAdd = el('button', '', '＋ 新增配件');
        bAdd.onclick = openStockItemModal;
        bar.appendChild(bAdd);
        const bEdit = el('button', 'primary', '✏️ 批量修改');
        bEdit.onclick = enterStockBatchEdit;
        bar.appendChild(bEdit);
        bar.appendChild(el('span', 'stock-hint', '「批量修改」：改格子 + 勾选标记删除，一次保存'));
      }
      if (!stockData.canEdit && me && me.role === 'exporter') {
        const bWh = el('button', 'primary', '✏️ 修改库房备注');
        bWh.onclick = enterStockWhEdit;
        bar.appendChild(bWh);
      }
      if (stockData.canImport) {
        const bImport = el('button', '', '⇪ 导入 Excel');
        bImport.onclick = () => $('#stock-file').click();
        bar.appendChild(bImport);
      }
      if (stockData.canExport) {
        const bExport = el('button', '', '⇩ 导出 Excel');
        bExport.onclick = exportStockExcel;
        bar.appendChild(bExport);
      }
      if (!stockData.canEdit && (stockData.canImport || stockData.canExport)) {
        const perms = [stockData.canImport ? '导入' : '', stockData.canExport ? '导出' : ''].filter(Boolean).join('/');
        bar.appendChild(el('span', 'stock-hint', '你只有' + perms + '权限，编辑请联系管理员'));
      }
    }
    if (bar.children.length) box.appendChild(bar);

    if (stockData.canImport && stockBatchMode === null && !$('#stock-file')) {
      const fi = el('input');
      fi.type = 'file';
      fi.id = 'stock-file';
      fi.accept = '.xls,.xlsx';
      fi.classList.add('hidden');
      fi.onchange = onStockFilePicked;
      box.appendChild(fi);
    }

    const items = stockFiltered();
    // 成本价仅 admin 可见；售价 admin 和普通用户可见；库存上传员/导出员两者都不可见（服务端不下发字段）
    const heads = ['货品名称', '库存量'];
    if (stockData.canSeeCost) heads.push('成本价');
    if (stockData.canSeePrice) heads.push('售价');
    heads.push('备注');
    heads.push('备注（库房）'); // 所有人可见；仅 admin/库存导出员可修改
    if (stockBatchMode === 'edit') heads.unshift('删?'); // 勾选列（标记删除）
    const trh = el('tr');
    heads.forEach((h) => {
      let cls = '';
      if (h === '货品名称') cls = 'col-name';
      else if (h === '库存量' || h === '成本价' || h === '售价') cls = 'col-num';
      else if (h === '删?') cls = 'col-check'; // 勾选列固定窄宽（表格为 fixed 布局）
      trh.appendChild(el('th', cls, h === '删?' ? '删' : h));
    });
    if (stockBatchMode === 'edit') {
      const allDel = items.length > 0 && items.every((it) => stockDelSel.has(it.name));
      const cbAll = el('input');
      cbAll.type = 'checkbox';
      cbAll.checked = allDel;
      cbAll.title = '全选/全不选（标记删除）';
      cbAll.onchange = () => {
        items.forEach((it) => { if (cbAll.checked) stockDelSel.add(it.name); else stockDelSel.delete(it.name); });
        renderStockPage();
      };
      trh.firstChild.appendChild(cbAll);
    }
    const tbl = el('table', 'stock-table');
    const thead = el('thead');
    thead.appendChild(trh);
    tbl.appendChild(thead);
    const tbody = el('tbody');
    items.forEach((it) => {
      const marked = stockDelSel.has(it.name);
      if (stockBatchMode === 'edit') tbody.appendChild(marked ? stockPlainRow(it, true, true) : stockEditRow(it));
      else if (stockBatchMode === 'wh') tbody.appendChild(stockWhRow(it));
      else tbody.appendChild(stockPlainRow(it, false, false));
    });
    if (!items.length) {
      const tr = el('tr');
      const td = el('td', 'modal-hint', ($('#stock-search').value || '').trim() ? '没有匹配的货品' : '库存表还是空的');
      td.colSpan = heads.length;
      tr.appendChild(td);
      tbody.appendChild(tr);
    }
    tbl.appendChild(tbody);
    box.appendChild(tbl);
  }

  function stockPlainRow(it, withCheckbox, marked) {
    const zero = Number(it.qty) === 0; // 库存量为 0 的行整行标红提示
    const tr = el('tr', marked ? 'stock-row-del' : (zero ? 'stock-row-zero' : ''));
    if (withCheckbox) {
      const tdSel = el('td', 'col-check');
      const cb = el('input');
      cb.type = 'checkbox';
      cb.checked = !!marked;
      cb.title = '取消标记则恢复为可编辑行';
      cb.onchange = () => {
        if (cb.checked) stockDelSel.add(it.name);
        else stockDelSel.delete(it.name);
        renderStockPage();
      };
      tdSel.appendChild(cb);
      tr.appendChild(tdSel);
    }
    tr.appendChild(el('td', 'col-name-t', it.name || ''));
    tr.appendChild(el('td', 'num col-qty', fmtQty(it.qty)));
    if (stockData.canSeeCost) tr.appendChild(el('td', 'num', fmtCost(it.cost)));
    if (stockData.canSeePrice) tr.appendChild(el('td', 'num', fmtSale(it.price)));
    tr.appendChild(el('td', 'stock-note', it.note || ''));
    tr.appendChild(el('td', 'stock-note stock-wh', it.wh || '')); // 备注（库房）：所有人可见
    return tr;
  }

  function stockCellInput(value, oninput, wide) {
    const i = el('input', 'edit-input stock-cell-input' + (wide ? ' wide' : ''));
    i.value = value;
    i.oninput = oninput;
    return i;
  }

  function stockEditRow(orig) {
    const e = stockEdits[orig.name];
    const tr = el('tr', Number(orig.qty) === 0 ? 'stock-row-zero' : ''); // 库存量为 0 的行标红提示
    // 首列：删除标记勾选框（勾选后该行转为红色只读行）
    const tdSel = el('td', 'col-check');
    const cb = el('input');
    cb.type = 'checkbox';
    cb.title = '勾选=标记此行删除';
    cb.onchange = () => {
      if (cb.checked) stockDelSel.add(orig.name);
      else stockDelSel.delete(orig.name);
      renderStockPage();
    };
    tdSel.appendChild(cb);
    tr.appendChild(tdSel);
    // 注意：el() 第三参数会变成 textContent，元素必须用 appendChild 挂进去
    const tdName = el('td', 'col-name-t');
    tdName.appendChild(stockCellInput(e.name, (ev) => { e.name = ev.target.value; }, true));
    tr.appendChild(tdName);
    const tdQty = el('td', 'num col-qty');
    tdQty.appendChild(stockCellInput(e.qty, (ev) => { e.qty = ev.target.value; }));
    tr.appendChild(tdQty);
    if (stockData.canSeeCost) {
      const tdCost = el('td', 'num');
      tdCost.appendChild(stockCellInput(e.cost, (ev) => { e.cost = ev.target.value; }));
      tr.appendChild(tdCost);
    }
    if (stockData.canSeePrice) {
      const tdPrice = el('td', 'num');
      tdPrice.appendChild(stockCellInput(e.price, (ev) => { e.price = ev.target.value; }));
      tr.appendChild(tdPrice);
    }
    const noteTd = el('td', 'stock-note');
    noteTd.appendChild(stockCellInput(e.note, (ev) => { e.note = ev.target.value; }, true));
    tr.appendChild(noteTd);
    const tdWh = el('td', 'stock-note stock-wh');
    tdWh.appendChild(stockCellInput(e.wh, (ev) => { e.wh = ev.target.value; }));
    tr.appendChild(tdWh);
    return tr;
  }

  function stockOrigRaw(it) {
    return {
      name: it.name,
      qty: String(Number(it.qty) || 0),
      cost: String(Number(it.cost) || 0),
      price: it.price == null ? '' : String(it.price).trim(),
      note: it.note == null ? '' : String(it.note),
      wh: it.wh == null ? '' : String(it.wh).trim(),
    };
  }

  function stockChangedRows() {
    const out = [];
    (stockData.items || []).forEach((it) => {
      if (stockDelSel.has(it.name)) return; // 标记删除的行不再参与修改
      const e = stockEdits[it.name];
      if (!e) return;
      const orig = stockOrigRaw(it);
      const fields = ['name', 'qty', 'cost', 'price', 'note', 'wh'];
      if (fields.some((f) => String(e[f]).trim() !== orig[f])) {
        out.push({ name: it.name, item: { name: String(e.name).trim(), qty: e.qty, cost: e.cost, price: String(e.price).trim(), note: e.note, wh: String(e.wh || '').trim() } });
      }
    });
    return out;
  }

  function enterStockBatchEdit() {
    stockBatchMode = 'edit';
    stockEdits = {};
    stockDelSel = new Set();
    (stockData.items || []).forEach((it) => { stockEdits[it.name] = { ...stockOrigRaw(it) }; });
    renderStockPage();
  }

  function exitStockBatch() {
    stockBatchMode = null;
    stockEdits = {};
    stockDelSel = new Set();
    stockWhEdits = {};
    renderStockPage();
  }

  // 库存导出员：仅修改「备注（库房）」列（服务端 wh-batch 只写 wh 字段）
  function stockChangedWh() {
    const out = [];
    (stockData.items || []).forEach((it) => {
      if (stockWhEdits[it.name] === undefined) return;
      if (String(stockWhEdits[it.name]).trim() !== String(it.wh == null ? '' : it.wh)) {
        out.push({ name: it.name, wh: String(stockWhEdits[it.name]).trim() });
      }
    });
    return out;
  }

  function enterStockWhEdit() {
    stockBatchMode = 'wh';
    stockWhEdits = {};
    stockDelSel = new Set();
    (stockData.items || []).forEach((it) => { stockWhEdits[it.name] = it.wh == null ? '' : String(it.wh); });
    renderStockPage();
  }

  async function saveStockWhEdit() {
    const changes = stockChangedWh();
    if (!changes.length) { alert('还没有改动：请先在「备注（库房）」列修改内容'); return; }
    if (!confirm('保存 ' + changes.length + ' 行库房备注？')) return;
    try {
      const r = await api('POST', '/api/stock-wh-batch', { changes });
      alert('已保存 ' + r.applied + ' 行库房备注');
      exitStockBatch();
      loadStock();
    } catch (e) { alert('保存失败：' + e.message); }
  }

  function stockWhRow(orig) {
    const tr = el('tr');
    tr.appendChild(el('td', 'col-name-t', orig.name || ''));
    tr.appendChild(el('td', 'num', fmtQty(orig.qty)));
    if (stockData.canSeeCost) tr.appendChild(el('td', 'num', fmtCost(orig.cost)));
    if (stockData.canSeePrice) tr.appendChild(el('td', 'num', fmtSale(orig.price)));
    tr.appendChild(el('td', 'stock-note', orig.note || ''));
    const td = el('td', 'stock-note stock-wh');
    td.appendChild(stockCellInput(stockWhEdits[orig.name] || '', (ev) => { stockWhEdits[orig.name] = ev.target.value; }));
    tr.appendChild(td);
    return tr;
  }

  async function saveStockBatchEdit() {
    const changes = stockChangedRows();
    const deletes = Array.from(stockDelSel);
    if (!changes.length && !deletes.length) { alert('还没有改动：请先在表格里修改格子，或勾选要删除的行'); return; }
    const msg = (changes.length ? '修改 ' + changes.length + ' 行' : '') + (changes.length && deletes.length ? '、' : '') + (deletes.length ? '删除 ' + deletes.length + ' 行' : '');
    if (!confirm('保存' + msg + '？')) return;
    try {
      const r = await api('POST', '/api/stock-item', { action: 'batch-save', changes, deletes });
      alert('已保存：修改 ' + r.applied + ' 行' + (r.deleted ? '，删除 ' + r.deleted + ' 行' : ''));
      exitStockBatch();
      loadStock();
    } catch (e) { alert('保存失败：' + e.message); }
  }

  async function confirmStockEdit() {
    // 已由批量修改取代（保留空实现避免遗留调用报错）
  }

  function openStockItemModal() {
    openModal('新增库存配件');
    const body = $('#modal-body');
    body.appendChild(el('div', 'modal-hint', '新增一行库存（五列都可填；售价/备注可留空，之后用「批量修改」调整）。'));
    const mk = (ph) => { const i = el('input'); i.placeholder = ph; body.appendChild(i); return i; };
    const iName = mk('货品名称（必填）');
    const iQty = mk('库存量（如 40）');
    const iCost = mk('成本价（如 530）');
    const iPrice = mk('售价（可留空）');
    const iNote = mk('备注（可留空）');
    const iWh = mk('备注（库房）（可留空）');
    const foot = el('div', 'form-row');
    const bOk = el('button', 'primary', '保存');
    const bCancel = el('button', '', '取消');
    bCancel.onclick = closeModal;
    bOk.onclick = async () => {
      const name = iName.value.trim();
      if (!name) { alert('请输入货品名称'); return; }
      try {
        await api('POST', '/api/stock-item', {
          action: 'upsert', name: '',
          item: { name, qty: iQty.value, cost: iCost.value, price: iPrice.value, note: iNote.value, wh: iWh.value },
        });
        closeModal();
        loadStock();
      } catch (e) { alert('保存失败：' + e.message); }
    };
    foot.appendChild(bOk);
    foot.appendChild(bCancel);
    body.appendChild(foot);
  }

  async function onStockFilePicked(e) {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!f) return;
    let b64;
    try {
      b64 = await new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result).split(',')[1] || '');
        r.onerror = () => reject(new Error('读取文件失败'));
        r.readAsDataURL(f);
      });
    } catch (err) { alert(err.message); return; }
    try {
      const r = await api('POST', '/api/stock-import', { dataBase64: b64 });
      alert('导入完成：共 ' + r.total + ' 行（更新 ' + r.updated + '，新增 ' + r.added + '，库存清零 ' + r.zeroed + '）');
      loadStock();
    } catch (err) { alert('导入失败：' + err.message); }
  }

  async function exportStockExcel() {
    try {
      const r = await api('POST', '/api/stock-export', {});
      const bin = atob(r.dataBase64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const blob = new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      const a = el('a');
      a.href = URL.createObjectURL(blob);
      a.download = r.filename || '库存导出.xlsx';
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    } catch (e) { alert('导出失败：' + e.message); }
  }

  // ---------- 应收明细（每人只看自己经手的数据） ----------
  let recvData = null;   // GET /api/receivables 结果 {rows(含id), handlers, lastImportAt, lastImportBy, canImport, canViewAll}
  let recvFilter = '';   // 经手人筛选（''=全部；仅 admin/库存上传员）
  let recvSel = new Set(); // 勾选的行 id（选择性导出；空=导出当前范围全部）
  let recvClientFilter = ''; // 往来客户检索关键字（过滤显示与导出）

  async function loadRecv() {
    const box = $('#recv-content');
    box.innerHTML = '';
    box.appendChild(el('div', 'modal-hint', '加载中…'));
    try {
      recvData = await api('GET', '/api/receivables');
    recvSel = new Set();
    } catch (e) {
      box.innerHTML = '';
      box.appendChild(el('div', 'modal-hint', '加载失败：' + e.message));
      return;
    }
    renderRecvPage();
  }

  function fmtAmount(n) {
    const x = Number(n) || 0;
    return Number.isInteger(x) ? x.toLocaleString('zh-CN') : String(Math.round(x * 10000) / 10000);
  }

  function recvVisible() {
    let rows = (recvData && recvData.rows) || [];
    if (recvData.canViewAll && recvFilter) rows = rows.filter((r) => r.handler === recvFilter); // admin 按经手人筛选
    const kw = recvClientFilter.trim().toLowerCase();
    if (kw) rows = rows.filter((r) => String(r.client || '').toLowerCase().indexOf(kw) !== -1); // 往来客户检索
    return rows;
  }

  function renderRecvPage() {
    const box = $('#recv-content');
    // 在清空重建之前记住检索框焦点与光标位置（否则每敲一个字母就因重渲染丢焦点，表现为“输入一个字母就卡住”）
    const prevSearch = box.querySelector('.recv-client-input');
    const searchHadFocus = !!(prevSearch && document.activeElement === prevSearch);
    const searchCaret = searchHadFocus ? prevSearch.selectionStart : null;
    box.innerHTML = '';
    if (!recvData) return;
    const info = $('#recv-info');
    info.innerHTML = '';
    const t = recvData.lastImportAt
      ? new Date(recvData.lastImportAt).toLocaleString('zh-CN') + (recvData.lastImportBy ? '（' + recvData.lastImportBy + '）' : '')
      : '尚未导入过';
    info.appendChild(el('span', 'stock-import-time', '🕐 最近一次导入：' + t));

    // admin 的经手人筛选
    const filterBox = $('#recv-filter');
    filterBox.innerHTML = '';
    if (recvData.canViewAll && recvData.handlers && recvData.handlers.length) {
      const sel = el('select', 'recv-handler-sel');
      const optAll = el('option', '', '全部经手人');
      optAll.value = '';
      sel.appendChild(optAll);
      recvData.handlers.forEach((h) => {
        const opt = el('option', '', h);
        opt.value = h;
        sel.appendChild(opt);
      });
      sel.value = recvFilter;
      sel.onchange = () => { recvFilter = sel.value; renderRecvPage(); };
      filterBox.appendChild(sel);
    }

    const bar = el('div', 'stock-toolbar');
    if (recvData.canImport) {
      const bImport = el('button', '', '⇪ 导入 Excel');
      bImport.onclick = () => $('#recv-file').click();
      bar.appendChild(bImport);
    }
    // 检索框焦点/光标已在函数开头捕获（清空重建前）
    const bExport = el('button', 'primary', '⇩ 导出 Excel' + (recvSel.size ? '（已选 ' + recvSel.size + '）' : ''));
    bExport.onclick = exportRecvExcel;
    bar.appendChild(bExport);
    // 往来客户检索：过滤表格显示与导出范围（配合全选，快速导出某客户的明细）
    const searchWrap = el('span', 'recv-filter');
    searchWrap.appendChild(el('span', 'stock-hint', '🔎 往来客户检索'));
    const inClient = el('input', 'recv-client-input');
    inClient.placeholder = '输入客户名关键字…';
    inClient.value = recvClientFilter;
    // 中文输入法组字保护：组字（拼音候选）期间不重渲染，避免输入框被重建打断组字；选字完成（compositionend）再统一刷新
    let composing = false;
    inClient.addEventListener('compositionstart', () => { composing = true; });
    inClient.addEventListener('compositionend', () => {
      composing = false;
      recvClientFilter = inClient.value;
      renderRecvPage();
    });
    inClient.oninput = () => {
      if (composing) return;
      const v = inClient.value;
      if (v === recvClientFilter) return; // 组字结束后的补发 input：值没变就不必重渲染
      recvClientFilter = v;
      renderRecvPage();
    };
    searchWrap.appendChild(inClient);
    bar.appendChild(searchWrap);
    bar.appendChild(el('span', 'stock-hint', recvData.isAdmin
      ? '你看到全部明细' + (recvFilter ? '（经手人：' + recvFilter + '）' : '') + (recvClientFilter ? '（客户含「' + recvClientFilter + '」）' : '') + '；勾选=只导勾选；点击行可修改该条内容（重新导入会被覆盖）'
      : '你只看到自己经手的明细；勾选行后只导出勾选的行，不勾选=全部导出'));
    box.appendChild(bar);
    // 恢复检索框焦点与光标（修复“输入一个字母就卡住”）
    if (searchHadFocus) {
      inClient.focus();
      try { inClient.setSelectionRange(searchCaret, searchCaret); } catch (e) {}
    }

    if (recvData.canImport && !$('#recv-file')) {
      const fi = el('input');
      fi.type = 'file';
      fi.id = 'recv-file';
      fi.accept = '.xls,.xlsx';
      fi.classList.add('hidden');
      fi.onchange = onRecvFilePicked;
      box.appendChild(fi);
    }

    const rows = recvVisible();
    const heads = ['日期', '往来客户', '货品名称', '交易数量', '交易单价', '应收增加', '附加说明', '经手人'];
    const tbl = el('table', 'stock-table recv-table');
    const trh = el('tr');
    const thSel = el('th', 'col-check');
    const cbAll = el('input');
    cbAll.type = 'checkbox';
    cbAll.checked = rows.length > 0 && rows.every((r) => recvSel.has(r.id));
    cbAll.title = '全选/全不选（选择性导出）';
    cbAll.onchange = () => {
      rows.forEach((r) => { if (cbAll.checked) recvSel.add(r.id); else recvSel.delete(r.id); });
      renderRecvPage();
    };
    thSel.appendChild(cbAll);
    trh.appendChild(thSel);
    heads.forEach((h) => {
      let cls = '';
      if (h === '日期') cls = 'col-date';
      else if (h === '往来客户') cls = 'col-client';
      else if (h === '货品名称') cls = 'col-item';
      else if (h === '交易数量' || h === '交易单价' || h === '应收增加') cls = 'col-num';
      else if (h === '经手人') cls = 'col-op';
      trh.appendChild(el('th', cls, h));
    });
    const thead = el('thead');
    thead.appendChild(trh);
    tbl.appendChild(thead);
    const tbody = el('tbody');
    rows.forEach((r) => {
      const tr = el('tr');
      if (recvData.isAdmin) {
        tr.classList.add('row-editable'); // 仅 admin：点击行编辑该条
        tr.title = '点击修改该条内容（重新导入后会被覆盖）';
        tr.onclick = () => openRecvEditModal(r);
      }
      const tdSel = el('td', 'col-check');
      const cb = el('input');
      cb.type = 'checkbox';
      cb.checked = recvSel.has(r.id);
      cb.onchange = () => {
        if (cb.checked) recvSel.add(r.id);
        else recvSel.delete(r.id);
        bExport.textContent = '⇩ 导出 Excel' + (recvSel.size ? '（已选 ' + recvSel.size + '）' : '');
      };
      tdSel.appendChild(cb);
      tr.appendChild(tdSel);
      tr.appendChild(el('td', 'col-date-t', r.date || ''));
      tr.appendChild(el('td', '', r.client || ''));
      tr.appendChild(el('td', '', r.item || ''));
      tr.appendChild(el('td', 'num', fmtAmount(r.qty)));
      tr.appendChild(el('td', 'num', fmtAmount(r.price)));
      tr.appendChild(el('td', 'num', fmtAmount(r.amount)));
      const noteTd = el('td', 'stock-note', r.note || '');
      tr.appendChild(noteTd);
      tr.appendChild(el('td', 'num', r.handler || ''));
      tbody.appendChild(tr);
    });
    if (!rows.length) {
      const tr = el('tr');
      const td = el('td', 'modal-hint', '没有你经手的应收明细（数据由管理员/库存上传员导入，经手人需与账号名完全一致）');
      td.colSpan = heads.length + 1;
      tr.appendChild(td);
      tbody.appendChild(tr);
    } else {
      // 表格底部合计：当前查看范围（本人 / 筛选的经手人）的应收增加求和
      const sum = rows.reduce((acc, r) => acc + (Number(r.amount) || 0), 0);
      const tr = el('tr', 'qc-total-row');
      const tdLabel = el('td', 'num', '合计');
      tdLabel.colSpan = 6;
      tr.appendChild(tdLabel);
      tr.appendChild(el('td', 'num qc-total-num', fmtAmount(Math.round(sum * 10000) / 10000)));
      tr.appendChild(el('td', '', ''));
      tr.appendChild(el('td', '', ''));
      tbody.appendChild(tr);
    }
    tbl.appendChild(tbody);
    box.appendChild(tbl);
  }

  async function onRecvFilePicked(e) {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!f) return;
    if (!confirm('导入将清空现有全部应收明细，并替换为该文件的内容（没有经手人的行不会导入）。确定继续？')) return;
    let b64;
    try {
      b64 = await new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result).split(',')[1] || '');
        r.onerror = () => reject(new Error('读取文件失败'));
        r.readAsDataURL(f);
      });
    } catch (err) { alert(err.message); return; }
    try {
      const r = await api('POST', '/api/receivables-import', { dataBase64: b64 });
      alert('导入完成：共 ' + r.total + ' 行（没有经手人的行已跳过，原有数据已被替换）');
      recvClientFilter = '';
      recvFilter = '';
      loadRecv();
    } catch (err) { alert('导入失败：' + err.message); }
  }

  async function exportRecvExcel() {
    try {
      const payload = { handler: recvData && recvData.canViewAll ? recvFilter : '' };
      if (recvClientFilter.trim()) payload.client = recvClientFilter.trim(); // 往来客户检索跟随导出
      if (recvSel.size) payload.ids = Array.from(recvSel); // 勾选了行 → 只导出勾选的
      const r = await api('POST', '/api/receivables-export', payload);
      recvSel = new Set(); // 导出后清空勾选
      const bin = atob(r.dataBase64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const blob = new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      const a = el('a');
      a.href = URL.createObjectURL(blob);
      a.download = r.filename || '应收明细导出.xlsx';
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    } catch (e) { alert('导出失败：' + e.message); }
  }

  // admin 修改单条应收明细（重新导入会被新文件覆盖）
  function openRecvEditModal(row) {
    openModal('修改应收明细（重新导入后会被覆盖）');
    const body = $('#modal-body');
    body.appendChild(el('div', 'modal-hint', '本次修改立即生效，但下次导入 Excel 会被新文件整体覆盖。'));
    const fields = [
      ['date', '日期（如 2025-04-21）'],
      ['client', '往来客户'],
      ['item', '货品名称'],
      ['qty', '交易数量'],
      ['price', '交易单价'],
      ['amount', '应收增加（可负）'],
      ['note', '附加说明'],
      ['handler', '经手人（须与账号名完全一致该用户才可见）'],
    ];
    const inputs = {};
    fields.forEach(([k, ph]) => {
      const i = el('input');
      i.placeholder = ph;
      i.value = row[k] == null ? '' : String(row[k]);
      inputs[k] = i;
      body.appendChild(i);
    });
    const foot = el('div', 'form-row');
    const bOk = el('button', 'primary', '保存修改');
    const bCancel = el('button', '', '取消');
    bCancel.onclick = closeModal;
    bOk.onclick = async () => {
      try {
        await api('POST', '/api/receivables-update', {
          id: row.id,
          patch: {
            date: inputs.date.value, client: inputs.client.value, item: inputs.item.value,
            qty: inputs.qty.value, price: inputs.price.value, amount: inputs.amount.value,
            note: inputs.note.value, handler: inputs.handler.value,
          },
        });
        closeModal();
        loadRecv();
      } catch (e) { alert('保存失败：' + e.message); }
    };
    foot.appendChild(bOk);
    foot.appendChild(bCancel);
    body.appendChild(foot);
  }

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
        (h.clientName ? '给「' + h.clientName + '」· ' : '') + (h.machineName || h.machine || '报价') + ' · ¥' + fmt(h.total)));
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
    $('#stock-page').classList.toggle('hidden', p !== 'stock');
    $('#recv-page').classList.toggle('hidden', p !== 'recv');
    $('#btn-prices').classList.toggle('active', p === 'price');
    $('#btn-stock').classList.toggle('active', p === 'stock');
    $('#btn-recv').classList.toggle('active', p === 'recv');
    if (p === 'price') loadPriceData();
    if (p === 'stock') loadStock();
    if (p === 'recv') loadRecv();
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
      box.appendChild(el('div', 'modal-hint', '总表还没有配件：点「+ 新增配件」开始添加'));
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
    openModal((h.clientName ? '给「' + h.clientName + '」· ' : '') + (h.machineName || h.machine || '报价') + ' · 合计 ¥' + fmt(h.total));
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
    const bEdit = el('button', 'primary', '✏️ 编辑这份报价');
    bEdit.title = '按刚生成报价时的形式打开：可改配件、价格、数量、插入删除，改完可另存为新历史';
    bEdit.onclick = () => openHistoryEditable(h);
    b1.onclick = () => copyText(h.simple, b1);
    b2.onclick = () => copyText(h.detail, b2);
    foot.appendChild(bEdit);
    foot.appendChild(b1);
    foot.appendChild(b2);
    body.appendChild(foot);
  }

  // 把历史记录还原成可编辑的报价数据（与刚生成时同一套卡片：点配件名/单价/数量修改、可插入删除）
  function quoteFromHistory(h) {
    const items = [];
    const manual = {};
    (h.items || []).forEach((i) => {
      const price = i.price != null ? i.price : 0;
      const qty = Math.max(1, parseInt(i.qty, 10) || 1);
      if (i.manual) manual[i.name] = { qty, price };
      else items.push({ name: i.name, short: i.short || i.name, category: i.category || 'other', qty, price, note: i.note || '', subtotal: price * qty });
    });
    return {
      machine: h.machine,
      machineFamily: h.machineName || h.machine,
      machineVariant: h.machineVariant || null,
      requirement: { summary: h.text || '' },
      items,
      missing: h.missing || [],
      notes: [],
      checks: [],
      total: 0, simple: '', detail: '',
    };
  }

  // 历史报价编辑：弹窗里挂一张与刚生成时完全一样的可编辑报价卡（另存为新历史）
  function openHistoryEditable(h) {
    openModal('编辑历史报价' + (h.clientName ? '（给「' + h.clientName + '」）' : ''));
    const body = $('#modal-body');
    body.appendChild(el('div', 'modal-hint',
      '这是这份历史报价的可编辑副本：点配件名 / 单价 / 数量即可修改，可插入、删除配件。改完点卡片下方的「保存到历史」会另存为一条新记录，原记录保留。'));
    body.appendChild(buildQuoteCard(quoteFromHistory(h)));
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
    const hint = el('div', 'modal-hint', '岗位说明：管理员=全部权限（含库存编辑/成本价）；普通用户=报价与查看库存（可见售价）；库存上传员=可导入库存与应收明细；库存导出员=可导出库存。删除规则：admin 可以删除任何人（历史报价一并删除），唯独不能删除自己。');
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
          row.appendChild(el('span', 'u-login', '登录 ' + (u.loginCount || 0) + ' 次 · ' + (u.lastLoginAt ? '最近 ' + new Date(u.lastLoginAt).toLocaleString('zh-CN') : '从未登录')));
          const isSelf = u.username === me.username;
          const isExtraAdmin = u.role === 'admin' && !isSelf; // 历史遗留的多余管理员：可改岗、可删除
          if (isExtraAdmin) {
            const warn = el('span', 'u-warn', '⚠️ 多余管理员');
            warn.title = '系统仅保留一个管理员。可将该账号改为正确岗位，或直接删除。';
            row.appendChild(warn);
          }
          const roleSel = el('select', 'u-role');
          Object.keys(ROLE_LABELS).forEach((rk) => {
            if (rk === 'admin') return; // 系统仅一个管理员，不提供管理员选项
            const opt = el('option', '', ROLE_LABELS[rk]);
            opt.value = rk;
            roleSel.appendChild(opt);
          });
          if (isExtraAdmin) {
            const ph = el('option', '', '是管理员，请改选 ↓');
            ph.value = '';
            ph.disabled = true;
            ph.selected = true;
            roleSel.insertBefore(ph, roleSel.firstChild);
          } else {
            roleSel.value = u.role;
          }
          if (isSelf) {
            roleSel.disabled = true;
            roleSel.title = '不能修改自己的岗位';
          } else {
            roleSel.onchange = async () => {
              if (!roleSel.value) { roleSel.value = ''; return; }
              if (!confirm('把「' + u.username + '」的岗位改为「' + ROLE_LABELS[roleSel.value] + '」？')) { roleSel.value = u.role; refresh(); return; }
              try {
                await api('POST', '/api/users-role', { username: u.username, role: roleSel.value });
                refresh();
              } catch (e) { alert('修改失败：' + e.message); roleSel.value = u.role; }
            };
          }
          row.appendChild(roleSel);
          const rstPass = el('button', 'u-del', '🔑 重设密码');
          rstPass.title = '为该用户设置新密码（用于忘记密码时）：对方当前密码立即失效，下次登录用新密码，登录后会被要求再次修改';
          rstPass.onclick = () => openResetPassModal(u.username);
          row.appendChild(rstPass);
          const rst = el('button', 'u-del', '清零登录');
          rst.title = '把该账号的登录次数与最近登录时间清零，重新计数';
          rst.onclick = async () => {
            if (!confirm('清零「' + u.username + '」的登录统计？')) return;
            try {
              await api('POST', '/api/users-login-reset', { username: u.username });
              refresh();
            } catch (e) { alert(e.message); }
          };
          row.appendChild(rst);
          if (!isSelf) {
            const imp = el('button', 'u-del', '👁 模拟登录');
            imp.title = '在新标签页以该账号的身份查看系统（对方无需退出，也不影响其密码与数据）';
            imp.onclick = async () => {
              if (!confirm('以「' + u.username + '」的身份打开一个新的查看页面？')) return;
              try {
                const r2 = await api('POST', '/api/users-impersonate', { username: u.username });
                window.open(location.pathname + '?imp=' + encodeURIComponent(r2.token), '_blank');
              } catch (e) { alert(e.message); }
            };
            row.appendChild(imp);
          }
          const del = el('button', 'u-del', '删除');
          if (isSelf) { del.disabled = true; del.textContent = '不能删除自己'; }
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

  // admin 重设用户密码弹窗（与「修改密码」弹窗同款样式）
  function openResetPassModal(username) {
    openModal('重设密码 — ' + username);
    const body = $('#modal-body');
    body.appendChild(el('div', 'modal-hint', '为「' + username + '」设置新密码：对方当前密码立即失效；下次登录用新密码，登录后系统会要求其再次修改。'));
    const inNew = el('input'); inNew.type = 'password'; inNew.placeholder = '新密码（至少 6 位）';
    const inNew2 = el('input'); inNew2.type = 'password'; inNew2.placeholder = '确认新密码';
    const foot = el('div', 'form-row');
    const bOk = el('button', 'primary', '确认重设');
    const bCancel = el('button', '', '取消');
    bCancel.onclick = closeModal;
    [inNew, inNew2].forEach((x) => body.appendChild(x));
    foot.appendChild(bOk);
    foot.appendChild(bCancel);
    body.appendChild(foot);
    bOk.onclick = async () => {
      const np = inNew.value;
      if (np.length < 6) { alert('新密码至少 6 位'); return; }
      if (np !== inNew2.value) { alert('两次输入的新密码不一致'); return; }
      bOk.disabled = true;
      try {
        await api('POST', '/api/users-reset-pass', { username, newPassword: np });
        alert('已重设「' + username + '」的密码。请把新密码告知对方：下次登录用新密码，登录后系统会要求其再次修改。');
        closeModal();
      } catch (e) { alert(e.message); }
      finally { bOk.disabled = false; }
    };
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
  $('#new-chat').onclick = () => {
    // 在其他页面时第一次点击 = 回到上次报价的界面；已经在报价页再点一次才真正新建
    if ($('#chat-page').classList.contains('hidden')) { showPage('chat'); return; }
    newChat();
  };
  $('#btn-prices').onclick = () => showPage('price');
  $('#btn-stock').onclick = () => showPage('stock');
  $('#btn-recv').onclick = () => showPage('recv');
  $('#stock-search').oninput = () => renderStockPage();
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

  if (token || impToken) {
    // 已有 token（或模拟登录）：尝试恢复会话
    api('GET', '/api/me')
      .then((r) => {
        me = { username: r.username, role: r.role, impersonatedBy: r.impersonatedBy || '', mustChange: !!r.mustChange };
        if (r.mustChange) { forceChangePassword(''); return; } // 会话恢复时若仍用初始密码：先强制改密
        enterApp();
      })
      .catch(() => {
        if (impToken) { // 模拟 token 失效：只退模拟，不动 admin 自己的登录
          sessionStorage.removeItem('qa_imp_token');
          impToken = '';
        } else {
          token = '';
          localStorage.removeItem('qa_token');
        }
        if (token) location.reload();
        else showLogin();
      });
  } else {
    showLogin();
  }
})();
