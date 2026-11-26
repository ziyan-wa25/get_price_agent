/* 报价助手前端逻辑：登录 / DS 风格对话报价 / 缺项手动填价 / 历史回看 / 管理员账号管理 */
(function () {
  'use strict';

  let API = String((window.APP_CONFIG && window.APP_CONFIG.API_BASE) || '').replace(/\/+$/, '');
  console.log('[报价系统] app.js build v20260619-95（三态权限+物流单号个人视图；日期自动生成/自动清除+只显示年月日；备注人名可清除；设置整合+名单整齐化；邮件模板+时间滑块+按钮美化；客户列排序；库存合计悬浮；无库存原格编辑；表头缝隙修复）'); // 版本标记：F12 可确认浏览器加载的是哪个版本

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
  let pricePerms = null;      // 价格页权限标志（canEditPrice/canEditMachine/canEditTotal/canChat，功能权限表驱动）
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

  function roleText(role) {
    return role === 'admin' ? '管理员' : (role === 'uploader' ? '库存上传员' : (role === 'exporter' ? '库存导出员' : (role === 'referrer' ? '参考者' : '普通用户')));
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
    const opts = { method, headers, body: body ? JSON.stringify(body) : undefined, cache: 'no-store' }; // 禁用 HTTP 缓存：换账号后绝不允许命中上一任用户的响应
    let res;
    try {
      res = await fetch(API + path, opts);
    } catch (e) {
      // Tauri 自定义协议在 Windows 上存在 https://api.localhost / http://api.localhost 两种形态：
      // 首选失败时自动换用另一种并记住（后续请求直接走可用形态）
      const alt = API === 'https://api.localhost' ? 'http://api.localhost' : (API === 'http://api.localhost' ? 'https://api.localhost' : '');
      if (!alt) throw new Error('网络错误：无法连接后端服务 ｜ 尝试连接: ' + (API || '（空）— config.js 未加载'));
      try {
        res = await fetch(alt + path, opts);
        API = alt;
      } catch (e2) {
        throw new Error('网络错误：无法连接后端服务 ｜ 已尝试 ' + API + ' 和 ' + alt);
      }
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
  function setLoginPasswordVisible(visible) {
    $('#login-pass').type = visible ? 'text' : 'password';
    const toggle = $('#login-pass-toggle');
    const label = visible ? '隐藏密码' : '显示密码';
    toggle.dataset.visible = String(visible);
    toggle.setAttribute('aria-label', label);
    toggle.title = label;
  }

  async function doLogin() {
    const btn = $('#login-btn');
    if (btn.disabled) return;
    const u = $('#login-user').value.trim();
    const p = $('#login-pass').value;
    if (!u || !p) {
      $('#login-err').textContent = '请输入账号和密码';
      $(u ? '#login-pass' : '#login-user').focus();
      return;
    }
    $('#login-err').textContent = '';
    setLoginPasswordVisible(false);
    btn.disabled = true;
    $('#login-btn-label').textContent = '正在登录…';
    $('#login-pass-toggle').disabled = true;
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
      $('#login-btn-label').textContent = '登录';
      $('#login-pass-toggle').disabled = false;
    }
  }

  // 强制修改密码（未按安全规则设置过）：改成功前不进入系统
  function pwdPolicyClientError(pw) {
    const p = String(pw || '');
    if (p.length < 10) return '密码需至少 10 位';
    if (!/[a-z]/.test(p) || !/[A-Z]/.test(p)) return '密码需同时包含大写字母和小写字母';
    if (!/[0-9]/.test(p)) return '密码需包含数字';
    if (!/[^A-Za-z0-9]/.test(p)) return '密码需包含符号（如 !@#$% 等）';
    return '';
  }

  function forceChangePassword(prefillOld) {
    openModal('安全要求：密码检查');
    const body = $('#modal-body');
    body.appendChild(el('div', 'modal-hint', '为保障账号安全，密码需至少 10 位且同时包含大写字母、小写字母、数字和符号（如 !@#$%）。如你的当前密码已符合要求，输入后点「下一步」即可直接进入，无需修改；不符合则需设置一个符合规则的新密码。'));
    const iOld = el('input'); iOld.type = 'password'; iOld.placeholder = '当前密码'; iOld.value = prefillOld || '';
    body.appendChild(iOld);
    const rowNext = el('div', 'form-row');
    const bNext = el('button', 'primary', '下一步');
    rowNext.appendChild(bNext);
    body.appendChild(rowNext);
    // 第二步：当前密码不合规（或是初始/临时密码）→ 设置新密码
    const step2 = () => {
      const iNew = el('input'); iNew.type = 'password'; iNew.placeholder = '新密码（≥10位，含大小写字母+数字+符号）';
      const iNew2 = el('input'); iNew2.type = 'password'; iNew2.placeholder = '确认新密码';
      body.appendChild(iNew); body.appendChild(iNew2);
      const foot = el('div', 'form-row');
      const bOk = el('button', 'primary', '修改密码并进入系统');
      bOk.onclick = async () => {
        const np = iNew.value;
        const perr = pwdPolicyClientError(np);
        if (perr) { alert(perr); return; }
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
      iNew.focus();
    };
    bNext.onclick = async () => {
      bNext.disabled = true;
      try {
        const r = await api('POST', '/api/password-policy-check', { oldPassword: iOld.value });
        if (r && r.compliant) { // 当前密码已符合要求：免改，直接进入
          me.mustChange = false;
          closeModal();
          enterApp();
          return;
        }
        rowNext.remove();
        step2();
      } catch (e) { alert(e.message); }
      finally { bNext.disabled = false; }
    };
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
    setLoginPasswordVisible(false);
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
    // 模拟登录按需求与正常页面完全一致：不显示任何横幅/提示；桌面端用左下角「退出模拟」返回 admin
    $('#btn-exit-imp').classList.toggle('hidden', !impToken);
    resetUserData(); // 清掉上一任用户留在内存里的页面数据（价格/库存/应收/历史），防止越权残留
    newChat();
    loadHistory(); // 历史报价体积大，按需求不参与并行预取（避免压力过大），仅在登录时正常加载
    applyCachedPrefs(); // 先按本地缓存摆好侧栏顺序/开关（无闪动），云端确认紧随其后
    loadPrefs();
    prefetchAll();
    $('#input').focus();
  }

  function prefetchAll() {
    // 登录后后台并行预取各页数据（全部只读 GET）：配合各页“缓存秒开”，切换页面不再等“加载中”
    [loadStock, loadRecv, loadInv, loadFav, loadApps, loadDispatch, loadPriceData, loadPerf, loadTodos, loadPayments, loadIo, prefetchFavUsers, prefetchNoStock].forEach((fn) => {
      try { fn(); } catch (e) { /* 预取失败不打扰用户，切页时仍会正常加载 */ }
    });
    if (me && me.role === 'admin') {
      refreshDispatchHistory(); // admin 预取历史记录缓存（打开秒渲染）
      prefetchDispatchStats(); // admin 预取本月统计（打开秒渲染）
    }
  }

  async function prefetchDispatchStats() {
    // 预取默认区间（本月 1 日 ～ 今天）的统计，打开统计弹窗秒渲染
    if (dispatchStatsCache) return;
    const now = new Date();
    const from = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-01';
    const to = now.toLocaleDateString('sv-SE'); // 本地时区 YYYY-MM-DD
    try { dispatchStatsCache = { from, to, data: await api('POST', '/api/dispatch-stats', { from, to }) }; } catch (e) { /* 失败时打开弹窗仍会正常加载 */ }
  }

  async function prefetchFavUsers() {
    // 预取成员名单（网页收藏夹/外派可见性弹窗共用），打开弹窗不再等“加载成员列表中…”
    if (favUsers) return;
    try {
      const ur = await api('GET', '/api/users');
      favUsers = (ur.users || []).map((u) => ({ username: u.username, role: u.role }));
    } catch (e) { /* 失败时弹窗内仍会重试 */ }
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
    favData = null;
    favUsers = null;
    appsData = null;
    dispatchData = null;
    dispatchHistory = null;
    dispatchStatsCache = null;
    perfData = null;
    noStockData = null;
    todoData = null;
    payData = null;
    stockQtySort = null;
    prefs = null;
    invData = null;
    $('#fav-content').innerHTML = '';
    $('#inv-content').innerHTML = '';
    $('#inv-info').innerHTML = '';
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
  // ROLE_LABELS 已退役：岗位仅作历史模板标签显示（roleText），不再参与任何权限判断
  let stockData = null;      // GET /api/stock 结果：{items, lastImportAt, lastImportBy, lastPriceChangeAt, lastPriceChangeBy, canSeePrice, canImport, canExport, canEdit}
  let stockBatchMode = null; // null | 'edit'（admin：整行改+标记删除） | 'wh'（库存导出员：仅改备注库房）
  let stockQtySort = null;   // null | 'desc' | 'asc'：点击「库存量」表头切换排序（仅普通浏览模式）
  let stockEdits = {};       // 批量修改进行中的整行副本 {原始货品名称: {name, qty, cost, price, note, wh}}
  let stockDelSel = new Set(); // 批量删除勾选
  let stockWhEdits = {};     // 导出员的库房备注编辑副本 {原始货品名称: 新wh}

  async function loadStock() {
    const box = $('#stock-content');
    if (stockData) { renderStockPage(); refreshStock(); return; } // 缓存秒开 + 后台静默刷新
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

  function refreshStock() {
    api('GET', '/api/stock').then((d) => { stockData = d; renderStockPage(); }).catch(() => {});
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
      const nChg = stockChangedRows().length;
      const nDel = stockDelSel.size;
      const bSave = el('button', 'primary', '💾 保存全部修改' + (nDel ? '（改 ' + nChg + ' / 删 ' + nDel + '）' : '（' + nChg + '）'));
      bSave.id = 'stock-save-btn';
      bSave.onclick = saveStockBatchEdit;
      const bCancel = el('button', '', '取消');
      bCancel.onclick = exitStockBatch;
      bar.appendChild(bSave);
      bar.appendChild(bCancel);
    } else if (!stockData.canEdit && stockData.canWhEdit && stockBatchMode === 'wh') {
      // 「备注（库房）」批量模式（功能权限表驱动）：只能修改库房列
      bar.classList.add('sticky');
      const n = stockChangedWh().length;
      const bSave = el('button', 'primary', '💾 保存库房备注（' + n + '）');
      bSave.onclick = saveStockWhEdit;
      const bCancel = el('button', '', '取消');
      bCancel.onclick = exitStockBatch;
      bar.appendChild(bSave);
      bar.appendChild(bCancel);
    } else {
      if (stockData.canEdit) {
        const bAdd = el('button', 'primary', '＋ 新增配件');
        bAdd.classList.add('desk-only'); // 手机端隐藏：新增配件是桌面管理操作
        bAdd.onclick = openStockItemModal;
        bar.appendChild(bAdd);
        const bEdit = el('button', 'primary', '✏️ 批量修改');
        bEdit.classList.add('desk-only'); // 手机端隐藏：批量修改是桌面管理操作
        bEdit.onclick = enterStockBatchEdit;
        bar.appendChild(bEdit);
      }
      if (!stockData.canEdit && stockData.canWhEdit) {
        const bWh = el('button', 'primary', '✏️ 修改库房备注');
        bWh.classList.add('desk-only'); // 手机端隐藏
        bWh.onclick = enterStockWhEdit;
        bar.appendChild(bWh);
      }
      if (stockData.canImport) {
        const bImport = el('button', 'primary', '⇪ 导入 Excel');
        bImport.classList.add('desk-only'); // 手机端隐藏
        bImport.onclick = () => $('#stock-file').click();
        bar.appendChild(bImport);
      }
      if (stockData.canExport) {
        const bExport = el('button', 'primary', '⇩ 导出 Excel');
        bExport.classList.add('desk-only'); // 手机端隐藏
        bExport.onclick = exportStockExcel;
        bar.appendChild(bExport);
      }
      const bNs = el('button', 'primary', '📋 无库存产品统计');
      bNs.title = '查看/维护无库存产品统计（修改权限由管理员在设置中指定）';
      bNs.onclick = openNoStockModal;
      bar.appendChild(bNs);
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

    const plainView = stockBatchMode === null;
    let items = stockFiltered();
    // 库存量点击排序（仅普通浏览模式）：点一次倒序，再点一次正序
    if (plainView && stockQtySort) {
      items = [...items].sort((a, b) => {
        const x = Number(a.qty) || 0;
        const y = Number(b.qty) || 0;
        return stockQtySort === 'desc' ? y - x : x - y;
      });
    }
    // 成本价仅 admin 可见；售价 admin 和普通用户可见；库存上传员/导出员两者都不可见（服务端不下发字段）
    const heads = [];
    if (plainView) heads.push('序号'); // 极窄序号列：顺序向下排序，占货品名称的行空间
    heads.push('货品名称', '库存量');
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
      else if (h === '序号') cls = 'col-seq';
      const th = el('th', cls, h === '删?' ? '删' : h);
      if (plainView && h === '库存量') {
        th.style.cursor = 'pointer';
        th.title = '点击按库存量倒序，再次点击改为正序';
        th.textContent = '库存量' + (stockQtySort === 'desc' ? ' ▼' : (stockQtySort === 'asc' ? ' ▲' : ''));
        th.onclick = () => { stockQtySort = stockQtySort === 'desc' ? 'asc' : 'desc'; renderStockPage(); };
      }
      trh.appendChild(th);
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
    items.forEach((it, idx) => {
      const marked = stockDelSel.has(it.name);
      if (stockBatchMode === 'edit') tbody.appendChild(marked ? stockPlainRow(it, true, true) : stockEditRow(it));
      else if (stockBatchMode === 'wh') tbody.appendChild(stockWhRow(it));
      else tbody.appendChild(stockPlainRow(it, false, false, idx + 1));
    });
    if (!items.length) {
      const tr = el('tr');
      const td = el('td', 'modal-hint', ($('#stock-search').value || '').trim() ? '没有匹配的货品' : '库存表还是空的');
      td.colSpan = heads.length;
      tr.appendChild(td);
      tbody.appendChild(tr);
    }
    // 库存合计行（仅 admin）：固定悬浮在表头之下不随滚动消失。
    // 「合计」字样放货品名称列；库存量列=Σ库存量；成本总和=Σ库存量×成本价；售价总和=Σ库存量×售价（负数/非数字行忽略）。
    if (plainView && me && me.role === 'admin' && stockData.canSeeCost && stockData.canSeePrice && items.length) {
      let costSum = 0;
      let priceSum = 0;
      let qtySum = 0;
      items.forEach((it) => {
        const q = Number(it.qty);
        const c = Number(it.cost);
        const p = Number(it.price);
        if (Number.isFinite(q)) qtySum += q;
        if (Number.isFinite(q) && Number.isFinite(c) && c >= 0) costSum += q * c;
        if (Number.isFinite(q) && Number.isFinite(p) && p >= 0) priceSum += q * p;
      });
      const tr = el('tr', 'stock-total-row'); // 放入 thead 第二行：sticky 悬浮在表头正下方（滚动时一直可见）
      if (plainView) tr.appendChild(el('td', 'col-seq'));
      const tdName = el('td'); tdName.textContent = '合计'; tdName.dataset.label = '合计'; tr.appendChild(tdName);
      const tdQty = el('td', 'num'); tdQty.textContent = fmtQty(Math.round(qtySum * 1000) / 1000); tdQty.dataset.label = '库存量合计'; tdQty.title = '库存量总和'; tr.appendChild(tdQty);
      const tdC = el('td', 'num'); tdC.textContent = fmtCost(Math.round(costSum)); tdC.dataset.label = '成本合计'; tdC.title = '成本总和（Σ 库存量×成本价，取整；成本价为负或非数字的行已忽略）'; tr.appendChild(tdC);
      const tdP = el('td', 'num'); tdP.textContent = fmtSale(Math.round(priceSum)); tdP.dataset.label = '售价合计'; tdP.title = '售价总和（Σ 库存量×售价，取整；售价为负或非数字的行已忽略）'; tr.appendChild(tdP);
      const tdGap1 = el('td'); tdGap1.dataset.label = ''; tr.appendChild(tdGap1);
      const tdGap2 = el('td'); tdGap2.dataset.label = ''; tr.appendChild(tdGap2);
      const thead2 = tbl.querySelector('thead');
      thead2.appendChild(tr); // thead 内第二行 + CSS sticky top=表头高度 → 滚动时固定悬浮
    }
    tbl.appendChild(tbody);
    box.appendChild(tbl);
  }

  function stockPlainRow(it, withCheckbox, marked, seq) {
    const zero = Number(it.qty) === 0; // 库存量为 0 的行整行标红提示
    const modRed = it.lastModAt && (Date.now() - it.lastModAt) < 86400000; // admin 修改后 24 小时内
    // 一一对应：只有真正被改过的列才标红（lastModFields 记录 cost/price/note 哪些变了；旧数据无此字段则三列都红）
    const redField = (f) => modRed && (!it.lastModFields || !!it.lastModFields[f]);
    const tr = el('tr', marked ? 'stock-row-del' : (zero ? 'stock-row-zero' : ''));
    if (seq !== undefined) {
      const tdSeq = el('td', 'col-seq');
      tdSeq.textContent = String(seq);
      tr.appendChild(tdSeq);
    }
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
    const addLabeled = (cls, text, label) => {
      const td = el('td', cls);
      td.dataset.label = label; // 手机卡片模式显示字段名（桌面表格不受影响）
      td.appendChild(el('span', 'cell-v', text)); // 数值包一层：手机端可靠收缩对齐
      tr.appendChild(td);
    };
    addLabeled('col-name-t', it.name || '', '货品名称');
    addLabeled('num col-qty', fmtQty(it.qty), '库存量');
    if (stockData.canSeeCost) addLabeled('num' + (redField('cost') ? ' stock-mod-red' : ''), fmtCost(it.cost), '成本价');
    if (stockData.canSeePrice) addLabeled('num' + (redField('price') ? ' stock-mod-red' : ''), fmtSale(it.price), '售价');
    addLabeled('stock-note' + (redField('note') ? ' stock-mod-red' : ''), it.note || '', '备注');
    addLabeled('stock-note stock-wh', it.wh || '', '备注（库房）'); // 所有人可见
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
      // 两边都 trim 后再比较：Excel 导入常带首尾空格，否则刚进批量修改就会误报“已修改”
      const eq = (f) => String(e[f] == null ? '' : e[f]).trim() === String(orig[f] == null ? '' : orig[f]).trim();
      if (!fields.every(eq)) {
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
      // 两边都 trim 后再比较（同批量修改：原始值可能带首尾空格）
      if (String(stockWhEdits[it.name]).trim() !== String(it.wh == null ? '' : it.wh).trim()) {
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
    if (recvData) { renderRecvPage(); refreshRecv(); return; } // 缓存秒开 + 后台静默刷新
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

  function refreshRecv() {
    // 后台刷新：只更新数据重渲染，不清勾选状态
    api('GET', '/api/receivables').then((d) => { recvData = d; renderRecvPage(); }).catch(() => {});
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

  let recvDateSort = 0; // 应收明细日期排序：0=默认（导入顺序）1=正序 2=倒序（点表头「日期」切换）
  let recvClientSort = 0; // 往来客户列排序：0=默认 1=正序 2=倒序（点表头「往来客户」切换；与日期排序互斥，后点的生效）

  // 日期距今超过两个月（按自然月）→ true；解析失败返回 false
  function isOverdueDate(dateStr) {
    const d = new Date(String(dateStr || '').trim());
    if (isNaN(d.getTime())) return false;
    const now = new Date();
    const cutoff = new Date(now.getFullYear(), now.getMonth() - 2, now.getDate());
    return d < cutoff;
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
      const bImport = el('button', 'primary', '⇪ 导入 Excel');
      bImport.classList.add('desk-only'); // 手机端隐藏
      bImport.onclick = () => $('#recv-file').click();
      bar.appendChild(bImport);
    }
    // 检索框焦点/光标已在函数开头捕获（清空重建前）
    const bExport = el('button', 'primary', '⇩ 导出 Excel' + (recvSel.size ? '（已选 ' + recvSel.size + '）' : ''));
    bExport.classList.add('desk-only'); // 手机端隐藏
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
    if (recvDateSort !== 0) {
      // 点「日期」表头排序：日期为 ISO 格式（2025-04-21），字典序即时间序；同日期按 id 稳定
      const cmp = (a, b) => String(a.date || '').localeCompare(String(b.date || '')) || String(a.id || '').localeCompare(String(b.id || ''));
      rows.sort(recvDateSort === 1 ? cmp : (a, b) => cmp(b, a));
    } else if (recvClientSort !== 0) {
      // 点「往来客户」表头排序：客户名中文拼音序（localeCompare zh），同客户按 id 稳定
      const cmp = (a, b) => String(a.client || '').localeCompare(String(b.client || ''), 'zh-Hans-CN') || String(a.id || '').localeCompare(String(b.id || ''));
      rows.sort(recvClientSort === 1 ? cmp : (a, b) => cmp(b, a));
    }
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
    // 日期表头可点击：正序 ▲ / 倒序 ▼ 循环切换（其余列头不受影响）
    const thDate = [...trh.children].find((th) => th.classList.contains('col-date'));
    if (thDate) {
      thDate.classList.add('th-sortable');
      thDate.title = '点击按日期排序：正序 / 倒序切换';
      thDate.textContent = '日期' + (recvDateSort === 1 ? ' ▲' : recvDateSort === 2 ? ' ▼' : '');
      thDate.onclick = () => { recvDateSort = recvDateSort === 1 ? 2 : 1; recvClientSort = 0; renderRecvPage(); };
    }
    // 往来客户表头同样可点击排序（与日期排序互斥：后点的生效）
    const thClient = [...trh.children].find((th) => th.classList.contains('col-client'));
    if (thClient) {
      thClient.classList.add('th-sortable');
      thClient.title = '点击按往来客户排序：正序 / 倒序切换';
      thClient.textContent = '往来客户' + (recvClientSort === 1 ? ' ▲' : recvClientSort === 2 ? ' ▼' : '');
      thClient.onclick = () => { recvClientSort = recvClientSort === 1 ? 2 : 1; recvDateSort = 0; renderRecvPage(); };
    }
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
      if (isOverdueDate(r.date)) tr.classList.add('recv-row-overdue'); // 日期距今超过两个月：整行淡红标示
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
      const addCell = (cls, text, label) => {
        const td = el('td', cls);
        td.dataset.label = label; // 手机卡片模式显示字段名（桌面表格不受影响）
        td.appendChild(el('span', 'cell-v', text)); // 数值包一层：手机端可靠收缩对齐
        tr.appendChild(td);
      };
      addCell('col-date-t', r.date || '', '日期');
      addCell('', r.client || '', '往来客户');
      addCell('', r.item || '', '货品名称');
      addCell('num col-qty-r', fmtAmount(r.qty), '交易数量');
      addCell('num col-price-r', fmtAmount(r.price), '交易单价');
      addCell('num col-amount-r', fmtAmount(r.amount), '应收增加');
      addCell('stock-note', r.note || '', '附加说明');
      addCell('num col-handler', r.handler || '', '经手人');
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
    openModal('修改应收明细');
    const body = $('#modal-body');
    body.appendChild(el('div', 'modal-hint', '本次修改立即生效；下次导入 Excel 时会被新文件整体覆盖。'));
    const grid = el('div', 'recv-edit-grid');
    body.appendChild(grid);
    const fields = [
      ['date', '日期', false],
      ['client', '往来客户', false],
      ['item', '货品名称', false],
      ['qty', '交易数量', false],
      ['price', '交易单价', false],
      ['amount', '应收增加（可负）', false],
      ['note', '附加说明', true],
      ['handler', '经手人（须与账号名完全一致该用户才可见）', true],
    ];
    const inputs = {};
    fields.forEach(([k, ph, wide]) => {
      const wrap = el('label', 'rf-field' + (wide ? ' rf-wide' : ''));
      wrap.appendChild(el('span', 'rf-label', ph));
      const i = el('input');
      i.placeholder = ph;
      i.value = row[k] == null ? '' : String(row[k]);
      inputs[k] = i;
      wrap.appendChild(i);
      grid.appendChild(wrap);
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

  // ---------- 网页收藏夹（admin 可增删，所有人可见可点击，新标签页打开） ----------
  let favData = null;
  let favUsers = null; // 成员列表（admin 打开可见人员弹窗时加载一次）

  async function loadFav() {
    const box = $('#fav-content');
    if (favData) { renderFavPage(); refreshFav(); return; } // 缓存秒开 + 后台静默刷新
    box.innerHTML = '';
    box.appendChild(el('div', 'modal-hint', '加载中…'));
    try {
      favData = await api('GET', '/api/bookmarks');
      renderFavPage();
    } catch (e) {
      box.innerHTML = '';
      box.appendChild(el('div', 'modal-hint', '加载失败：' + e.message));
    }
  }

  function refreshFav() {
    api('GET', '/api/bookmarks').then((d) => { favData = d; renderFavPage(); }).catch(() => {});
  }

  function renderFavPage() {
    const box = $('#fav-content');
    const info = $('#fav-info');
    info.innerHTML = '';
    const d = favData || { items: [], canManage: false };
    if (d.updatedAt) {
      info.appendChild(el('span', 'stock-import-time', '🕐 最近一次修改：' + new Date(d.updatedAt).toLocaleString('zh-CN') + (d.updatedBy ? '（' + d.updatedBy + '）' : '')));
    }
    const bar = el('div', 'stock-toolbar');
    if (d.canManage) {
      const bAdd = el('button', 'primary', '＋ 新增收藏');
      bAdd.onclick = openFavAddModal;
      bar.appendChild(bAdd);
    }
    box.innerHTML = '';
    if (bar.children.length) box.appendChild(bar);
    const items = d.items || [];
    if (!items.length) {
      box.appendChild(el('div', 'modal-hint', d.canManage ? '还没有收藏的网页：点「＋ 新增收藏」添加第一个' : '管理员还没有添加收藏网页'));
      return;
    }
    const tbl = el('table', 'stock-table fav-table');
    const trh = el('tr');
    trh.appendChild(el('th', 'col-fav-name', '名称'));
    trh.appendChild(el('th', '', '网址'));
    if (d.canManage) {
      trh.appendChild(el('th', 'col-fav-op', '操作'));
      trh.appendChild(el('th', 'col-fav-vis', '可见人员')); // 管理可见成员（仅 admin）
      trh.appendChild(el('th', 'col-fav-handle', '')); // 拖动排序把手（最右侧）
    }
    const thead = el('thead');
    thead.appendChild(trh);
    tbl.appendChild(thead);
    const tbody = el('tbody');
    let dragId = null; // 正在拖动的收藏 id
    items.forEach((b) => {
      const tr = el('tr');
      const aName = el('a', 'fav-link', b.name || b.url);
      aName.href = b.url;
      aName.target = '_blank'; // 在新标签页打开
      aName.rel = 'noopener noreferrer';
      const tdName = el('td', 'col-fav-name-t');
      tdName.appendChild(aName);
      tr.appendChild(tdName);
      const aUrl = el('a', 'fav-link fav-url', b.url);
      aUrl.href = b.url;
      aUrl.target = '_blank';
      aUrl.rel = 'noopener noreferrer';
      aUrl.title = b.url;
      const tdUrl = el('td', 'fav-url-t');
      tdUrl.appendChild(aUrl);
      tr.appendChild(tdUrl);
      // 桌面版：点击链接改为跳默认浏览器（webview 内不打开外链）
      if (isTauriApp) {
        const openDefault = (e) => { e.preventDefault(); openAppTarget(b.url).catch((err) => alert('打开失败：' + err)); };
        aName.addEventListener('click', openDefault);
        aUrl.addEventListener('click', openDefault);
      }
      if (d.canManage) {
        const tdOp = el('td', 'col-fav-op');
        const bDel = el('button', 'fav-del', '🗑 删除');
        bDel.onclick = async () => {
          if (!confirm('删除收藏「' + (b.name || b.url) + '」？')) return;
          try {
            await api('POST', '/api/bookmarks-item', { action: 'delete', id: b.id });
            loadFav();
          } catch (e) { alert(e.message); }
        };
        tdOp.appendChild(bDel);
        tr.appendChild(tdOp);
        // 拖动排序：把手按住才允许整行拖动，松手保存新顺序
        const tdHandle = el('td', 'col-fav-handle');
        const handle = el('span', 'fav-handle', '⠿');
        handle.title = '按住拖动调整顺序';
        handle.addEventListener('mousedown', () => { tr.draggable = true; });
        tr.addEventListener('dragstart', (e) => {
          dragId = b.id;
          tr.classList.add('dragging');
          if (e.dataTransfer) { e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', b.id); } catch (err) {} }
        });
        tr.addEventListener('dragover', (e) => { e.preventDefault(); if (dragId && dragId !== b.id) tr.classList.add('drag-over'); });
        tr.addEventListener('dragleave', () => { tr.classList.remove('drag-over'); });
        tr.addEventListener('drop', async (e) => {
          e.preventDefault();
          tr.classList.remove('drag-over');
          if (!dragId || dragId === b.id) return;
          const list = (favData && favData.items) || [];
          const from = list.findIndex((x) => x.id === dragId);
          const to = list.findIndex((x) => x.id === b.id);
          if (from < 0 || to < 0) return;
          const moved = list.splice(from, 1)[0];
          list.splice(to, 0, moved);
          renderFavPage(); // 乐观更新
          try {
            await api('POST', '/api/bookmarks-item', { action: 'reorder', ids: list.map((x) => x.id) });
          } catch (e2) {
            alert('保存排序失败：' + e2.message);
            loadFav();
          }
        });
        tr.addEventListener('dragend', () => { tr.classList.remove('dragging', 'drag-over'); tr.draggable = false; dragId = null; });
        tdHandle.appendChild(handle);
        // 可见人员（把手前面）：点开弹窗选择哪些成员可以看到这条收藏（保存按钮统一提交）
        const tdVis = el('td', 'col-fav-vis');
        const visBtn = el('button', 'fav-vis-btn', favVisLabel(b));
        visBtn.title = '设置哪些成员可以看到这条收藏';
        visBtn.addEventListener('click', () => openFavVisModal(b, visBtn));
        tdVis.appendChild(visBtn);
        tr.appendChild(tdVis); // 可见人员在把手之前
        tr.appendChild(tdHandle); // 把手固定在行尾
      }
      tbody.appendChild(tr);
    });
    tbl.appendChild(tbody);
    box.appendChild(tbl);
  }

  // 收藏夹可见人员：visibleTo 空数组/未设置 = 所有人可见
  function favIsPublic(b) { return !Array.isArray(b.visibleTo) || !b.visibleTo.length; }
  function favVisLabel(b) {
    if (favIsPublic(b)) return '👥 所有人';
    if (Array.isArray(b.visibleTo) && b.visibleTo.length === 1 && b.visibleTo[0] === me.username) return '👥 仅管理员';
    return '👥 可见 ' + b.visibleTo.length + ' 人';
  }

  // 可见人员弹窗（类似历史报价弹窗）：点「保存」统一提交，「取消」不改动
  async function openFavVisModal(b, visBtn) {
    openModal('可见人员 — ' + (b.name || b.url));
    const body = $('#modal-body');
    if (!favUsers) {
      body.appendChild(el('div', 'modal-hint', '加载成员列表中…'));
      try {
        const ur = await api('GET', '/api/users');
        favUsers = (ur.users || []).map((u) => ({ username: u.username, role: u.role }));
      } catch (err) { favUsers = []; }
      if ($('#modal-title').textContent.indexOf('可见人员') === -1) return; // 弹窗已被关闭
      body.innerHTML = '';
    }
    body.appendChild(el('div', 'modal-hint', '勾选哪些成员可以看到这条收藏；勾选「所有成员」= 所有人可见。一个都不勾直接保存 = 仅管理员可见（其他成员完全看不到这条）。'));
    // 工作副本：在弹窗里勾选只改本地副本，点「保存」才提交
    const sel = new Set(favIsPublic(b) ? (favUsers || []).map((u) => u.username) : (b.visibleTo || []));
    const publicRow = el('label', 'fav-vis-item fav-vis-all');
    const cbAll = el('input');
    cbAll.type = 'checkbox';
    publicRow.appendChild(cbAll);
    publicRow.appendChild(el('span', '', '所有成员（等同于全选：所有人可见）'));
    body.appendChild(publicRow);
    const roleText = (role) => (role === 'admin' ? '管理员' : (role === 'uploader' ? '库存上传员' : (role === 'exporter' ? '库存导出员' : (role === 'referrer' ? '参考者' : '普通用户'))));
    const members = (favUsers || []).filter((u) => u.username !== me.username); // admin 自己始终可见，不列进名单
    members.forEach((u) => {
      const lab = el('label', 'fav-vis-item');
      const cb = el('input');
      cb.type = 'checkbox';
      cb.checked = sel.has(u.username);
      cb.onchange = () => {
        if (cb.checked) sel.add(u.username); else sel.delete(u.username);
        cbAll.checked = members.length > 0 && members.every((x) => sel.has(x.username));
      };
      lab.appendChild(cb);
      lab.appendChild(el('span', '', u.username));
      lab.appendChild(el('span', 'fav-vis-role', roleText(u.role)));
      body.appendChild(lab);
    });
    cbAll.checked = members.length > 0 && members.every((x) => sel.has(x.username));
    cbAll.onchange = () => {
      members.forEach((u) => { if (cbAll.checked) sel.add(u.username); else sel.delete(u.username); });
      members.forEach((u, i) => { body.querySelectorAll('.fav-vis-item input[type=checkbox]')[i + 1].checked = cbAll.checked; });
    };
    const foot = el('div', 'form-row');
    const bOk = el('button', 'primary', '保存');
    const bCancel = el('button', '', '取消');
    bCancel.onclick = closeModal;
    foot.appendChild(bOk);
    foot.appendChild(bCancel);
    body.appendChild(foot);
    bOk.onclick = async () => {
      const all = members.length === 0 || members.every((x) => sel.has(x.username));
      const list = members.filter((x) => sel.has(x.username)).map((x) => x.username);
      // 全选=所有人可见；部分勾选=名单内可见；全不勾=仅管理员可见（名单放 admin 自己）
      const vis = all ? [] : (list.length ? list : [me.username]);
      bOk.disabled = true;
      try {
        const r = await api('POST', '/api/bookmarks-item', { action: 'visibility', id: b.id, visibleTo: vis });
        b.visibleTo = Array.isArray(r.visibleTo) ? r.visibleTo : [];
        visBtn.textContent = favVisLabel(b);
        closeModal();
      } catch (e) { alert(e.message); }
      finally { bOk.disabled = false; }
    };
  }

  function openFavAddModal() {
    openModal('新增收藏网页');
    const body = $('#modal-body');
    body.appendChild(el('div', 'modal-hint', '保存后所有人都能看到；点击会在新标签页打开。网址没写协议会自动补 https://。'));
    const iName = el('input'); iName.placeholder = '名称（必填，如：阿里云控制台）';
    const iUrl = el('input'); iUrl.placeholder = '网址（必填，可直接填 example.com）';
    [iName, iUrl].forEach((x) => { x.style.marginBottom = '10px'; x.style.width = '100%'; x.style.padding = '9px 10px'; x.style.border = '1px solid #d9dce1'; x.style.borderRadius = '8px'; body.appendChild(x); });
    const foot = el('div', 'form-row');
    const bOk = el('button', 'primary', '保存');
    const bCancel = el('button', '', '取消');
    bCancel.onclick = closeModal;
    foot.appendChild(bOk);
    foot.appendChild(bCancel);
    body.appendChild(foot);
    bOk.onclick = async () => {
      const name = iName.value.trim();
      const url = iUrl.value.trim();
      if (!name) { alert('请输入名称'); return; }
      if (!url) { alert('请输入网址'); return; }
      bOk.disabled = true;
      try {
        await api('POST', '/api/bookmarks-item', { action: 'add', item: { name, url } });
        closeModal();
        loadFav();
      } catch (e) { alert(e.message); }
      finally { bOk.disabled = false; }
    };
  }

  // ---------- 发票进项统计（admin/库存上传员导入，所有登录用户可见，无导出） ----------
  let invData = null; // GET /api/invoices 结果 {items, canImport, lastImportAt, lastImportBy}

  async function loadInv() {
    const box = $('#inv-content');
    if (invData) { renderInvPage(); refreshInv(); return; } // 缓存秒开 + 后台静默刷新
    box.innerHTML = '';
    box.appendChild(el('div', 'modal-hint', '加载中…'));
    try {
      invData = await api('GET', '/api/invoices');
    } catch (e) {
      box.innerHTML = '';
      box.appendChild(el('div', 'modal-hint', '加载失败：' + e.message));
      return;
    }
    renderInvPage();
  }

  function refreshInv() {
    api('GET', '/api/invoices').then((d) => { invData = d; renderInvPage(); }).catch(() => {});
  }

  function invFiltered() {
    const kw = ($('#inv-search').value || '').trim().toLowerCase();
    const items = (invData && invData.items) || [];
    if (!kw) return items;
    return items.filter((it) => String(it.name).toLowerCase().indexOf(kw) !== -1
      || String(it.model || '').toLowerCase().indexOf(kw) !== -1);
  }

  function renderInvPage() {
    const box = $('#inv-content');
    const info = $('#inv-info');
    box.innerHTML = '';
    const d = invData || { items: [] };
    const kw = ($('#inv-search').value || '').trim();
    const items = invFiltered();
    info.innerHTML = '';
    // 与库存表看齐：🕐 最近一次导入：时间（人）
    const it = d.lastImportAt
      ? new Date(d.lastImportAt).toLocaleString('zh-CN') + (d.lastImportBy ? '（' + d.lastImportBy + '）' : '')
      : '尚未导入过';
    info.appendChild(el('span', '', (kw ? '匹配 ' + items.length + ' 项（共 ' + (d.items || []).length + ' 项）　' : '共 ' + (d.items || []).length + ' 项　')));
    info.appendChild(el('span', 'stock-import-time', '🕐 最近一次导入：' + it));
    const bar = el('div', 'stock-toolbar');
    if (d.canImport) {
      const bImport = el('button', 'primary', '⇪ 导入 Excel');
      bImport.classList.add('desk-only'); // 手机端隐藏
      bImport.onclick = () => $('#inv-file').click();
      bar.appendChild(bImport);
    }
    if (bar.children.length) box.appendChild(bar);
    if (d.canImport && !$('#inv-file')) {
      const fi = el('input');
      fi.type = 'file';
      fi.id = 'inv-file';
      fi.accept = '.xls,.xlsx';
      fi.style.display = 'none';
      fi.onchange = onInvFilePicked;
      box.appendChild(fi);
    }
    const tbl = el('table', 'stock-table');
    const thead = el('thead');
    const trh = el('tr');
    trh.appendChild(el('th', 'col-name', '货物名称'));
    trh.appendChild(el('th', '', '型号'));
    trh.appendChild(el('th', 'col-num', '单位'));
    trh.appendChild(el('th', 'col-inv-rem', '剩余数量'));
    thead.appendChild(trh);
    tbl.appendChild(thead);
    const tbody = el('tbody');
    items.forEach((it) => {
      const zero = Number(it.remaining) <= 0; // 剩余数量 ≤0 的行整行标红（与库存表零库存标红一致）
      const tr = el('tr', zero ? 'inv-row-zero' : '');
      tr.appendChild(el('td', 'col-name-t', it.name || ''));
      tr.appendChild(el('td', 'col-inv-model-t', it.model || ''));
      tr.appendChild(el('td', '', it.unit || ''));
      tr.appendChild(el('td', 'num', String(it.remaining)));
      tbody.appendChild(tr);
    });
    tbl.appendChild(tbody);
    box.appendChild(tbl);
    if (!items.length) {
      box.appendChild(el('div', 'modal-hint', kw ? '没有匹配的货物' : (d.lastImportAt ? '没有数据' : '还没有数据：请点「导入 Excel」选择进项表（三组并排版式自动摊平）')));
    }
  }

  async function onInvFilePicked(e) {
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
      const r = await api('POST', '/api/invoices-import', { dataBase64: b64 });
      alert('导入完成：本次导入 ' + r.total + ' 行（已完全覆盖原数据）' + (r.dupSkipped ? '，同键重复跳过 ' + r.dupSkipped + ' 行' : ''));
      loadInv();
    } catch (err) { alert('导入失败：' + err.message); }
  }

  // ---------- 应用收藏夹（桌面版：启动本机应用/跳默认浏览器；网页版：协议链接交给系统处理） ----------
  let appsData = null;
  const isTauriApp = !!(window.__TAURI_INTERNALS__ || window.__TAURI__);

  function tauriInvoke(cmd, args) {
    const internals = window.__TAURI_INTERNALS__;
    if (internals && internals.invoke) return internals.invoke(cmd, args);
    if (window.__TAURI__ && window.__TAURI__.invoke) return window.__TAURI__.invoke(cmd, args);
    return Promise.reject(new Error('该操作仅桌面版支持'));
  }

  // 统一打开入口：桌面版走 Rust（浏览器/启动应用）；网页版 http(s) 新标签、协议链接交给系统
  function openAppTarget(target) {
    const t = String(target || '');
    if (isTauriApp) {
      // http(s)/自定义协议一律走系统 opener（默认浏览器或对应应用），不再经 explorer（会误开资源管理器）
      if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/i.test(t)) return tauriInvoke('plugin:opener|open_url', { path: t });
      return tauriInvoke('open_target', { target: t }); // exe/lnk 仍走 open_target 启动本机程序
    }
    if (/^https?:\/\//i.test(t)) { window.open(t, '_blank', 'noopener'); return Promise.resolve(); }
    const a = document.createElement('a'); // 协议链接（weixin:// 等）：浏览器自行处理，可能弹确认框
    a.href = t; a.style.display = 'none';
    document.body.appendChild(a); a.click();
    setTimeout(() => a.remove(), 2000);
    return Promise.resolve();
  }

  async function loadApps() {
    const box = $('#apps-content');
    if (appsData) { renderAppsPage(); refreshApps(); return; } // 缓存秒开 + 后台静默刷新
    box.innerHTML = '';
    box.appendChild(el('div', 'modal-hint', '加载中…'));
    try {
      appsData = await api('GET', '/api/app-favs');
      renderAppsPage();
    } catch (e) {
      box.innerHTML = '';
      box.appendChild(el('div', 'modal-hint', '加载失败：' + e.message));
    }
  }

  function refreshApps() {
    api('GET', '/api/app-favs').then((d) => { appsData = d; renderAppsPage(); }).catch(() => {});
  }

  function appKindLabel(t) { return /\.exe$/i.test(t) ? '本机应用' : (/\.lnk$/i.test(t) ? '快捷方式' : '应用链接'); }

  function renderAppsPage() {
    const box = $('#apps-content');
    const info = $('#apps-info');
    info.innerHTML = '';
    const d = appsData || { items: [], canManage: false };
    if (d.updatedAt) {
      info.appendChild(el('span', 'stock-import-time', '🕐 最近一次修改：' + new Date(d.updatedAt).toLocaleString('zh-CN') + (d.updatedBy ? '（' + d.updatedBy + '）' : '')));
    }
    const bar = el('div', 'stock-toolbar');
    {
      const bAdd = el('button', 'primary', '＋ 添加应用');
      bAdd.onclick = openAppsAddModal;
      bar.appendChild(bAdd);
    }
    box.innerHTML = '';
    if (bar.children.length) box.appendChild(bar);
    const kw = (($('#apps-search') && $('#apps-search').value) || '').trim().toLowerCase();
    const items = (d.items || []).filter((a) => !kw || (a.name || '').toLowerCase().includes(kw) || (a.target || '').toLowerCase().includes(kw));
    if (!items.length) {
      box.appendChild(el('div', 'modal-hint', kw ? '没有匹配的应用' : '你的应用收藏夹还是空的：点「＋ 添加应用」添加常用软件（如微信、网易邮箱大师）'));
      return;
    }
    const tbl = el('table', 'stock-table apps-table');
    const trh = el('tr');
    trh.appendChild(el('th', 'col-apps-name', '名称'));
    trh.appendChild(el('th', 'col-apps-kind', '类型'));
    trh.appendChild(el('th', '', '目标'));
    {
      trh.appendChild(el('th', 'col-fav-op', '操作'));
      trh.appendChild(el('th', 'col-fav-handle', '')); // 拖动排序把手
    }
    const thead = el('thead');
    thead.appendChild(trh);
    tbl.appendChild(thead);
    const tbody = el('tbody');
    let dragId = null;
    items.forEach((b) => {
      const tr = el('tr');
      const webOnly = !isTauriApp && /\.exe$|\.lnk$/i.test(b.target); // 本机路径条目在网页版无法启动
      const tdName = el('td', 'col-apps-name-t');
      tdName.dataset.label = '名称';
      const aName = el('a', 'fav-link', b.name);
      aName.href = 'javascript:void(0)';
      aName.onclick = (e) => {
        e.preventDefault();
        if (webOnly) { alert('「' + b.name + '」是本机应用，请在桌面版应用里点击启动'); return; }
        openAppTarget(b.target).catch((err) => alert('启动失败：' + err));
      };
      tdName.appendChild(aName);
      tr.appendChild(tdName);
      const tdKind = el('td', 'col-apps-kind-t');
      tdKind.dataset.label = '类型';
      tdKind.appendChild(el('span', 'app-kind-badge' + (/\.exe$|\.lnk$/i.test(b.target) ? ' app-kind-exe' : ''), appKindLabel(b.target) + (webOnly ? '（仅桌面）' : '')));
      tr.appendChild(tdKind);
      const tdTarget = el('td', 'col-apps-target');
      tdTarget.dataset.label = '目标';
      tdTarget.textContent = b.target;
      tdTarget.title = b.target;
      tr.appendChild(tdTarget);
      {
        const tdOp = el('td', 'col-fav-op');
        const bDel = el('button', 'fav-del', '🗑 删除');
        bDel.onclick = async () => {
          if (!confirm('删除应用「' + b.name + '」？')) return;
          try {
            await api('POST', '/api/app-favs-item', { action: 'delete', id: b.id });
            loadApps();
          } catch (e) { alert(e.message); }
        };
        tdOp.appendChild(bDel);
        tr.appendChild(tdOp);
        const tdHandle = el('td', 'col-fav-handle');
        const handle = el('span', 'fav-handle', '⠿');
        handle.title = '按住拖动调整顺序';
        handle.addEventListener('mousedown', () => { tr.draggable = true; });
        tr.addEventListener('dragstart', (e) => {
          dragId = b.id;
          tr.classList.add('dragging');
          if (e.dataTransfer) { e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', b.id); } catch (err) {} }
        });
        tr.addEventListener('dragover', (e) => { e.preventDefault(); if (dragId && dragId !== b.id) tr.classList.add('drag-over'); });
        tr.addEventListener('dragleave', () => { tr.classList.remove('drag-over'); });
        tr.addEventListener('drop', async (e) => {
          e.preventDefault();
          tr.classList.remove('drag-over');
          if (!dragId || dragId === b.id) return;
          const list = (appsData && appsData.items) || [];
          const from = list.findIndex((x) => x.id === dragId);
          const to = list.findIndex((x) => x.id === b.id);
          if (from < 0 || to < 0) return;
          const moved = list.splice(from, 1)[0];
          list.splice(to, 0, moved);
          renderAppsPage(); // 乐观更新
          try {
            await api('POST', '/api/app-favs-item', { action: 'reorder', ids: list.map((x) => x.id) });
          } catch (e2) {
            alert('保存排序失败：' + e2.message);
            loadApps();
          }
        });
        tr.addEventListener('dragend', () => { tr.classList.remove('dragging', 'drag-over'); tr.draggable = false; dragId = null; });
        tdHandle.appendChild(handle);
        tr.appendChild(tdHandle);
      }
      tbody.appendChild(tr);
    });
    tbl.appendChild(tbody);
    box.appendChild(tbl);
  }

  function openAppsAddModal() {
    openModal('添加应用到我的收藏夹');
    const body = $('#modal-body');
    // 名称：一大横行输入框，灰色占位「名称」
    const inName = el('input', 'app-big-input');
    inName.placeholder = '名称';
    body.appendChild(inName);
    // 位置：宽输入 + 桌面版可从系统文件管理器选择 exe/lnk
    const lab2 = el('label', 'app-form-label', '位置（本机程序路径或应用协议链接）');
    body.appendChild(lab2);
    const locRow = el('div', 'app-loc-row');
    body.appendChild(locRow);
    const inTarget = el('input');
    inTarget.placeholder = isTauriApp ? '如 C:\\Program Files\\Tencent\\WeChat\\WeChat.exe 或 weixin://' : '如 weixin://（网页版仅支持应用协议链接）';
    locRow.appendChild(inTarget);
    if (isTauriApp) {
      const bPick = el('button', 'btn-edit', '📁 从文件管理器选择');
      bPick.title = '打开系统文件选择器，找到程序后自动填入位置与名称';
      bPick.onclick = async () => {
        try {
          const picked = await tauriInvoke('plugin:dialog|open', { options: { multiple: false, directory: false, title: '选择应用程序', filters: [{ name: '程序/快捷方式', extensions: ['exe', 'lnk'] }] } });
          const p = Array.isArray(picked) ? picked[0] : picked;
          if (!p) return;
          inTarget.value = p;
          if (!inName.value.trim()) {
            const base = String(p).split('\\').pop().replace(/\.(exe|lnk)$/i, '');
            inName.value = base;
          }
        } catch (e) { alert('打开文件选择器失败：' + e.message); }
      };
      locRow.appendChild(bPick);
    }
    // 常见应用快捷填入（桌面版探测）
    if (isTauriApp) {
      const probeBox = el('div', 'app-probe');
      body.appendChild(probeBox);
      probeBox.appendChild(el('div', 'app-form-label', '或从检测到的常用应用中选择：'));
      const row = el('div', 'app-probe-row');
      probeBox.appendChild(row);
      row.appendChild(el('span', 'modal-hint', '检测中…'));
      tauriInvoke('probe_apps').then((found) => {
        row.innerHTML = '';
        const list = found || [];
        if (!list.length) { row.appendChild(el('span', 'modal-hint', '未检测到常见应用，请手动填写上方表单')); return; }
        list.forEach((it) => {
          const b = el('button', 'btn-edit app-chip', it[0]);
          b.onclick = () => { inName.value = it[0]; inTarget.value = it[1]; };
          row.appendChild(b);
        });
      }).catch(() => { row.innerHTML = ''; row.appendChild(el('span', 'modal-hint', '探测不可用，请手动填写上方表单')); });
    }
    body.appendChild(el('div', 'modal-hint', '说明：本机程序路径仅桌面版可启动；协议链接（weixin:// 等）桌面与网页均可使用。'));
    const foot = el('div', 'form-row');
    const bOk = el('button', 'primary', '添加');
    const bCancel = el('button', '', '取消');
    bCancel.onclick = closeModal;
    foot.appendChild(bOk);
    foot.appendChild(bCancel);
    body.appendChild(foot);
    bOk.onclick = async () => {
      try {
        await api('POST', '/api/app-favs-item', { action: 'add', item: { name: inName.value, target: inTarget.value } });
        closeModal();
        loadApps();
      } catch (e) { alert(e.message); }
    };
  }

  // ---------- 设置（左下角 ⚙️；个人偏好存后端跟账号走，之后可扩展更多设置项） ----------
  let prefs = null;
  const PREFS_CACHE_PREFIX = 'qa_prefs_cache_'; // 按用户名缓存侧栏顺序/开关：登录瞬间先按缓存摆好，消除“先默认后跳变”的闪动

  function savePrefsCache() {
    if (!me || !me.username || !prefs) return;
    try { localStorage.setItem(PREFS_CACHE_PREFIX + me.username, JSON.stringify(prefs)); } catch (e) { /* 隐私模式等场景忽略 */ }
  }

  function applyCachedPrefs() {
    // enterApp 起始同步调用：先用本地缓存的个人设置摆好侧栏，再等云端确认（无声刷新）
    if (!me || !me.username) return;
    prefs = null;
    try {
      const raw = localStorage.getItem(PREFS_CACHE_PREFIX + me.username);
      const cached = raw ? JSON.parse(raw) : null;
      if (cached && typeof cached === 'object' && !Array.isArray(cached)) prefs = cached;
    } catch (e) { prefs = null; }
    if (prefs) applyPrefs();
  }

  const PAGE_ORDER_KEYS = ['btn-stock', 'btn-recv', 'btn-inv', 'btn-fav', 'btn-apps', 'btn-dispatch', 'btn-perf', 'btn-todo', 'btn-pay', 'btn-io'];

  function applyPageOrder() {
    // 个人侧栏功能排序（仅桌面侧栏；手机抽屉与侧栏同源跟随，底部导航不变）
    const sidebar = document.querySelector('.sidebar');
    if (!sidebar) return;
    const btns = PAGE_ORDER_KEYS.map((id) => document.getElementById(id)).filter(Boolean);
    if (!btns.length) return;
    let seq = (prefs && Array.isArray(prefs.pageOrder)) ? prefs.pageOrder.filter((id) => btns.some((b) => b.id === id)) : [];
    PAGE_ORDER_KEYS.forEach((id) => { if (!seq.includes(id)) seq.push(id); }); // 新增按钮自动补到末尾
    const anchor = sidebar.querySelector('.side-label'); // 「历史报价」标签：功能按钮排在其之前
    seq.forEach((id) => {
      const b = document.getElementById(id);
      if (b) sidebar.insertBefore(b, anchor);
    });
  }

  function applyPrefs() {
    // 页面入口开关（默认显示；仅对自己生效）
    $('#btn-apps').classList.toggle('hidden', !!(prefs && prefs.hideApps));
    $('#btn-todo').classList.toggle('hidden', !!(prefs && prefs.hideTodos)); // 代办事项开关，与应用收藏夹一致
    applyPageOrder();
    savePrefsCache(); // 每次应用时同步本地缓存（云端为准，缓存只做“首屏秒定”）
    if (prefs && prefs.hideApps && !$('#apps-page').classList.contains('hidden')) showPage('chat');
    if (prefs && prefs.hideTodos && !$('#todo-page').classList.contains('hidden')) showPage('chat');
  }

  async function loadPrefs() {
    try {
      const r = await api('GET', '/api/prefs');
      prefs = r.prefs || {};
    } catch (e) { prefs = prefs || {}; }
    applyPrefs();
  }

  async function openSettingsModal() {
    openModal('设置');
    const body = $('#modal-body');
    // 可收起/展开的折叠区（默认收起，保持设置界面简洁）
    const mkCollapse = (title, defOpen) => {
      const head = el('div', 'settings-collapse');
      const arrow = el('span', 'settings-arrow', defOpen ? '▾' : '▸');
      head.appendChild(arrow);
      head.appendChild(el('span', 'settings-collapse-title', title));
      const sec = el('div', 'settings-section');
      head.onclick = () => {
        const open = sec.style.display !== 'none';
        sec.style.display = open ? 'none' : '';
        arrow.textContent = open ? '▸' : '▾';
      };
      if (!defOpen) sec.style.display = 'none';
      return { head, sec };
    };
    body.appendChild(el('div', 'settings-label', '页面开关'));
    const sec = el('div', 'settings-section');
    body.appendChild(sec);
    const mkToggle = (labelText, key) => {
      const lab = el('label', 'fav-vis-item');
      const cb = el('input');
      cb.type = 'checkbox';
      cb.checked = !(prefs && prefs[key]);
      lab.appendChild(cb);
      lab.appendChild(el('span', '', labelText));
      sec.appendChild(lab);
      cb.onchange = async () => {
        try {
          const r = await api('POST', '/api/prefs-item', { key, value: !cb.checked });
          prefs = prefs || {};
          prefs[key] = r.value;
          applyPrefs();
        } catch (e) { cb.checked = !cb.checked; alert(e.message); }
      };
      return cb;
    };
    mkToggle('显示「应用收藏夹」入口', 'hideApps');
    mkToggle('显示「代办事项」入口', 'hideTodos'); // 与应用收藏夹同一模式
    sec.appendChild(el('div', 'modal-hint', '关闭后侧栏（含手机端抽屉）不再显示对应入口；已有数据不受影响。设置只对自己生效，改动立即保存。'));
    // 个人侧栏功能排序（仅桌面侧栏）——可收起/展开，默认收起
    const ord = mkCollapse('侧栏功能排序（仅桌面侧栏生效）', false);
    body.appendChild(ord.head);
    body.appendChild(ord.sec);
    const secOrd = ord.sec;
    const curOrder = PAGE_ORDER_KEYS.map((id) => document.getElementById(id)).filter(Boolean).map((b) => b.id);
    const labelOf = (id) => { const b = document.getElementById(id); return b ? b.textContent.trim() : id; };
    const saveOrder = async (arr) => {
      try {
        await api('POST', '/api/prefs-item', { key: 'pageOrder', value: arr });
        prefs = prefs || {};
        prefs.pageOrder = arr;
        applyPageOrder();
      } catch (e) { alert(e.message); }
    };
    const renderOrd = () => {
      secOrd.innerHTML = '';
      secOrd.appendChild(el('div', 'modal-hint', '按住某一行上下拖动到目标位置，松手自动保存（仅桌面侧栏生效）。'));
      const list = el('div', 'order-list');
      secOrd.appendChild(list);
      let dragEl = null;
      curOrder.forEach((id) => {
        const row = el('div', 'order-row');
        row.dataset.id = id;
        row.textContent = labelOf(id);
        row.draggable = true;
        row.addEventListener('dragstart', (e) => {
          dragEl = row;
          row.classList.add('dragging');
          if (e.dataTransfer) {
            e.dataTransfer.effectAllowed = 'move';
            try { e.dataTransfer.setData('text/plain', id); } catch (err) { /* 忽略 */ }
          }
        });
        row.addEventListener('dragover', (e) => {
          e.preventDefault();
          if (!dragEl || dragEl === row) return;
          const rect = row.getBoundingClientRect();
          const before = (e.clientY - rect.top) < rect.height / 2; // 上半=插到前面，下半=插到后面
          list.insertBefore(dragEl, before ? row : row.nextSibling);
        });
        row.addEventListener('dragend', () => {
          row.classList.remove('dragging');
          dragEl = null;
          const newOrder = [...list.children].map((c) => c.dataset.id).filter(Boolean);
          if (newOrder.join(',') !== curOrder.join(',')) {
            curOrder.length = 0;
            newOrder.forEach((x) => curOrder.push(x));
            saveOrder(curOrder.slice());
          }
        });
        list.appendChild(row);
      });
    };
    renderOrd();
    // admin：功能权限管理（无库存产品统计的修改权也已并入其中）——标题同步渲染，名单异步填充，默认收起
    if (me && me.role === 'admin') {
      const permTop = mkCollapse('功能权限管理', false);
      body.appendChild(permTop.head);
      body.appendChild(permTop.sec);
      const secPerm = permTop.sec;
      secPerm.appendChild(el('div', 'modal-hint', '加载中…'));
      // 功能权限表（异步填充，不阻塞界面）
      (async () => {
        try {
          const pr = await api('GET', '/api/perms');
          const defs = pr.defs || [];
          const all = pr.all || {};
          const permUsers = pr.users || [];
          secPerm.innerHTML = '';
          secPerm.appendChild(el('div', 'modal-hint', '按功能勾选可用成员，改动立即生效；管理员始终拥有全部权限。'));
          const groups = [];
          defs.forEach((p) => { if (!groups.includes(p.group)) groups.push(p.group); });
          groups.forEach((g) => {
            const gc = mkCollapse(g, false);
            secPerm.appendChild(gc.head);
            secPerm.appendChild(gc.sec);
            defs.filter((p) => p.group === g).forEach((p) => {
              gc.sec.appendChild(el('div', 'settings-label', p.name + (p.desc ? '：' + p.desc : '')));
              permUsers.forEach((un) => {
                const l = el('label', 'fav-vis-item');
                const c = el('input');
                c.type = 'checkbox';
                c.checked = (all[un] || []).includes(p.key);
                c.onchange = async () => {
                  try {
                    const rr = await api('POST', '/api/perms-item', { action: 'set', username: un, key: p.key, value: c.checked });
                    all[un] = rr.keys || [];
                  } catch (e) { c.checked = !c.checked; alert(e.message); }
                };
                l.appendChild(c);
                l.appendChild(el('span', '', un));
                gc.sec.appendChild(l);
              });
            });
          });
          if (!defs.length) secPerm.appendChild(el('div', 'modal-hint', '权限注册表为空'));
          mountIoSec(); // 出入库权限区并入功能权限管理区内部（权限表渲染完再挂载）
        } catch (e) {
          secPerm.innerHTML = '';
          secPerm.appendChild(el('div', 'modal-hint', '权限表加载失败：' + e.message + '（出入库权限区仍可正常使用）'));
          mountIoSec();
        }
      })();

      // admin：出入库权限管理（并入「功能权限管理」区内部：按分表授权 + 物流单号备注人名名单）
      const ioTop = mkCollapse('出入库权限（按分表授权 / 物流单号备注人名名单）', false);
      const secIo = ioTop.sec;
      const mountIoSec = () => {
        if (secIo.isConnected) return;
        secPerm.appendChild(ioTop.head);
        secPerm.appendChild(secIo);
        renderIoPermSec(ioData);
      };
      const renderIoPermSec = (dat) => {
        secIo.innerHTML = '';
        if (!dat) { secIo.appendChild(el('div', 'modal-hint', '加载出入库数据中…')); return; }
        if (!(dat.books || []).length) { secIo.appendChild(el('div', 'modal-hint', '暂无出入库序列号：在「出入库」页上传 Excel 后，这里会按分表列出授权入口。')); return; }
        secIo.appendChild(el('div', 'modal-hint', '每个分表单独授权：点「设置名单」勾选成员的 可编辑 / 可见全部 / 只看自己（物流单号三档互斥），保存立即生效。'));
        (dat.books || []).forEach((b) => {
          secIo.appendChild(el('div', 'settings-label', '序列号：' + b.serial));
          (b.sheets || []).forEach((s) => {
            const row = el('div', 'io-perm-row');
            const svN = (s.selfViewers || []).length;
            row.appendChild(el('span', 'io-perm-sheet', '· ' + s.name + '（编辑 ' + (s.editors || []).length + ' / 可见 ' + (s.viewers || []).length + (svN ? ' / 只看自己 ' + svN : '') + '）'));
            const btn = el('button', '', '👥 设置名单');
            btn.onclick = () => openIoPermModal(s);
            row.appendChild(btn);
            secIo.appendChild(row);
          });
        });
        // 物流单号·备注人名名单（从注册账号中勾选；编辑模式点「备注」列即弹该名单）
        const usernames = dat.usernames || [];
        if (usernames.length) {
          secIo.appendChild(el('div', 'settings-label', '物流单号 · 备注人名名单（勾选的人会出现在「备注」列的选择栏里）'));
          const grid = el('div', 'io-names-grid');
          const sel = new Set(dat.ioNameList || usernames);
          usernames.forEach((u) => {
            const item = el('label', 'io-name-chk');
            const cb = el('input');
            cb.type = 'checkbox';
            cb.checked = sel.has(u);
            item.appendChild(cb);
            const sp = el('span', '', u);
            item.appendChild(sp);
            grid.appendChild(item);
          });
          secIo.appendChild(grid);
          const bNames = el('button', 'primary', '保存人名名单');
          bNames.onclick = async () => {
            const names = Array.from(grid.querySelectorAll('.io-name-chk')).filter((it) => it.querySelector('input').checked).map((it) => it.querySelector('span').textContent);
            try {
              await api('POST', '/api/io-item', { action: 'set-names', names });
              if (ioData) ioData.ioNameList = names;
              alert('已保存：' + names.length + ' 人');
            } catch (e) { alert(e.message); }
          };
          secIo.appendChild(bNames);
          secIo.appendChild(el('div', 'modal-hint', '说明：名单只能从已注册的账号里勾选；「只看自己」的成员按行内备注=自己的用户名匹配可见行。'));
        }
      };
      renderIoPermSec(ioData);
      (async () => {
        try {
          const fresh = await api('GET', '/api/io');
          ioData = fresh;
          if (secIo.isConnected) renderIoPermSec(fresh); // 弹窗还开着才刷新
        } catch (e) {
          if (secIo.isConnected && !ioData) {
            secIo.innerHTML = '';
            secIo.appendChild(el('div', 'modal-hint', '出入库数据加载失败：' + e.message + '（若提示接口不存在，请先部署最新的 scf-deploy.zip）'));
          }
        }
      })();

      // admin：邮件备份（每天定时把每个序列号的整本 Excel 发到配置邮箱；163/126 SMTP 授权码）
      const mailTop = mkCollapse('邮件备份（每日自动发出入库 Excel）', false);
      body.appendChild(mailTop.head);
      body.appendChild(mailTop.sec);
      const secMail = mailTop.sec;
      (async () => {
        let cfg = { enabled: false, host: 'smtp.163.com', port: 465, user: '', to: '', dailyTime: '20:00', hasPass: false };
        try {
          const r = await api('POST', '/api/io-item', { action: 'mail-get' });
          cfg = Object.assign(cfg, r.cfg || {});
          secMail.innerHTML = '';
          const mkField = (label, val, ph, type) => {
            const row = el('div', 'io-mail-row');
            row.appendChild(el('span', 'io-mail-label', label));
            const inp = el('input', 'edit-input');
            inp.type = type || 'text';
            inp.value = val;
            inp.placeholder = ph || '';
            row.appendChild(inp);
            secMail.appendChild(row);
            return inp;
          };
          const cbRow = el('div', 'io-mail-row');
          const cbEn = el('input');
          cbEn.type = 'checkbox';
          cbEn.checked = !!cfg.enabled;
          cbRow.appendChild(cbEn);
          cbRow.appendChild(el('span', '', '每天自动备份（到点后由系统自动发出，无需电脑在线）'));
          secMail.appendChild(cbRow);
          const fHost = mkField('SMTP 服务器', cfg.host, 'smtp.163.com');
          const fPort = mkField('端口', String(cfg.port), '465（SSL）');
          const fUser = mkField('发件邮箱', cfg.user, 'you@163.com');
          const fPass = mkField('SMTP 授权码', '', cfg.hasPass ? '已保存（留空=不修改）' : '邮箱设置里开启SMTP后生成的授权码', 'password');
          const fTo = mkField('收件邮箱（多个用逗号分隔）', cfg.to, 'a@163.com, b@163.com');
          // 每天发送时间：滑块选择（半小时一档：00:00–23:30），比手输直观
          const timeRow = el('div', 'io-mail-row');
          timeRow.appendChild(el('span', 'io-mail-label', '每天发送时间'));
          const timeVal = el('span', 'io-mail-time-val', cfg.dailyTime || '20:00');
          const toMin = (s) => { const m = String(s || '20:00').match(/^(\d{1,2}):(\d{2})$/); return m ? Number(m[1]) * 2 + (Number(m[2]) >= 30 ? 1 : 0) : 40; };
          const fromMin = (v) => String(Math.floor(v / 2)).padStart(2, '0') + ':' + (v % 2 ? '30' : '00');
          const slider = el('input', 'io-mail-slider');
          slider.type = 'range';
          slider.min = '0';
          slider.max = '47';
          slider.step = '1';
          slider.value = String(toMin(cfg.dailyTime));
          slider.oninput = () => { timeVal.textContent = fromMin(Number(slider.value)); };
          timeRow.appendChild(slider);
          timeRow.appendChild(timeVal);
          secMail.appendChild(timeRow);
          // 邮件主题/正文模板：{date}=年月日（主题必含）{time}=时分 {count}=附件数 {serials}=序列号列表
          const fSubject = mkField('邮件主题（含 {date}）', cfg.subject || '[报价系统] 出入库备份 {date}', '[报价系统] 出入库备份 {date}');
          const bodyRow = el('div', 'io-mail-row');
          bodyRow.appendChild(el('span', 'io-mail-label', '邮件正文'));
          const fBody = document.createElement('textarea');
          fBody.className = 'edit-input io-mail-body';
          fBody.rows = 4;
          fBody.value = cfg.body || '出入库整本 Excel 自动备份（原格式，居中排版）。\n生成时间：{date} {time}\n序列号：{serials}\n附件共 {count} 个。';
          bodyRow.appendChild(fBody);
          secMail.appendChild(bodyRow);
          secMail.appendChild(el('div', 'modal-hint', '主题/正文可用占位符：{date}=年月日、{time}=时分、{count}=附件个数、{serials}=序列号列表。主题里若漏写 {date}，保存时会自动补到末尾（备份邮件必须能看出是哪天的）。'));
          const mkMailBtn = (text, primary, onclick) => {
            const b = el('button', (primary ? 'primary ' : '') + 'io-mail-btn', text);
            b.onclick = onclick;
            return b;
          };
          const collectCfg = () => ({
            action: 'mail-set',
            enabled: cbEn.checked,
            host: fHost.value.trim(),
            port: Number(fPort.value.trim()) || 465,
            user: fUser.value.trim(),
            pass: fPass.value,
            to: fTo.value.trim(),
            dailyTime: fromMin(Number(slider.value)),
            subject: fSubject.value.trim(),
            body: fBody.value,
          });
          const bSave = mkMailBtn('💾 保存配置', true, async () => {
            try {
              await api('POST', '/api/io-item', collectCfg());
              alert('已保存');
            } catch (e) { alert(e.message); }
          });
          const bTest = mkMailBtn('✉️ 发送测试邮件', false, async () => {
            bTest.disabled = true;
            try {
              await api('POST', '/api/io-item', collectCfg());
              const r = await api('POST', '/api/io-item', { action: 'mail-send', mode: 'test' });
              alert(r.message || '测试邮件已发送');
            } catch (e) { alert(e.message); }
            bTest.disabled = false;
          });
          const bNow = mkMailBtn('📤 立即备份全部', false, async () => {
            bNow.disabled = true;
            statusNow.textContent = '生成并发送中…（大工作簿约需十几秒）';
            try {
              await api('POST', '/api/io-item', collectCfg());
              const r = await api('POST', '/api/io-item', { action: 'mail-send' });
              statusNow.textContent = '✅ ' + (r.message || '已发送');
            } catch (e) { statusNow.textContent = '❌ ' + e.message; }
            bNow.disabled = false;
          });
          const btnRow = el('div', 'modal-actions io-mail-actions');
          btnRow.appendChild(bSave);
          btnRow.appendChild(bTest);
          btnRow.appendChild(bNow);
          secMail.appendChild(btnRow);
          const statusNow = el('div', 'modal-hint', '');
          secMail.appendChild(statusNow);
          secMail.appendChild(el('div', 'modal-hint', '163/126 邮箱：登录网页版邮箱 → 设置 → POP3/SMTP/IMAP → 开启服务并生成「授权码」，把授权码填在上面（不是邮箱登录密码）。收件邮箱可填多个。'));
        } catch (e) {
          secMail.innerHTML = '';
          secMail.appendChild(el('div', 'modal-hint', '邮件备份配置加载失败：' + e.message + '（需先部署最新 scf-deploy.zip）'));
        }
      })();
    }
  }

  function showPage(p) {
    $('#chat-page').classList.toggle('hidden', p !== 'chat');
    $('#price-page').classList.toggle('hidden', p !== 'price');
    $('#stock-page').classList.toggle('hidden', p !== 'stock');
    $('#recv-page').classList.toggle('hidden', p !== 'recv');
    $('#inv-page').classList.toggle('hidden', p !== 'inv');
    $('#fav-page').classList.toggle('hidden', p !== 'fav');
    $('#apps-page').classList.toggle('hidden', p !== 'apps');
    $('#dispatch-page').classList.toggle('hidden', p !== 'dispatch');
    $('#perf-page').classList.toggle('hidden', p !== 'perf');
    $('#todo-page').classList.toggle('hidden', p !== 'todo');
    $('#pay-page').classList.toggle('hidden', p !== 'pay');
    $('#io-page').classList.toggle('hidden', p !== 'io');
    $('#btn-prices').classList.toggle('active', p === 'price');
    $('#btn-stock').classList.toggle('active', p === 'stock');
    $('#btn-recv').classList.toggle('active', p === 'recv');
    $('#btn-inv').classList.toggle('active', p === 'inv');
    $('#btn-fav').classList.toggle('active', p === 'fav');
    $('#btn-apps').classList.toggle('active', p === 'apps');
    $('#btn-dispatch').classList.toggle('active', p === 'dispatch');
    $('#btn-perf').classList.toggle('active', p === 'perf');
    $('#btn-todo').classList.toggle('active', p === 'todo');
    $('#btn-pay').classList.toggle('active', p === 'pay');
    $('#btn-io').classList.toggle('active', p === 'io');
    if (p === 'price') loadPriceData();
    if (p === 'stock') loadStock();
    if (p === 'recv') loadRecv();
    if (p === 'inv') loadInv();
    if (p === 'fav') loadFav();
    if (p === 'apps') loadApps();
    if (p === 'dispatch') loadDispatch();
    if (p === 'perf') loadPerf();
    if (p === 'todo') loadTodos();
    if (p === 'pay') loadPayments();
    if (p === 'io') loadIo();
  }

  // ---------- 业绩报表（admin 导入「经营分析」表；业务员只看自己的行；月到款考核含提成与季度加和） ----------
  let perfData = null;
  let perfTab = 'perf'; // 'perf' = 月业绩统计 | 'pay' = 月到款考核

  async function loadPerf() {
    const box = $('#perf-content');
    if (perfData) { renderPerfPage(); refreshPerf(); return; } // 缓存秒开 + 后台静默刷新
    box.innerHTML = '';
    box.appendChild(el('div', 'modal-hint', '加载中…'));
    try {
      perfData = await api('GET', '/api/perf');
      renderPerfPage();
    } catch (e) {
      box.innerHTML = '';
      box.appendChild(el('div', 'modal-hint', '加载失败：' + e.message));
    }
  }

  function refreshPerf() {
    api('GET', '/api/perf').then((d) => { perfData = d; renderPerfPage(); }).catch(() => {});
  }

  function perfNum(s) { const n = Number(String(s || '').replace(/,/g, '')); return Number.isFinite(n) ? n : 0; }
  function perfComm(profitNum) { return (profitNum * 0.9 - 30000) * 0.3; } // 提成 =（毛利×0.9−30000）×0.3
  function fmtPerf(n) { return Number.isFinite(n) ? n.toLocaleString('zh-CN', { maximumFractionDigits: 2 }) : String(n); }
  // 向上百位取整：401→500，2399→2400
  function ceil100(n) { return Math.ceil(n / 100) * 100; }

  function renderPerfPage() {
    const box = $('#perf-content');
    const info = $('#perf-info');
    info.innerHTML = '';
    info.appendChild(el('span', 'stock-import-time', perfTab === 'perf' ? '月业绩统计（数量/金额/成本/毛利/毛利率）' : '月到款考核（含提成 =（毛利×0.9−30000）×0.3；季度加和行向上百位取整）'));
    const d = perfData || { items: [], canAdmin: false };
    const bar = el('div', 'stock-toolbar');
    const mkTab = (key, label) => {
      const b = el('button', 'price-tab' + (perfTab === key ? ' active' : ''), label);
      b.onclick = () => { perfTab = key; renderPerfPage(); refreshPerf(); }; // 切换页签时后台刷新，避免刚导入的数据看不到
      bar.appendChild(b);
    };
    mkTab('perf', '月业绩统计');
    mkTab('pay', '月到款考核');
    if (d.canAdmin) {
      const bImp = el('button', 'primary', perfTab === 'perf' ? '⇪ 导入业绩' : '⇪ 导入到款');
      bImp.onclick = () => openPerfImportModal(perfTab);
      bar.appendChild(bImp);
    }
    box.innerHTML = '';
    box.appendChild(bar);
    const type = perfTab;
    const list = (d.items || []).filter((x) => x.type === type);
    if (!list.length) {
      box.appendChild(el('div', 'modal-hint', perfTab === 'perf' ? '还没有月业绩记录（由管理员导入）' : '还没有月到款记录（由管理员导入）'));
      return;
    }
    list.forEach((im) => {
      box.appendChild(renderPerfBlock(im, d.canAdmin));
      if (type === 'pay' && Number(im.month) % 3 === 0) box.appendChild(renderQuarterBlock(im, d.canAdmin)); // 季度末月后面跟独立季度统计块
    });
  }

  // 季度统计块：独立黄色表格，格式与月度完全相同（业务员|数量|金额|成本|毛利|毛利率|提成）。
  // 每行=一个业务员在该季度的加和（同年月多次导入全部累加）；毛利率=毛利加和÷金额加和×100 重新计算；
  // 提成=该人三个月月提成相加后向上百位取整，负数写 0（月度表不受影响，仍允许负数）。
  // admin 额外有一行「季度总计」（毛利加和+提成加和）；非 admin 只看到自己的行，无总计行。
  function renderQuarterBlock(im, canAdmin) {
    const qEnd = Number(im.month);
    const qStart = qEnd - 2;
    const all = ((perfData && perfData.items) || []).filter((x) => x.type === 'pay' && Number(x.year) === Number(im.year) && Number(x.month) >= qStart && Number(x.month) <= qEnd);
    // 按业务员聚合
    const agg = {};
    const monthProfit = {}; // 全体按月毛利（供校验/备用）
    all.forEach((x) => {
      monthProfit[x.month] = (monthProfit[x.month] || 0) + (x.rows || []).reduce((s, r) => s + perfNum(r.profit), 0);
      (x.rows || []).forEach((r) => {
        if (!agg[r.sales]) agg[r.sales] = { qty: 0, amount: 0, cost: 0, profit: 0 };
        agg[r.sales].qty += perfNum(r.qty);
        agg[r.sales].amount += perfNum(r.amount);
        agg[r.sales].cost += perfNum(r.cost);
        agg[r.sales].profit += perfNum(r.profit);
      });
    });
    const names = Object.keys(agg).sort((a, b) => a.localeCompare(b, 'zh'));
    const wrap = el('div', 'perf-block perf-quarter-block');
    const head = el('div', 'perf-block-head');
    head.appendChild(el('span', 'perf-block-title', im.year + ' 年第 ' + (qEnd / 3) + ' 季度统计（' + qStart + '-' + qEnd + ' 月）'));
    wrap.appendChild(head);
    const tbl = el('table', 'stock-table perf-table perf-quarter-table');
    const trh = el('tr');
    ['业务员', '数量', '金额', '成本', '毛利', '毛利率', '提成'].forEach((h) => trh.appendChild(el('th', '', h)));
    const thead = el('thead');
    thead.appendChild(trh);
    tbl.appendChild(thead);
    const tbody = el('tbody');
    let totalProfit = 0;
    let totalComm = 0;
    names.forEach((n) => {
      const a = agg[n];
      const rate = a.amount !== 0 ? (a.profit / a.amount) * 100 : 0;
      // 该人季度提成：逐月计算月提成（月毛利=该人在该月的加和）相加，再向上百位取整；负数写 0。
      // 该月完全没有导入过 → 不参与加和（不算 0 毛利的负提成）；该月导入过但此人无行 → 按月毛利 0 算
      let personComm = 0;
      for (let m = qStart; m <= qEnd; m++) {
        if (monthProfit[m] === undefined) continue;
        const mp = all.filter((x) => Number(x.month) === m).reduce((s, x) => s + (x.rows || []).filter((r) => r.sales === n).reduce((t, r) => t + perfNum(r.profit), 0), 0);
        personComm += perfComm(mp);
      }
      const comm = Math.max(0, ceil100(personComm));
      totalProfit += a.profit;
      totalComm += comm;
      const tr = el('tr');
      const mk = (text) => { const td = el('td'); td.textContent = text; tr.appendChild(td); };
      mk(n);
      mk(fmtQty(a.qty));
      mk(fmtPerf(a.amount));
      mk(fmtPerf(a.cost));
      mk(fmtPerf(a.profit));
      mk(rate.toFixed(2));
      mk(fmtPerf(comm));
      tbody.appendChild(tr);
    });
    if (canAdmin) {
      const grandComm = ceil100(Object.keys(monthProfit).reduce((s, m) => s + perfComm(monthProfit[m]), 0));
      const tr = el('tr', 'perf-quarter-total');
      const tdL = el('td'); tdL.colSpan = 4; tdL.textContent = '季度总计'; tr.appendChild(tdL);
      const tdP = el('td', 'num'); tdP.textContent = fmtPerf(totalProfit); tr.appendChild(tdP);
      tr.appendChild(el('td'));
      const tdC = el('td', 'num'); tdC.textContent = fmtPerf(Math.max(0, grandComm)); tdC.title = '季度提成总计（三个月提成加和向上百位取整，负数为 0）'; tr.appendChild(tdC);
      tbody.appendChild(tr);
    }
    tbl.appendChild(tbody);
    wrap.appendChild(tbl);
    if (!names.length) wrap.appendChild(el('div', 'modal-hint', '该季度还没有可统计的数据'));
    return wrap;
  }

  function renderPerfBlock(im, canAdmin) {
    const wrap = el('div', 'perf-block');
    const head = el('div', 'perf-block-head');
    head.appendChild(el('span', 'perf-block-title', im.year + ' 年 ' + im.month + ' 月'));
    if (canAdmin) {
      const bDel = el('button', 'fav-del', '🗑 删除本次导入');
      bDel.title = '删除后所有人都不再看到这批数据';
      bDel.onclick = async () => {
        if (!confirm('删除「' + im.year + ' 年 ' + im.month + ' 月」这次导入？删除后所有人都不再看到这批数据。')) return;
        try {
          await api('POST', '/api/perf-item', { action: 'delete', id: im.id });
          refreshPerf();
        } catch (e) { alert(e.message); }
      };
      head.appendChild(bDel);
    }
    wrap.appendChild(head);
    const isPay = perfTab === 'pay';
    const tbl = el('table', 'stock-table perf-table');
    const trh = el('tr');
    (isPay ? ['业务员', '数量', '金额', '成本', '毛利', '毛利率', '提成'] : ['业务员', '数量', '金额', '成本', '毛利', '毛利率']).forEach((h) => trh.appendChild(el('th', '', h)));
    const thead = el('thead');
    thead.appendChild(trh);
    tbl.appendChild(thead);
    const tbody = el('tbody');
    // 人名按字母序（拼音）排序——两栏与季度表用同一排序，保证每个表顺序一致
    [...(im.rows || [])].sort((a, b) => String(a.sales).localeCompare(String(b.sales), 'zh')).forEach((r) => {
      const tr = el('tr');
      const mk = (text) => { const td = el('td'); td.textContent = text; tr.appendChild(td); };
      mk(r.sales);
      mk(fmtQty(r.qty));
      mk(fmtPerf(perfNum(r.amount)));
      mk(fmtPerf(perfNum(r.cost)));
      mk(fmtPerf(perfNum(r.profit)));
      mk(r.rate || '');
      if (isPay) mk(fmtPerf(perfNum(perfComm(perfNum(r.profit)))));
      tbody.appendChild(tr);
    });
    // 月统计行（每月表格底部）：数量/金额/成本/毛利 加和；毛利率=毛利加和÷金额加和×100 重算；
    // 到款考核的提成=各行提成相加（不取整）；月业绩统计包含王海强/财务专用账号（剔除名单仅作用于到款考核）
    const rowsAll = im.rows || [];
    if (rowsAll.length) {
      const s = rowsAll.reduce((acc, r) => {
        acc.qty += perfNum(r.qty);
        acc.amount += perfNum(r.amount);
        acc.cost += perfNum(r.cost);
        acc.profit += perfNum(r.profit);
        return acc;
      }, { qty: 0, amount: 0, cost: 0, profit: 0 });
      const rate = s.amount !== 0 ? (s.profit / s.amount) * 100 : 0;
      const tr = el('tr', 'perf-month-total');
      const mk = (text) => { const td = el('td'); td.textContent = text; tr.appendChild(td); };
      mk('月统计');
      mk(fmtQty(s.qty));
      mk(fmtPerf(s.amount));
      mk(fmtPerf(s.cost));
      mk(fmtPerf(s.profit));
      mk(rate.toFixed(2));
      if (isPay) mk(fmtPerf(rowsAll.reduce((t, r) => t + perfComm(perfNum(r.profit)), 0)));
      tbody.appendChild(tr);
    }
    tbl.appendChild(tbody);
    wrap.appendChild(tbl);
    return wrap;
  }

  function openPerfImportModal(type) {
    openModal(type === 'perf' ? '导入月业绩' : '导入月到款');
    const body = $('#modal-body');
    body.appendChild(el('div', 'modal-hint', '选择「经营分析」格式的 Excel（表头：序 业务员 数量 金额 合计金额 成本 毛利 毛利率）。合计金额列不使用；末行合计自动跳过。'));
    const grid = el('div', 'recv-edit-grid');
    body.appendChild(grid);
    const mkField = (labelText, input, wide) => {
      const w = el('label', 'rf-field' + (wide ? ' rf-wide' : ''));
      w.appendChild(el('span', 'rf-label', labelText));
      w.appendChild(input);
      grid.appendChild(w);
      return input;
    };
    const iYear = mkField('年', (() => { const i = el('input'); i.placeholder = '2026'; i.inputMode = 'numeric'; return i; })());
    const iMonth = mkField('月', (() => { const i = el('input'); i.placeholder = '11'; i.inputMode = 'numeric'; return i; })());
    const fi = mkField('Excel 文件', (() => { const i = el('input'); i.type = 'file'; i.accept = '.xls,.xlsx'; return i; })(), true);
    const bOk = el('button', 'primary', '导入');
    bOk.onclick = async () => {
      const f = fi.files && fi.files[0];
      const year = iYear.value.trim();
      const month = iMonth.value.trim();
      if (!/^\d{4}$/.test(year)) { alert('年份须为 4 位数字，如 2026'); return; }
      if (!/^\d{1,2}$/.test(month) || Number(month) < 1 || Number(month) > 12) { alert('月份须为 1-12'); return; }
      if (!f) { alert('请选择 Excel 文件'); return; }
      bOk.disabled = true;
      try {
        const b64 = await new Promise((resolve, reject) => {
          const r = new FileReader();
          r.onload = () => resolve(String(r.result).split(',')[1] || '');
          r.onerror = () => reject(new Error('读取文件失败'));
          r.readAsDataURL(f);
        });
        await api('POST', '/api/perf-item', { action: 'import', type, year, month, dataBase64: b64 });
        closeModal();
        perfData = null;
        loadPerf();
      } catch (e) { alert(e.message); }
      finally { bOk.disabled = false; }
    };
    const foot = el('div', 'form-row');
    foot.appendChild(bOk);
    body.appendChild(foot);
  }

  // ---------- 无库存产品统计（所有人可见同库存表；修改=admin+设置授权用户；批量改后一次性保存） ----------
  let noStockData = null;

  // 无库存数据预取：进入系统即后台拉取，点开弹窗直接秒显；弹窗开着时后台刷新不覆盖编辑状态
  function prefetchNoStock() {
    api('GET', '/api/nostock').then((d) => { if (!noStockBatch) noStockData = d; }).catch(() => {});
  }

  async function openNoStockModal() {
    openModal('无库存产品统计', true);
    const body = $('#modal-body');
    if (noStockData) { // 有预取缓存：先秒显，再后台刷新（SWR）
      noStockQuery = ''; // 每次打开重置搜索
      renderNoStockBody();
      api('GET', '/api/nostock').then((d) => {
        if (noStockBatch) return; // 正在批量编辑时不覆盖
        noStockData = d;
        const mb = $('#modal-body');
        if (mb && mb.querySelector('.nostock-table')) renderNoStockBody(); // 弹窗仍开着才重渲染
      }).catch(() => {});
      return;
    }
    body.appendChild(el('div', 'modal-hint', '加载中…'));
    noStockQuery = ''; // 每次打开重置搜索
    try {
      noStockData = await api('GET', '/api/nostock');
    } catch (e) {
      body.innerHTML = '';
      body.appendChild(el('div', 'modal-hint', '加载失败：' + e.message));
      return;
    }
    renderNoStockBody();
  }

  let noStockBatch = false; // 无库存批量修改模式：平时打开为查看，点「批量修改」才进入编辑（同库存表）
  let noStockQuery = ''; // 无库存查看模式搜索关键词（仅查看态过滤展示；批量编辑态不搜索，避免漏存被过滤的行）

  function renderNoStockBody() {
    const body = $('#modal-body');
    body.innerHTML = '';
    const d = noStockData || { items: [], canEdit: false };
    const rows = (d.items || []).map((r) => ({ ...r }));
    const editing = d.canEdit && noStockBatch;
    const tbl = el('table', 'stock-table nostock-table' + (editing ? ' ns-edit-table' : ''));
    const trh = el('tr');
    // 编辑模式也保持 5 列原格结构：拖动把手/删除按钮悬浮在行两侧（不占列、不挤压原格子）
    ['名称', '市场价1', '市场价2', '市场价3', '定价'].forEach((h) => trh.appendChild(el('th', '', h)));
    const thead = el('thead');
    thead.appendChild(trh);
    tbl.appendChild(thead);
    const tbody = el('tbody');
    if (editing) {
      // 批量修改模式（同库存表）：直接改/增/删行，最后「保存全部」一次性生效
      const bar = el('div', 'stock-toolbar sticky');
      const bSave = el('button', 'primary', '💾 保存全部');
      bSave.onclick = async () => {
        bSave.disabled = true;
        try {
          await api('POST', '/api/nostock-item', { action: 'batch', rows });
          noStockBatch = false;
          noStockData = null; // 重新拉取，回到查看模式
          openNoStockModal();
        } catch (e) { alert(e.message); }
        finally { bSave.disabled = false; }
      };
      const bCancel = el('button', '', '取消');
      bCancel.onclick = () => { noStockBatch = false; renderNoStockBody(); };
      bar.appendChild(bSave);
      bar.appendChild(bCancel);
      body.appendChild(bar);
      body.appendChild(el('div', 'modal-hint', '批量修改：直接在原来的格子里改；⠿ 把手（行左端）按住拖动调顺序，🗑（行右端）删除行；最后点「保存全部」一次性生效；所有列均可留空。'));
      const persist = () => { noStockData = { ...d, items: rows }; }; // 增/删行重渲染前先写回，否则改动丢失
      let dragTr = null; // 拖动排序（与设置/收藏夹同款原生拖拽：按住 ⠿ 才整行可拖，dragover 实时让位；数据只挪顺序，保存统一在「保存全部」）
      rows.forEach((r) => {
        const tr = el('tr', 'ns-edit-row'); // 行相对定位：把手/删除按钮悬浮在两侧
        tr._nsRow = r;
        const tdDrag = el('td', 'ns-side'); // 悬浮左端（不占列）
        const grip = el('span', 'drag-ns', '⠿');
        grip.title = '按住拖动调整顺序（保存全部后生效）';
        grip.addEventListener('mousedown', () => { tr.draggable = true; }); // 只有按住把手才允许拖整行，不影响输入框选字
        tr.addEventListener('dragstart', (e) => {
          dragTr = tr;
          tr.classList.add('dragging');
          if (e.dataTransfer) { e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', 'ns'); } catch (err) { /* 忽略 */ } }
        });
        tr.addEventListener('dragover', (e) => {
          e.preventDefault();
          if (!dragTr || dragTr === tr) return;
          const rect = tr.getBoundingClientRect();
          const before = (e.clientY - rect.top) < rect.height / 2; // 上半=插到前面，下半=插到后面（实时让位）
          tbody.insertBefore(dragTr, before ? tr : tr.nextSibling);
        });
        tr.addEventListener('drop', (e) => { e.preventDefault(); });
        tr.addEventListener('dragend', () => {
          tr.classList.remove('dragging');
          tr.draggable = false;
          if (dragTr) {
            const trs = [...tbody.children].filter((x) => x._nsRow); // 按当前 DOM 顺序重排 rows（保存统一在「保存全部」）
            const reordered = trs.map((x) => x._nsRow);
            rows.length = 0;
            rows.push(...reordered);
          }
          dragTr = null;
        });
        tdDrag.appendChild(grip);
        tr.appendChild(tdDrag);
        ['name', 'mp1', 'mp2', 'mp3', 'price'].forEach((k) => {
          const td = el('td');
          const inp = stockCellInput(r[k] || '', () => { r[k] = inp.value; }); // 写行对象本身：拖动换位后依旧正确
          td.appendChild(inp);
          tr.appendChild(td);
        });
        const tdDel = el('td', 'ns-side-r'); // 悬浮右端（不占列）
        const bDel = el('button', 'fav-del ns-del-btn', '🗑');
        bDel.title = '删除该行（保存全部后生效）';
        bDel.onclick = () => { const i2 = rows.indexOf(r); if (i2 >= 0) rows.splice(i2, 1); persist(); renderNoStockBody(); };
        tdDel.appendChild(bDel);
        tr.appendChild(tdDel);
        tbody.appendChild(tr);
      });
      const trAdd = el('tr');
      const tdAdd = el('td');
      tdAdd.colSpan = 5;
      const bAdd = el('button', 'primary', '＋ 新增一行');
      bAdd.onclick = () => { rows.push({ name: '', mp1: '', mp2: '', mp3: '', price: '' }); persist(); renderNoStockBody(); };
      tdAdd.appendChild(bAdd);
      trAdd.appendChild(tdAdd);
      tbody.appendChild(trAdd);
      tbl.appendChild(tbody);
      body.appendChild(tbl);
      return;
    }
    // 查看模式（默认）：有权限的人显示「批量修改」入口；右上角搜索实时过滤（只重绘 tbody，输入焦点不丢）
    if (d.canEdit) {
      const bar = el('div', 'stock-toolbar');
      const bEdit = el('button', 'primary', '✏️ 批量修改');
      bEdit.onclick = () => { noStockQuery = ''; noStockBatch = true; renderNoStockBody(); };
      bar.appendChild(bEdit);
      body.appendChild(bar);
      body.appendChild(el('div', 'modal-hint', '查看模式：点「批量修改」进入编辑（批量新增/修改，一次保存全部生效）。'));
    } else {
      body.appendChild(el('div', 'modal-hint', '只读查看（修改权限由管理员在设置中指定）。'));
    }
    const searchRow = el('div', 'ns-search-row');
    const sInp = el('input', 'ns-search');
    sInp.type = 'text';
    sInp.placeholder = '🔍 搜索名称/价格…';
    sInp.value = noStockQuery || '';
    searchRow.appendChild(sInp);
    body.appendChild(searchRow);
    const nsCount = el('div', 'modal-hint', '');
    body.appendChild(nsCount);
    const renderNsRows = () => {
      const f = (noStockQuery || '').trim().toLowerCase();
      const list = f ? rows.filter((r) => ['name', 'mp1', 'mp2', 'mp3', 'price'].some((k) => String(r[k] || '').toLowerCase().includes(f))) : rows;
      tbody.innerHTML = '';
      list.forEach((r) => {
        const tr = el('tr');
        [r.name, r.mp1, r.mp2, r.mp3, r.price].forEach((v) => { const td = el('td'); td.textContent = v || ''; tr.appendChild(td); });
        tbody.appendChild(tr);
      });
      if (!list.length) {
        const tr0 = el('tr');
        const td0 = el('td');
        td0.colSpan = 5;
        td0.style.textAlign = 'center';
        td0.style.color = '#98a3b3';
        td0.textContent = f ? '无匹配产品' : '（暂无数据，点「批量修改」新增）';
        tr0.appendChild(td0);
        tbody.appendChild(tr0);
      }
      nsCount.textContent = f ? ('匹配 ' + list.length + ' / ' + rows.length + ' 条') : ('共 ' + rows.length + ' 条');
    };
    sInp.oninput = () => { noStockQuery = sInp.value; renderNsRows(); };
    renderNsRows();
    tbl.appendChild(tbody);
    body.appendChild(tbl);
    if (!rows.length) body.appendChild(el('div', 'modal-hint', '暂无数据'));
  }

  // ---------- 代办事项（每人自己的数据；完成后进历史，按完成时间倒序） ----------
  let todoData = null;
  let todoView = 'active'; // 待办视图：active=今日待办 / done=完成归档（刷新后保持所在标签）

  async function loadTodos() {
    const box = $('#todo-content');
    if (todoData) { renderTodoPage(); refreshTodos(); return; }
    box.innerHTML = '';
    box.appendChild(el('div', 'modal-hint', '加载中…'));
    try {
      todoData = await api('GET', '/api/todos');
      renderTodoPage();
    } catch (e) {
      box.innerHTML = '';
      box.appendChild(el('div', 'modal-hint', '加载失败：' + e.message));
    }
  }

  function refreshTodos() {
    api('GET', '/api/todos').then((d) => { todoData = d; renderTodoPage(); }).catch(() => {});
  }

  // 新版待办（参考独立设计稿融合）：卡片式输入栏 + 今日待办/完成归档两个标签 + 圆形对勾 + ⋮⋮ 拖动排序（云端保存）+ 删除
  function renderTodoPage() {
    const box = $('#todo-content');
    const info = $('#todo-info');
    info.innerHTML = '';
    info.appendChild(el('span', 'stock-import-time', '代办事项（个人数据，每人各自维护）'));
    const d = todoData || { items: [] };
    const all = d.items || [];
    const active = all.filter((t) => !t.done); // 数组顺序 = 云端保存的顺序（拖动后即用户顺序）
    const done = all.filter((t) => t.done).sort((a, b) => b.doneAt - a.doneAt);
    box.innerHTML = '';

    // 输入栏：输入 + 添加（回车同效）
    const composer = el('div', 'todo-composer');
    const inp = el('input');
    inp.maxLength = 500;
    inp.placeholder = '添加一件待办…';
    const bAdd = el('button', 'todo-add-btn', '＋ 添加');
    const add = async () => {
      const text = inp.value.trim();
      if (!text) { inp.focus(); return; }
      try {
        await api('POST', '/api/todo-item', { action: 'add', text });
        inp.value = '';
        todoView = 'active';
        refreshTodos();
      } catch (e) { alert(e.message); }
    };
    bAdd.onclick = add;
    inp.onkeydown = (e) => { if (e.key === 'Enter') add(); };
    composer.appendChild(inp);
    composer.appendChild(bAdd);
    box.appendChild(composer);

    // 列表卡片：工具栏（计数 + 标签页）+ 列表 + 页脚
    const card = el('div', 'todo-card');
    const toolbar = el('div', 'todo-toolbar');
    const count = el('span', 'todo-count', '');
    const tabA = el('button', 'todo-filter', '今日待办');
    const tabD = el('button', 'todo-filter', '完成归档');
    toolbar.appendChild(count);
    toolbar.appendChild(tabA);
    toolbar.appendChild(tabD);
    card.appendChild(toolbar);
    const listEl = el('div', 'todo-list');
    card.appendChild(listEl);
    const foot = el('div', 'todo-foot');
    const fSum = el('span', '', '');
    const fHint = el('span', '', '');
    foot.appendChild(fSum);
    foot.appendChild(fHint);
    card.appendChild(foot);
    box.appendChild(card);

    const renderList = () => {
      tabA.classList.toggle('active', todoView === 'active');
      tabD.classList.toggle('active', todoView === 'done');
      count.textContent = todoView === 'active' ? ('待完成 ' + active.length + ' 项') : ('已完成 ' + done.length + ' 项');
      fSum.textContent = todoView === 'active' ? (active.length ? '还有 ' + active.length + ' 项未完成' : '当前没有未完成任务 ✓') : ('共完成 ' + done.length + ' 项');
      fHint.textContent = todoView === 'active' ? '拖动 ⋮⋮ 排序 · 完成自动归档' : '按完成时间倒序 · 可删除记录';
      listEl.innerHTML = '';
      const rows = todoView === 'active' ? active : done;
      if (!rows.length) {
        listEl.appendChild(el('div', 'todo-empty', todoView === 'active' ? '还没有待办，添加一件开始吧。' : '还没有已完成的代办。'));
        return;
      }
      let dragRow = null;
      rows.forEach((t) => {
        const isDone = todoView === 'done';
        const row = el('div', 'todo-row' + (isDone ? ' done-row' : ''));
        row.dataset.id = t.id;
        if (!isDone) {
          // 拖动排序（同设置/收藏夹模式：按住 ⋮⋮ 才整行可拖，dragover 实时让位，dragend 统一提交云端）
          const handle = el('button', 'todo-handle', '⋮⋮');
          handle.title = '按住拖动调整顺序';
          handle.addEventListener('mousedown', () => { row.draggable = true; });
          row.addEventListener('dragstart', (e) => {
            dragRow = row;
            row.classList.add('dragging');
            if (e.dataTransfer) { e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', t.id); } catch (err) { /* 忽略 */ } }
          });
          row.addEventListener('dragover', (e) => {
            e.preventDefault();
            if (!dragRow || dragRow === row) return;
            const rect = row.getBoundingClientRect();
            const before = (e.clientY - rect.top) < rect.height / 2;
            listEl.insertBefore(dragRow, before ? row : row.nextSibling);
          });
          row.addEventListener('drop', (e) => { e.preventDefault(); });
          row.addEventListener('dragend', () => {
            row.classList.remove('dragging');
            row.draggable = false;
            if (dragRow) {
              const ids = [...listEl.querySelectorAll('.todo-row')].map((x) => x.dataset.id);
              dragRow = null;
              api('POST', '/api/todo-item', { action: 'reorder', ids }).then(() => refreshTodos()).catch(() => {});
            }
          });
          row.appendChild(handle);
        }
        const check = el('button', 'todo-check', isDone ? '✓' : '');
        check.title = isDone ? '标记为未完成' : '完成';
        check.onclick = () => {
          // 乐观更新：先改本地缓存立即重绘（点击即消失/出现，不等网络），后台同步云端，失败回滚
          const prevDone = t.done;
          const prevDoneAt = t.doneAt;
          t.done = !prevDone;
          t.doneAt = t.done ? Date.now() : 0;
          renderTodoPage();
          api('POST', '/api/todo-item', { action: 'done', id: t.id, value: t.done })
            .then(() => refreshTodos())
            .catch((e) => { t.done = prevDone; t.doneAt = prevDoneAt; renderTodoPage(); alert('保存失败：' + e.message); });
        };
        row.appendChild(check);
        const bodyDiv = el('div', 'todo-body');
        bodyDiv.appendChild(el('div', 'todo-text', t.text));
        if (isDone) bodyDiv.appendChild(el('div', 'todo-meta', '完成于 ' + new Date(t.doneAt).toLocaleString('zh-CN')));
        row.appendChild(bodyDiv);
        const del = el('button', 'todo-del', '×');
        del.title = '删除';
        del.onclick = () => {
          if (isDone && !confirm('确定删除这条完成记录吗？')) return;
          const idx = all.indexOf(t);
          if (idx >= 0) all.splice(idx, 1); // 乐观删除：先从本地移除立即重绘
          renderTodoPage();
          api('POST', '/api/todo-item', { action: 'delete', id: t.id })
            .then(() => refreshTodos())
            .catch((e) => { if (idx >= 0) all.splice(Math.min(idx, all.length), 0, t); renderTodoPage(); alert('删除失败：' + e.message); });
        };
        row.appendChild(del);
        listEl.appendChild(row);
      });
    };
    tabA.onclick = () => { todoView = 'active'; renderList(); };
    tabD.onclick = () => { todoView = 'done'; renderList(); };
    renderList();
  }

  // ---------- 出入库（出入库序列号 = 上传的 Excel 工作簿；每个工作表 = 一个分表；可见/可编辑按分表勾名单；行按时间正序，新行始终在最下方） ----------
  // 存储架构：/api/io 只给元数据；行数据走 /api/io-rows 按窗口懒加载（支持 28 万行级分表）；
  // 上传 = 浏览器解析（SheetJS）→ 3MB 分片 → upload-begin/chunk/commit（避开云函数 6MB 请求上限）；
  // 导出 = 整本还原上传时的 Excel 格式（相同分表名/相同列/相同行序，无系统附加列）。
  let ioData = null;
  let ioBookId = '';
  let ioSheetId = '';
  let ioWin = { sheetId: '', from: 0, total: 0, rows: [], loading: false, capReached: false, err: '' }; // 当前分表的行窗口（懒加载）
  let ioEdit = null; // 编辑模式：{ dirty: Map(绝对行号→values) }
  let ioSaving = null; // 保存中标记：{ sheetId, pending }（乐观保存：界面已回阅读态，云端提交进行中）

  // 行窗口持久缓存：已加载过的分表再次点开秒开，不再重新拉取（localStorage，超限淘汰最旧）
  const IO_CACHE_KEY = 'io-row-cache-v2';
  let ioRowCache = {};
  try { ioRowCache = JSON.parse(localStorage.getItem(IO_CACHE_KEY) || '{}') || {}; } catch (e) { ioRowCache = {}; }
  let ioCacheTimer = null;
  function saveIoCache() {
    clearTimeout(ioCacheTimer);
    ioCacheTimer = setTimeout(() => {
      try {
        // 总量超限（约 3MB）→ 按保存时间从旧到新丢弃
        let entries = Object.entries(ioRowCache).map(([k, v]) => [k, v.savedAt || 0]);
        const keysNewToOld = entries.sort((a, b) => b[1] - a[1]).map((e) => e[0]);
        const keep = {};
        for (const k of keysNewToOld) {
          keep[k] = ioRowCache[k];
          if (JSON.stringify(keep).length > 3 * 1024 * 1024) delete keep[k];
        }
        ioRowCache = keep;
        localStorage.setItem(IO_CACHE_KEY, JSON.stringify(ioRowCache));
      } catch (e) { /* 存不下就算了（隐私模式/超限），内存缓存仍在 */ }
    }, 300);
  }
  function cacheIoWindow() {
    if (!ioWin.sheetId || !ioWin.rows.length) return;
    ioRowCache[ioWin.sheetId] = { from: ioWin.from, total: ioWin.total, rows: ioWin.rows, savedAt: Date.now() };
    saveIoCache();
  }
  function dropIoCache(sheetId) {
    if (sheetId && ioRowCache[sheetId]) { delete ioRowCache[sheetId]; saveIoCache(); }
  }

  function ioCellStr(v) {
    if (v == null) return '';
    if (v instanceof Date) {
      const p = (n) => String(n).padStart(2, '0');
      // 只要年月日：Excel 单元格即使是日期时间类型，入库也统一存为 YYYY-MM-DD（不带时分秒）
      return v.getFullYear() + '-' + p(v.getMonth() + 1) + '-' + p(v.getDate());
    }
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) return '';
      return String(Math.round(v * 1000000) / 1000000); // 规整浮点尾差（26.00000000001 → 26）
    }
    return String(v).trim();
  }

  // 显示层去时间：旧数据/文本日期里带 "HH:MM" 的统一只显示年月日（保存编辑时会写回截断后的值）
  function ioTrimTime(str) {
    return String(str == null ? '' : str).replace(/\s+\d{1,2}:\d{2}(:\d{2})?\s*$/, '').trim();
  }

  function u8ToB64(u8) {
    let s = '';
    const CH = 0x8000;
    for (let i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, Math.min(u8.length, i + CH)));
    return btoa(s);
  }

  async function loadIo() {
    const box = $('#io-content');
    if (ioData) { renderIoPage(); refreshIo(); return; } // 缓存秒开 + 后台静默刷新
    box.innerHTML = '';
    box.appendChild(el('div', 'modal-hint', '加载中…'));
    try {
      ioData = await api('GET', '/api/io');
      renderIoPage();
    } catch (e) {
      box.innerHTML = '';
      const msg = /未知|不存在|404|Cannot/.test(e.message)
        ? '云端后端还没有出入库接口：需要把最新的 dist/scf-deploy.zip 上传部署到腾讯云函数后才能使用。'
        : ('加载失败：' + e.message);
      box.appendChild(el('div', 'modal-hint', msg));
    }
  }

  function refreshIo() {
    api('GET', '/api/io').then((d) => {
      ioData = d;
      // 元数据刷新后行窗口仍有效（行文件按 sheetId 寻址），只重绘外壳
      renderIoPage();
    }).catch(() => {});
  }

  async function loadIoRowsTail(sheet) {
    // 首次加载当前分表：优先用持久缓存秒开（缓存窗口的末尾=最新行数才有效），否则取末尾 800 行
    // 注意：缓存命中时【不能】在这里调 renderIoPage——外层 renderIoPage 调用帧还在继续，
    // 同步回调会让外层再渲染一遍，表格就会上下叠两份（v93 重复渲染 bug 根因）。
    // 缓存命中只更新 ioWin 并返回，由外层自然渲染。
    const cached = ioRowCache[sheet.id];
    const metaTotal = Number(sheet.rowCount);
    // 「只看自己」视图：元数据 rowCount 是全量行数不可信 → 必须先问服务端拿过滤后的 total
    const selfView = !!sheet.selfView;
    if (!selfView && cached && Array.isArray(cached.rows) && cached.rows.length && Number.isFinite(metaTotal) && cached.total === metaTotal && cached.from + cached.rows.length === cached.total) {
      ioWin = { sheetId: sheet.id, from: cached.from, total: cached.total, rows: cached.rows, loading: false, capReached: ioWin.capReached, err: '' };
      return 'cache';
    }
    try {
      let total;
      if (selfView) {
        const first = await api('POST', '/api/io-rows', { sheetId: sheet.id, from: 0, to: 1 });
        total = first.total; // 服务端按 备注=自己 过滤后的行数
      } else if (Number.isFinite(metaTotal)) total = metaTotal; // 元数据行数可信 → 少一次往返
      else { const first = await api('POST', '/api/io-rows', { sheetId: sheet.id, from: 0, to: 1 }); total = first.total; }
      const from = Math.max(0, total - 800);
      const res = await api('POST', '/api/io-rows', { sheetId: sheet.id, from, to: total });
      ioWin = { sheetId: sheet.id, from, total, rows: res.rows, loading: false, capReached: false, err: '' };
    } catch (e) {
      ioWin = { sheetId: sheet.id, from: 0, total: 0, rows: [], loading: false, capReached: true, err: e.message };
    }
    cacheIoWindow();
    renderIoPage(); // 异步路径：此时外层调用帧早已结束，安全
  }

  // 整本导出（原格式 + 居中排版 + 列宽自适应）：云端 exceljs 生成（结构仍与上传完全相同），前端只负责下载
  async function exportIoBook(book) {
    openModal('导出出入库（原格式）');
    const body = $('#modal-body');
    const status = el('div', 'modal-hint', '云端生成文件中…（大工作簿约需十几秒）');
    body.appendChild(status);
    try {
      const r = await api('POST', '/api/io-export', { bookId: book.id });
      const bin = atob(r.dataBase64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const blob = new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      const a = el('a');
      a.href = URL.createObjectURL(blob);
      a.download = r.filename || ('出入库_' + book.serial + '.xlsx');
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
      closeModal();
    } catch (e) { status.textContent = '导出失败：' + e.message; }
  }

  // 上传弹窗：浏览器解析工作簿 → 每个分表按 3MB 分片上传（begin → chunk×N → commit）
  // 序列号自动取文件名（去扩展名）：同名文件再次上传 = 更新对应分表（保留权限名单），无需手填
  function openIoUploadModal() {
    openModal('上传出入库工作簿');
    const body = $('#modal-body');
    body.appendChild(el('div', 'modal-hint', '工作簿里的每个工作表会成为一个分表（如：入库记录 / 出库记录 / 地址信息 / 物流单号 / 维修记录 / PN统计表）。序列号自动取文件名；同名文件再次上传 = 更新对应分表并保留权限名单，没上传到的分表不受影响。支持 .xlsx / .xls，大文件自动分片上传。'));
    const rowIn = el('div', 'modal-actions');
    const fileInp = el('input');
    fileInp.type = 'file';
    fileInp.accept = '.xlsx,.xls';
    rowIn.appendChild(fileInp);
    body.appendChild(rowIn);
    const status = el('div', 'modal-hint', '请选择 Excel 文件。');
    body.appendChild(status);
    const bGo = el('button', 'primary', '开始上传');
    const act = el('div', 'modal-actions');
    const bCancel = el('button', '', '取消');
    bCancel.onclick = closeModal;
    act.appendChild(bGo);
    act.appendChild(bCancel);
    body.appendChild(act);
    let busy = false;
    bGo.onclick = async () => {
      if (busy) return;
      const f = fileInp.files && fileInp.files[0];
      if (!f) { status.textContent = '请先选择 Excel 文件。'; return; }
      const XL = window.XLSX;
      if (!XL) { status.textContent = 'Excel 组件尚未加载完成，请稍后重试。'; return; }
      busy = true;
      bGo.disabled = true;
      try {
        status.textContent = '解析工作簿…（大文件需要几秒）';
        const ab = await f.arrayBuffer();
        const wb = XL.read(new Uint8Array(ab), { type: 'array', cellDates: true });
        const names = (wb.SheetNames || []).filter(Boolean);
        if (!names.length) throw new Error('Excel 中没有工作表');
        if (names.length > 60) throw new Error('工作表过多（最多 60 个分表）');
        const sheets = [];
        names.forEach((name) => {
          const ws = wb.Sheets[name];
          if (!ws) return;
          const grid = XL.utils.sheet_to_json(ws, { header: 1, defval: '', raw: true });
          // 表头 = 第一个有内容的行；其后为数据行（与系统解析规则一致）
          let header = null;
          let startIdx = -1;
          for (let i = 0; i < grid.length; i++) {
            const cells = (grid[i] || []).map(ioCellStr);
            if (cells.some((c) => c !== '')) { header = cells; startIdx = i + 1; break; }
          }
          if (!header) return;
          while (header.length && header[header.length - 1] === '') header.pop();
          if (!header.length) return;
          if (header.length > 60) header = header.slice(0, 60);
          const cols = header.length;
          const rows = [];
          for (let i = startIdx; i < grid.length; i++) {
            const raw = (grid[i] || []).map(ioCellStr);
            if (!raw.some((c) => c !== '')) continue;
            const v = [];
            for (let j = 0; j < cols; j++) v.push(raw[j] || '');
            rows.push(v);
          }
          if (rows.length > 500000) throw new Error('「' + name + '」超过 50 万行上限');
          sheets.push({ name: String(name).trim().slice(0, 60) || ('分表' + (sheets.length + 1)), columns: header, rows });
        });
        if (!sheets.length) throw new Error('Excel 中没有有效的工作表（每个分表的第一行需为表头）');
        const serial = f.name.replace(/\.[^.]+$/, '');
        let totalRows = 0;
        let replaced = false;
        const CH = 3 * 1024 * 1024; // 每片 3MB（base64 后约 4MB，避开云函数 6MB 请求上限）
        for (const s of sheets) {
          const json = JSON.stringify({ columns: s.columns, rows: s.rows });
          const bytes = new TextEncoder().encode(json);
          const chunks = Math.max(1, Math.ceil(bytes.length / CH));
          const b1 = await api('POST', '/api/io-item', { action: 'upload-begin', serial, name: s.name, columns: s.columns, rowCount: s.rows.length, totalChunks: chunks });
          for (let i = 0; i < chunks; i++) {
            const slice = bytes.subarray(i * CH, Math.min(bytes.length, (i + 1) * CH));
            await api('POST', '/api/io-item', { action: 'upload-chunk', uploadId: b1.uploadId, idx: i, dataBase64: u8ToB64(slice) });
            status.textContent = '「' + s.name + '」上传中 ' + (i + 1) + ' / ' + chunks + ' 片（' + s.rows.length + ' 行）…';
          }
          const done = await api('POST', '/api/io-item', { action: 'upload-commit', uploadId: b1.uploadId });
          replaced = replaced || !!done.replaced;
          totalRows += done.rows || 0;
          status.textContent = '「' + s.name + '」完成：' + (done.rows || 0) + ' 行';
        }
        alert('已上传到「' + serial + '」：' + sheets.length + ' 个分表 / ' + totalRows + ' 行' + (replaced ? '（同名分表已更新，权限名单保留；未上传的分表不受影响）' : '（新建）'));
        closeModal();
        ioBookId = '';
        ioSheetId = '';
        ioWin = { sheetId: '', from: 0, total: 0, rows: [], loading: false, capReached: false, err: '' };
        refreshIo();
      } catch (e) {
        status.textContent = '上传失败：' + e.message;
        bGo.disabled = false;
      }
      busy = false;
    };
    setTimeout(() => fileInp.focus(), 0);
  }

  function renderIoPage() {
    const box = $('#io-content');
    const info = $('#io-info');
    info.innerHTML = '';
    info.appendChild(el('span', 'stock-import-time', '出入库 · 一个序列号对应一份 Excel 工作簿，其中每个工作表是一个分表；行按时间正序，新行始终在最下方'));
    const d = ioData || { books: [] };
    const books = d.books || [];
    box.innerHTML = '';
    if (!books.length && !d.canUpload) {
      const tip = el('div', 'modal-hint', '暂无可见的出入库分表（需要管理员在对应分表把你的账号勾进「可见」名单）。');
      tip.style.padding = '30px 12px';
      box.appendChild(tip);
      return;
    }
    const book = books.find((b) => b.id === ioBookId) || books[0] || null;
    ioBookId = book ? book.id : '';
    const sheet = book ? ((book.sheets || []).find((s) => s.id === ioSheetId) || (book.sheets || [])[0] || null) : null;
    ioSheetId = sheet ? sheet.id : '';

    // 工具栏（同业绩报表 月业绩/月到款 形式）：分表标签在工具栏一行内 + 序列号选择 + 上传（admin）+ 导出
    const editing = ioEdit && ioEdit.sheetId === sheet.id;
    const confirmLeaveEdit = () => {
      if (!ioEdit) return true;
      const tb = $('#io-content tbody');
      const newHas = tb ? Array.from(tb.querySelectorAll('tr.io-new-row')).some((tr) => {
        const v = tr._ioNewVals || [];
        return v.some((c, ci) => { const h = (sheet.columns || [])[ci] || ''; return !/序号|第.{0,4}个/.test(h) && String(c || '').trim() !== ''; });
      }) : false;
      if (!ioEdit.dirty.size && !newHas) { ioEdit = null; return true; }
      if (confirm('有未保存的修改，确定放弃并切换？')) { ioEdit = null; return true; }
      return false;
    };
    const bar = el('div', 'stock-toolbar');
    if (book) {
      (book.sheets || []).forEach((s) => {
        const t = el('button', 'price-tab' + (s.id === ioSheetId ? ' active' : ''), s.name);
        t.onclick = () => {
          if (s.id !== ioSheetId && !confirmLeaveEdit()) return;
          ioSheetId = s.id;
          ioWin = { sheetId: '', from: 0, total: 0, rows: [], loading: false, capReached: false, err: '' };
          renderIoPage();
        };
        bar.appendChild(t);
      });
    }
    if (books.length > 1) {
      const sel = el('select', 'edit-input');
      books.forEach((b) => {
        const op = el('option', '', b.serial + '（' + (b.sheets || []).length + ' 分表）');
        op.value = b.id;
        if (b.id === ioBookId) op.selected = true;
        sel.appendChild(op);
      });
      sel.onchange = () => {
        if (!confirmLeaveEdit()) { sel.value = ioBookId; return; }
        ioBookId = sel.value;
        ioSheetId = '';
        ioWin = { sheetId: '', from: 0, total: 0, rows: [], loading: false, capReached: false, err: '' };
        renderIoPage();
      };
      bar.appendChild(sel);
    }
    if (d.canUpload) {
      const bUp = el('button', 'primary', '📤 上传序列号表');
      bUp.onclick = () => openIoUploadModal();
      bar.appendChild(bUp);
    }
    if (book) {
      const bExp = el('button', '', '⬇️ 导出整本（原格式）');
      bExp.onclick = () => exportIoBook(book);
      bar.appendChild(bExp);
    }
    // 右上角「开始修改」：进入编辑模式 → 直接点单元格改、表格下方空白行直接填新行 → 保存统一提交
    if (book && sheet && sheet.canEdit) {
      if (ioSaving && ioSaving.sheetId === sheet.id) {
        bar.appendChild(el('span', 'io-saving', '💾 保存中…（' + ioSaving.pending + ' 行）'));
      } else if (!ioEdit || ioEdit.sheetId !== sheet.id) {
        const bEdit = el('button', 'io-edit-btn', '✏️ 开始修改');
        bEdit.onclick = () => { ioEdit = { sheetId: sheet.id, dirty: new Map() }; renderIoPage(); };
        bar.appendChild(bEdit);
      } else {
        const bSave = el('button', 'primary io-edit-btn', '💾 保存');
        bSave.onclick = () => saveIoEdits(sheet);
        const bCancel = el('button', '', '✖ 取消');
        bCancel.onclick = () => { ioEdit = null; renderIoPage(); };
        bar.appendChild(bSave);
        bar.appendChild(bCancel);
      }
    }
    box.appendChild(bar);

    if (!book) {
      box.appendChild(el('div', 'modal-hint', '还没有出入库序列号：点「📤 上传序列号表」导入第一份 Excel——工作簿里每个工作表会成为一个分表。'));
      return;
    }
    if (!sheet) {
      box.appendChild(el('div', 'modal-hint', '该序列号下暂无可见分表。'));
      return;
    }

    // 分表级操作（admin）：权限名单 + 删分表
    const subBar = el('div', 'stock-toolbar');
    if (d.isAdmin) {
      const bPerm = el('button', '', '👥 分表权限');
      bPerm.onclick = () => openIoPermModal(sheet);
      subBar.appendChild(bPerm);
      const bDelSheet = el('button', 'danger', '🗑 删分表');
      bDelSheet.onclick = async () => {
        if (!confirm('确定删除分表「' + sheet.name + '」吗？（不可恢复）')) return;
        try {
          await api('POST', '/api/io-item', { action: 'delete-sheet', sheetId: sheet.id });
          dropIoCache(sheet.id);
          ioSheetId = '';
          ioWin = { sheetId: '', from: 0, total: 0, rows: [], loading: false, capReached: false, err: '' };
          refreshIo();
        } catch (e) { alert(e.message); }
      };
      subBar.appendChild(bDelSheet);
      subBar.appendChild(el('span', 'stock-hint', '可见 / 可编辑名单按分表单独生效；admin 始终全权。'));
    }
    box.appendChild(subBar);

    // 行窗口：当前分表未加载 → 先取末尾 800 行（最新位置）
    if (ioWin.sheetId !== sheet.id && !ioWin.loading) {
      ioWin.loading = true;
      loadIoRowsTail(sheet).finally(() => { ioWin.loading = false; });
    }
    const windowReady = ioWin.sheetId === sheet.id;

    // 数据表：列 = 上传文件表头（与导出文件一致，无系统附加列）
    // 列宽：日期/时间列加宽到能放下完整日期，序号/SN 列收窄
    const colCls = (h) => (/日期|时间/.test(h) ? ' io-col-date' : (/序号|编号|(^|[^A-Za-z])SN/i.test(h) ? ' io-col-sn' : ''));
    const wrap = el('div', 'io-table-wrap');
    if (!windowReady) {
      wrap.appendChild(el('div', 'modal-hint', ioWin.err ? ('加载失败：' + ioWin.err) : '加载行数据中…'));
      box.appendChild(wrap);
      return;
    }
    const tbl = el('table', 'stock-table io-table');
    const trh = el('tr');
    const cols = sheet.columns || [];
    cols.forEach((h) => trh.appendChild(el('th', (colCls(String(h))).trim(), h)));
    const thead = el('thead');
    thead.appendChild(trh);
    tbl.appendChild(thead);
    const tbody = el('tbody');
    const editMarkDirty = (absIdx, ci, text) => {
      if (!ioEdit) return;
      const cur = ioEdit.dirty.get(absIdx);
      const base = cur || (ioWin.rows[absIdx - ioWin.from] ? ioWin.rows[absIdx - ioWin.from].v.slice() : []);
      base[ci] = text;
      ioEdit.dirty.set(absIdx, base);
    };
    // 编辑单元格：日期列点开原生日历；物流单号的「备注」列点开人名名单；其余直接可输入
    // afterEdit：空白行用——内容变更后的联动钩子（内容出现→自动生成日期；内容全清→自动清掉日期，行变回空行不会被提交）
    const editAttachCell = (td, h, ci, absIdx, rowVals, afterEdit) => {
      const hStr = String(h || '');
      const commit = () => {
        if (rowVals) rowVals[ci] = td.textContent.trim(); else editMarkDirty(absIdx, ci, td.textContent.trim());
        if (afterEdit) afterEdit();
      };
      if (/日期|时间/.test(hStr)) {
        td.classList.add('io-date-cell');
        td.onclick = () => ioPickDate(td, commit);
        return;
      }
      if (/物流单号/.test(String(sheet.name || '')) && hStr === '备注') {
        td.classList.add('io-name-cell');
        td.onclick = () => ioPickName(td, ioData.ioNameList || ioData.usernames || [], commit);
        return;
      }
      td.contentEditable = 'true';
      td.spellcheck = false;
      td.oninput = commit;
    };
    ioWin.rows.forEach((r, ri) => {
      const tr = el('tr');
      const absIdx = ioWin.from + ri;
      cols.forEach((h, ci) => {
        const td = el('td', (colCls(String(h))).trim());
        td.textContent = /日期|时间/.test(String(h || '')) ? ioTrimTime((r.v || [])[ci]) : ((r.v || [])[ci] == null ? '' : (r.v || [])[ci]);
        if (editing) editAttachCell(td, h, ci, absIdx, null);
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    // 编辑模式：底部空白行（初始 5 行；往下滚到底自动再补 10 行，可无限加；序号自动续号）
    // 编辑模式：底部空白行（初始 5 行；往下滚到底自动再补 10 行，可无限加；序号自动续号；
    // 填入 PN/SN 等内容后「日期」自动生成为当天——格式 YYYY-MM-DD，仍可点日历改；
    // 把该行内容全部清空（含备注）则日期也自动清掉，行变回空行、不会被提交）
    const dateCi = cols.findIndex((h) => /日期|时间/.test(String(h)));
    const p2 = (n) => String(n).padStart(2, '0');
    const todayStr = new Date().getFullYear() + '-' + p2(new Date().getMonth() + 1) + '-' + p2(new Date().getDate());
    const contentCis = cols.map((h, ci) => ({ h, ci })).filter((x) => !/序号|第.{0,4}个|日期|时间|合计|总数/.test(String(x.h || '')));
    const ioBuildBlankRow = (seqNo) => {
      const tr = el('tr', 'io-new-row');
      const rowVals = cols.map((h, ci) => (ci === seqIdx && seqNo != null ? String(seqNo) : ''));
      const tds = [];
      cols.forEach((h, ci) => {
        const td = el('td', (colCls(String(h))).trim());
        td.textContent = rowVals[ci];
        tds.push(td);
        editAttachCell(td, h, ci, -1, rowVals, () => {
          // 联动：内容列有内容 → 日期自动生成当天；内容列全空 → 日期自动清除（含备注被删掉的情况）
          if (dateCi < 0 || ci === dateCi) return;
          const hasAny = contentCis.some((x) => String(rowVals[x.ci] || '').trim() !== '');
          if (!hasAny) {
            if (String(rowVals[dateCi] || '').trim() !== '') { rowVals[dateCi] = ''; tds[dateCi].textContent = ''; }
          } else if (!String(rowVals[dateCi] || '').trim()) {
            rowVals[dateCi] = todayStr;
            tds[dateCi].textContent = todayStr;
          }
        });
        tr.appendChild(td);
      });
      tr._ioNewVals = rowVals;
      return tr;
    };
    let seqIdx = -1;
    let nextSeqNo = null;
    {
      const last = ioWin.rows.length ? ioWin.rows[ioWin.rows.length - 1] : { v: [] };
      seqIdx = cols.findIndex((h) => /序号|第.{0,4}个/.test(String(h)));
      const lastSeq = seqIdx >= 0 ? String((last.v || [])[seqIdx] == null ? '' : (last.v || [])[seqIdx]).trim() : '';
      if (/^\d+$/.test(lastSeq)) nextSeqNo = Number(lastSeq) + 1;
    }
    if (editing) {
      for (let n = 0; n < 5; n++) tbody.appendChild(ioBuildBlankRow(nextSeqNo != null ? nextSeqNo + n : null));
    }
    tbl.appendChild(tbody);
    wrap.appendChild(tbl);
    box.appendChild(wrap);
    const cnt = el('div', 'modal-hint', '共 ' + ioWin.total + ' 行，当前显示 ' + ioWin.rows.length + ' 行' + (ioWin.from > 0 ? '（上翻加载更早）' : '') + (sheet.selfView ? '　🔒 只看自己：仅显示备注为你（' + me.username + '）的行' : '')
      + (ioWin.capReached && ioWin.from > 0 ? '；已达页面显示上限，更早的行请用「导出整本（原格式）」查看' : '')
      + (editing ? '；编辑模式：点单元格直接改，最下面空白行直接填写新行，点右上角「💾 保存」统一提交' : ''));
    box.appendChild(cnt);
    wrap.scrollTop = wrap.scrollHeight; // 进入/保存/取消后视口都保持在最下端（最新位置），编辑模式不再跳到表格顶部

    // 编辑模式：滚到底自动补 10 行空白（可无限添加）；阅读模式：上翻加载更早的行
    wrap.onscroll = async () => {
      if (editing) {
        if (wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight < 80) {
          const tb = wrap.querySelector('tbody');
          if (tb) {
            let lastSeq = null;
            const allRows = tb.querySelectorAll('tr.io-new-row');
            if (allRows.length) {
              const v = allRows[allRows.length - 1]._ioNewVals || [];
              const sv = seqIdx >= 0 ? String(v[seqIdx] == null ? '' : v[seqIdx]).trim() : '';
              if (/^\d+$/.test(sv)) lastSeq = Number(sv) + 1;
            }
            for (let n = 0; n < 10; n++) tb.appendChild(ioBuildBlankRow(lastSeq != null ? lastSeq + n : null));
          }
        }
        return;
      }
      if (wrap.scrollTop > 80 || ioWin.loading || ioWin.capReached || ioWin.from <= 0 || ioWin.sheetId !== sheet.id) return;
      ioWin.loading = true;
      const want = Math.min(1000, ioWin.from);
      const prevH = wrap.scrollHeight;
      const prevTop = wrap.scrollTop;
      try {
        const res = await api('POST', '/api/io-rows', { sheetId: sheet.id, from: ioWin.from - want, to: ioWin.from });
        ioWin.rows = res.rows.concat(ioWin.rows);
        ioWin.from -= want;
        if (ioWin.rows.length >= 20000) ioWin.capReached = true;
        cacheIoWindow();
        renderIoPage();
        const nw = $('#io-content .io-table-wrap');
        if (nw) nw.scrollTop = nw.scrollHeight - prevH + prevTop; // 保持视口位置
      } catch (e) { /* 上翻失败静默，可继续翻 */ }
      ioWin.loading = false;
    };
  }

  // 日期格日历点选（原生日历；写回格式与该格原文一致：YYYY-MM-DD 或 YYYY/MM/D；含时分则带时间选择）
  function ioPickDate(td, onDone) {
    if (td.querySelector('input')) return;
    const cur = td.textContent.trim();
    const timeMatch = cur.match(/(\d{1,2}):(\d{2})/);
    const hasTime = !!timeMatch;
    const m = cur.match(/(\d{4})[-/年.](\d{1,2})[-/月.](\d{1,2})/);
    const inp = document.createElement('input');
    inp.type = (hasTime && m) ? 'datetime-local' : 'date';
    if (m) {
      const iso = m[1] + '-' + String(m[2]).padStart(2, '0') + '-' + String(m[3]).padStart(2, '0');
      inp.value = hasTime ? iso + 'T' + timeMatch[1].padStart(2, '0') + ':' + timeMatch[2] : iso;
    }
    inp.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;opacity:0;cursor:pointer;';
    td.style.position = 'relative';
    td.appendChild(inp);
    inp.focus();
    inp.onchange = () => {
      const v = inp.value || '';
      let out = '';
      if (v) {
        const tIdx = v.indexOf('T');
        const dPart = tIdx >= 0 ? v.slice(0, tIdx) : v;
        const tPart = tIdx >= 0 ? v.slice(tIdx + 1, tIdx + 6) : '';
        out = dPart;
        if (m && cur.indexOf('/') !== -1 && !/年|月/.test(cur)) out = out.replace(/-/g, '/'); // 沿用原文的斜杠格式
        if (tPart) out += ' ' + tPart;
      }
      td.textContent = out;
      inp.remove();
      onDone();
    };
    inp.onblur = () => { setTimeout(() => { if (inp.parentNode) inp.remove(); }, 200); };
  }

  // 「备注」人名选择（物流单号分表编辑模式）：名单由 admin 在设置里从注册账号勾选；可清除（清空后行可整行删空）
  function ioPickName(td, names, onDone) {
    document.querySelectorAll('.io-name-pop').forEach((p) => p.remove());
    const pop = el('div', 'io-name-pop');
    const pick = (name) => {
      td.textContent = name;
      pop.remove();
      document.removeEventListener('click', close);
      onDone();
    };
    const itClear = el('div', 'io-name-item io-name-clear', '🗑 清除');
    itClear.onclick = (e) => { e.stopPropagation(); pick(''); };
    pop.appendChild(itClear);
    (names || []).forEach((n) => {
      const it = el('div', 'io-name-item', n);
      it.onclick = (e) => { e.stopPropagation(); pick(n); };
      pop.appendChild(it);
    });
    if (!(names || []).length) pop.appendChild(el('div', 'io-name-item', '（名单为空：设置 → 功能权限管理 → 出入库权限）'));
    td.style.position = 'relative';
    td.appendChild(pop);
    const close = (e) => {
      if (!pop.contains(e.target)) { pop.remove(); document.removeEventListener('click', close); }
    };
    setTimeout(() => document.addEventListener('click', close), 0);
  }

  // 编辑模式保存（观感实时）：先本地落位并立即回阅读界面，云端提交放后台；失败自动回编辑模式且改动原样保留
  async function saveIoEdits(sheet) {
    if (!ioEdit || ioEdit.sheetId !== sheet.id) return;
    const tbody = $('#io-content tbody');
    const updates = Array.from(ioEdit.dirty.entries()).map(([idx, values]) => ({ idx, values }));
    const newRows = Array.from((tbody || { querySelectorAll: () => [] }).querySelectorAll('tr.io-new-row'))
      .map((tr) => (tr._ioNewVals || []).slice())
      .filter((vals) => vals.some((c, ci) => {
        const h = (sheet.columns || [])[ci] || '';
        if (/序号|第.{0,4}个/.test(h)) return false; // 纯空白行（仅自动序号）不提交
        return String(c || '').trim() !== '';
      }));
    if (!updates.length && !newRows.length) { ioEdit = null; renderIoPage(); return; }
    // 快照：失败时回滚窗口并带着原改动回到编辑模式
    const snapshot = {
      dirty: new Map(ioEdit.dirty),
      newRows: newRows.map((v) => v.slice()),
      rows: ioWin.rows.slice(),
      from: ioWin.from,
      total: ioWin.total,
    };
    // 乐观落位：已改行写回窗口；新行进窗口尾部
    snapshot.dirty.forEach((values, idx) => {
      const ri = idx - ioWin.from;
      if (ri >= 0 && ri < ioWin.rows.length) ioWin.rows[ri].v = values.slice();
    });
    newRows.forEach((v) => ioWin.rows.push({ v: v.slice(), at: Date.now(), by: me.username }));
    ioWin.total += newRows.length;
    ioEdit = null;
    ioSaving = { sheetId: sheet.id, pending: updates.length + newRows.length };
    cacheIoWindow();
    (ioData.books || []).forEach((b) => {
      const s = (b.sheets || []).find((x) => x.id === sheet.id);
      if (s) s.rowCount = ioWin.total;
    });
    renderIoPage(); // 立即回阅读界面
    try {
      if (updates.length) await api('POST', '/api/io-item', { action: 'update-rows', sheetId: sheet.id, updates });
      if (newRows.length) await api('POST', '/api/io-item', { action: 'append-rows', sheetId: sheet.id, rows: newRows });
      ioSaving = null;
      renderIoPage(); // 「保存中…」标记消失（行内容与云端一致，无需重拉）
    } catch (e) {
      ioSaving = null;
      ioWin.rows = snapshot.rows;
      ioWin.from = snapshot.from;
      ioWin.total = snapshot.total;
      (ioData.books || []).forEach((b) => {
        const s = (b.sheets || []).find((x) => x.id === sheet.id);
        if (s) s.rowCount = snapshot.total;
      });
      ioEdit = { sheetId: sheet.id, dirty: snapshot.dirty, newRows: [] };
      cacheIoWindow();
      renderIoPage();
      alert('保存失败：' + e.message + '\n已回到编辑模式，改动原样保留——可直接再点「💾 保存」重试。');
    }
  }

  // 分表权限弹窗（admin）：可编辑名单 + 可见名单（点保存统一提交）
  function openIoPermModal(sheet) {
    const isLogiSheet = /物流单号/.test(String(sheet.name || ''));
    openModal('分表权限 — ' + sheet.name);
    const body = $('#modal-body');
    body.appendChild(el('div', 'modal-hint', isLogiSheet
      ? '物流单号分表三档权限（互斥）：「可编辑」= 改行/追加并看全部；「可见」= 看全部行；「只看自己」= 只能看到备注是自己名字的行（导入的他人行不可见）。一个都不勾 = 该成员完全不可见。'
      : '勾选「可编辑」的成员可以修改/追加该分表；「可见」的成员能查看该分表（编辑者自动可见）。一个都不勾 = 仅 admin 可见可编辑。'));
    const names = ioData && ioData.usernames ? ioData.usernames.filter((u) => u !== me.username) : [];
    const edSel = new Set(sheet.editors || []);
    const vwSel = new Set(sheet.viewers || []);
    const svSel = new Set(isLogiSheet ? (sheet.selfViewers || []) : []);
    const grid = el('div', 'io-perm-grid');
    grid.appendChild(el('div', 'io-perm-head', '成员'));
    grid.appendChild(el('div', 'io-perm-head', '可编辑'));
    grid.appendChild(el('div', 'io-perm-head', '可见'));
    if (isLogiSheet) grid.appendChild(el('div', 'io-perm-head', '只看自己'));
    names.forEach((u) => {
      grid.appendChild(el('div', 'io-perm-name', u));
      const mkCb = () => {
        const d = el('div', 'io-perm-cb');
        const c = el('input');
        c.type = 'checkbox';
        d.appendChild(c);
        grid.appendChild(d);
        return c;
      };
      const cbE = mkCb();
      cbE.checked = edSel.has(u);
      const cbV = mkCb();
      cbV.checked = vwSel.has(u);
      const cbS = isLogiSheet ? mkCb() : null;
      if (cbS) cbS.checked = svSel.has(u);
      cbE.onchange = () => {
        if (cbE.checked) {
          edSel.add(u); vwSel.add(u); svSel.delete(u);
          cbV.checked = true;
          if (cbS) cbS.checked = false;
        } else edSel.delete(u);
      };
      cbV.onchange = () => {
        if (cbV.checked) {
          vwSel.add(u); svSel.delete(u);
          if (cbS) cbS.checked = false;
        } else {
          vwSel.delete(u);
          if (edSel.has(u)) { edSel.delete(u); cbE.checked = false; }
        }
      };
      if (cbS) cbS.onchange = () => {
        if (cbS.checked) {
          svSel.add(u); vwSel.delete(u);
          cbV.checked = false;
          if (edSel.has(u)) { edSel.delete(u); cbE.checked = false; }
        } else svSel.delete(u);
      };
    });
    body.appendChild(grid);
    const actBar = el('div', 'modal-actions');
    const bSave = el('button', 'primary', '保存');
    bSave.onclick = async () => {
      try {
        const payload = { action: 'setperm', sheetId: sheet.id, editors: [...edSel], viewers: [...vwSel] };
        if (isLogiSheet) payload.selfViewers = [...svSel];
        const r = await api('POST', '/api/io-item', payload);
        sheet.editors = r.editors;
        sheet.viewers = r.viewers;
        if (isLogiSheet) sheet.selfViewers = r.selfViewers || [];
        closeModal();
        renderIoPage();
      } catch (e) { alert(e.message); }
    };
    const bCancel = el('button', '', '取消');
    bCancel.onclick = closeModal;
    actBar.appendChild(bSave);
    actBar.appendChild(bCancel);
    body.appendChild(actBar);
  }

  // ---------- 款项统计（admin 维护；非 admin 只看经手人是自己的行） ----------
  let payData = null;
  let payBatch = false; // 款项统计批量修改模式：在页面里直接批量改（同库存表批量修改），不用弹窗
  let payEditRows = null; // 批量修改中的整行副本

  async function loadPayments() {
    const box = $('#pay-content');
    if (payData) { renderPayPage(); refreshPayments(); return; }
    box.innerHTML = '';
    box.appendChild(el('div', 'modal-hint', '加载中…'));
    try {
      payData = await api('GET', '/api/payments');
      renderPayPage();
    } catch (e) {
      box.innerHTML = '';
      box.appendChild(el('div', 'modal-hint', '加载失败：' + e.message));
    }
  }

  function refreshPayments() {
    api('GET', '/api/payments').then((d) => { payData = d; renderPayPage(); }).catch(() => {});
  }

  function renderPayPage() {
    const box = $('#pay-content');
    const info = $('#pay-info');
    info.innerHTML = '';
    info.appendChild(el('span', 'stock-import-time', '款项统计' + ((payData && payData.canAdmin) ? '（admin 可见全部，可修改）' : '（仅显示经手人是你的款项）')));
    const d = payData || { rows: [], canAdmin: false, users: [] };
    box.innerHTML = '';
    const payNum = (s) => { const n = Number(String(s || '').replace(/,/g, '')); return Number.isFinite(n) ? n : 0; };
    if (d.canAdmin && payBatch) {
      // 批量修改模式（界面内联，同库存表批量修改）：悬浮工具条 保存/取消
      const bar = el('div', 'stock-toolbar sticky');
      const bSave = el('button', 'primary', '💾 保存全部');
      bSave.onclick = async () => {
        bSave.disabled = true;
        try {
          const r = await api('POST', '/api/payment-item', { action: 'batch', rows: payEditRows });
          alert('已保存 ' + r.count + ' 行');
          payBatch = false;
          payEditRows = null;
          payData = null;
          loadPayments();
        } catch (e) { alert(e.message); }
        finally { bSave.disabled = false; }
      };
      const bCancel = el('button', '', '取消');
      bCancel.onclick = () => { payBatch = false; payEditRows = null; renderPayPage(); };
      bar.appendChild(bSave);
      bar.appendChild(bCancel);
      box.appendChild(bar);
      box.appendChild(el('div', 'modal-hint', '批量修改：经手人必须从系统已有人员中选择；日期必填（点格子用日历选）。改 / 增 / 删完后点「保存全部」一次性生效。'));
      const tbl = el('table', 'stock-table pay-table');
      const trh = el('tr');
      ['经手人', '日期', '公司', '金额', '备注', '删'].forEach((h) => trh.appendChild(el('th', '', h)));
      const thead = el('thead');
      thead.appendChild(trh);
      tbl.appendChild(thead);
      const tbody = el('tbody');
      payEditRows.forEach((r, i) => {
        const tr = el('tr');
        const tdU = el('td');
        const selU = el('select', 'edit-input pay-select');
        (d.users || []).forEach((u) => {
          const op = el('option', '', u);
          op.value = u;
          if (u === r.by) op.selected = true;
          selU.appendChild(op);
        });
        selU.onchange = () => { r.by = selU.value; };
        tdU.appendChild(selU);
        tr.appendChild(tdU);
        ['date', 'company', 'amount', 'note'].forEach((k) => {
          const td = el('td');
          const inp = stockCellInput(r[k] || '', () => { r[k] = inp.value; });
          if (k === 'date') { inp.type = 'date'; inp.style.width = '150px'; } // 日历选择
          td.appendChild(inp);
          tr.appendChild(td);
        });
        const tdDel = el('td');
        const bDel = el('button', 'fav-del', '🗑');
        bDel.onclick = () => { payEditRows.splice(i, 1); renderPayPage(); };
        tdDel.appendChild(bDel);
        tr.appendChild(tdDel);
        tbody.appendChild(tr);
      });
      tbl.appendChild(tbody);
      box.appendChild(tbl);
      const foot = el('div', 'form-row');
      const bAdd = el('button', 'primary', '＋ 新增一行');
      bAdd.onclick = () => { payEditRows.push({ by: (d.users || [])[0] || '', date: '', company: '', amount: '', note: '' }); renderPayPage(); };
      foot.appendChild(bAdd);
      box.appendChild(foot);
      return;
    }
    if (d.canAdmin) {
      const bar = el('div', 'stock-toolbar');
      const bEdit = el('button', 'primary', '✏️ 批量修改');
      bEdit.onclick = () => { payBatch = true; payEditRows = (d.rows || []).map((r) => ({ ...r })); renderPayPage(); };
      bar.appendChild(bEdit);
      box.appendChild(bar);
    }
    const rows = [...(d.rows || [])].sort((a, b) => (a.by === b.by
      ? (a.date === b.date ? 0 : (a.date > b.date ? 1 : -1))
      : String(a.by).localeCompare(String(b.by), 'zh'))); // 先按人名，人名内部按日期正序
    if (!rows.length) {
      box.appendChild(el('div', 'modal-hint', '还没有款项记录' + (d.canAdmin ? '，点上方「批量修改」新增' : '')));
      return;
    }
    const tbl = el('table', 'stock-table pay-table');
    const trh = el('tr');
    ['经手人', '日期', '公司', '金额', '备注'].forEach((h) => trh.appendChild(el('th', '', h)));
    const thead = el('thead');
    thead.appendChild(trh);
    tbl.appendChild(thead);
    const tbody = el('tbody');
    let curBy = null;
    let curSum = 0;
    const flushTotal = () => {
      if (curBy === null) return;
      const tr = el('tr', 'pay-total-row');
      const tdL = el('td'); tdL.colSpan = 3; tdL.textContent = '合计（' + curBy + '）'; tr.appendChild(tdL);
      const tdA = el('td', 'num'); tdA.textContent = fmtPerf(curSum); tr.appendChild(tdA);
      tr.appendChild(el('td'));
      tbody.appendChild(tr);
    };
    rows.forEach((r) => {
      if (r.by !== curBy) {
        flushTotal();
        curBy = r.by;
        curSum = 0;
      }
      curSum += payNum(r.amount);
      const tr = el('tr');
      [r.by, r.date, r.company, r.amount, r.note].forEach((v) => { const td = el('td'); td.textContent = v || ''; tr.appendChild(td); });
      tbody.appendChild(tr);
    });
    flushTotal();
    tbl.appendChild(tbody);
    box.appendChild(tbl);
  }

  // ---------- 外派预约申请（日期升序、过期自动废弃；客户名/地址按行可见名单；批准仅 admin） ----------
  let dispatchData = null;

  async function loadDispatch() {
    const box = $('#dispatch-content');
    if (dispatchData) { renderDispatchPage(); refreshDispatch(); return; } // 缓存秒开 + 后台静默刷新
    box.innerHTML = '';
    box.appendChild(el('div', 'modal-hint', '加载中…'));
    try {
      dispatchData = await api('GET', '/api/dispatch');
      renderDispatchPage();
    } catch (e) {
      box.innerHTML = '';
      box.appendChild(el('div', 'modal-hint', '加载失败：' + e.message));
    }
  }

  function refreshDispatch() {
    api('GET', '/api/dispatch').then((d) => { dispatchData = d; renderDispatchPage(); }).catch(() => {});
  }

  function dpApprText(v) { return v === true ? '✔ 是' : (v === false ? '✘ 否' : '— 未批'); }

  function renderDispatchPage() {
    const box = $('#dispatch-content');
    const info = $('#dispatch-info');
    info.innerHTML = '';
    const d = dispatchData || { items: [], me: '', canAdmin: false };
    const fmtDT = (t) => { try { return new Date(t).toLocaleString('zh-CN'); } catch (e) { return ''; } };
    info.appendChild(el('span', 'stock-import-time', '最近一次申请：' + (d.lastApply ? fmtDT(d.lastApply.at) + '（' + d.lastApply.by + '）' : '暂无')));
    info.appendChild(el('span', 'stock-import-time', '最近一次审批：' + (d.lastApprove ? fmtDT(d.lastApprove.at) + '（' + (d.lastApprove.by || 'admin') + '）' : '暂无')));
    const me = d.me || '';
    const bar = el('div', 'stock-toolbar');
    const bAdd = el('button', 'primary', '＋ 新增申请');
    bAdd.onclick = () => openDispatchFormModal(null);
    bar.appendChild(bAdd);
    if (d.canAdmin) {
      const bStats = el('button', 'primary', '📊 申请次数统计');
      bStats.onclick = openDispatchStatsModal;
      bar.appendChild(bStats);
      const nVis = (d.visList || []).length;
      const bVis = el('button', 'primary', '👥 客户/地址可见性：' + (nVis ? nVis + ' 人可见' : '所有人可见'));
      bVis.title = '统一设置所有外派申请「客户名称/详细地址」对哪些成员可见（名单外显示 *******）';
      bVis.onclick = () => openDispatchVisModal(bVis);
      bar.appendChild(bVis);
      const bHist = el('button', 'primary', '📜 全部历史记录');
      bHist.title = '查看所有外派申请（含已过期自动消失的），按日期从近到远；可删除单条';
      bHist.onclick = openDispatchHistoryModal;
      bar.appendChild(bHist);
    }
    box.innerHTML = '';
    box.appendChild(bar);
    const kw = (($('#dispatch-search') && $('#dispatch-search').value) || '').trim().toLowerCase();
    const items = (d.items || []).filter((it) => !kw
      || [it.date, it.by, it.clientName, it.address, it.matter, it.note].some((v) => String(v || '').toLowerCase().includes(kw)));
    if (!items.length) {
      box.appendChild(el('div', 'modal-hint', '当前没有待办的外派预约：点「＋ 新增申请」提交一个（已过期的申请会自动归档，不再显示）'));
      return;
    }
    const tbl = el('table', 'stock-table dispatch-table');
    const trh = el('tr');
    [['col-dp-date', '日期'], ['col-dp-by', '申请人'], ['col-dp-client', '客户名称'], ['col-dp-addr', '详细地址'], ['col-dp-matter', '事宜'], ['col-dp-note', '备注'], ['col-dp-appr', '批准']].forEach(([c, t]) => trh.appendChild(el('th', c, t)));
    trh.appendChild(el('th', 'col-dp-op', '操作'));
    const thead = el('thead');
    thead.appendChild(trh);
    tbl.appendChild(thead);
    const tbody = el('tbody');
    items.forEach((it) => {
      const tr = el('tr');
      const own = it.by === me; // 自己提交的：可修改/删除
      // 整行底色按批准状态：是=蓝底 / 否=红底 / 未批=无色（勾叉样式不变）
      if (it.approved === true) tr.classList.add('dp-row-yes');
      if (it.approved === false) tr.classList.add('dp-row-no');
      const mk = (cls, text, label) => {
        const td = el('td', cls);
        td.dataset.label = label;
        td.textContent = text;
        td.title = text;
        tr.appendChild(td);
        return td;
      };
      mk('col-dp-date-t', it.date, '日期');
      mk('col-dp-by-t', it.by, '申请人');
      mk('col-dp-client-t', it.clientName || '', '客户名称');
      mk('col-dp-addr-t', it.address || '', '详细地址');
      mk('col-dp-matter-t', it.matter || '', '事宜');
      mk('col-dp-note-t', it.note || '', '备注');
      const tdAppr = el('td', 'col-dp-appr-t');
      tdAppr.dataset.label = '批准';
      if (d.canAdmin) {
        // 与普通用户展示同风格：绿✔ / 红✘ / 灰—，点按钮即设置（当前状态高亮，重复点不提交）
        const btns = el('span', 'dp-appr-btns');
        const mk = (val, label, cls) => {
          const b = el('button', 'dp-appr-btn' + (it.approved === val ? ' ' + cls : ''), label);
          b.title = val === true ? '批准为是' : (val === false ? '批准为否' : '重置为未批');
          if (it.approved === val) b.disabled = true;
          b.onclick = async () => {
            try {
              await api('POST', '/api/dispatch-item', { action: 'approve', id: it.id, value: val });
              loadDispatch();
            } catch (e) { alert(e.message); loadDispatch(); }
          };
          return b;
        };
        btns.appendChild(mk(true, '✔', 'dp-yes-btn'));
        btns.appendChild(mk(false, '✘', 'dp-no-btn'));
        btns.appendChild(mk(null, '—', 'dp-null-btn'));
        tdAppr.appendChild(btns);
      } else {
        tdAppr.appendChild(el('span', 'dp-appr-text' + (it.approved === true ? ' dp-yes' : (it.approved === false ? ' dp-no' : '')), dpApprText(it.approved)));
      }
      tr.appendChild(tdAppr);
      const tdOp = el('td', 'col-dp-op');
      tdOp.dataset.label = '操作';
      if (own) {
        const bEdit = el('button', 'btn-edit', '✏ 修改');
        bEdit.title = '修改内容后批准状态将重置，需管理员重新批准';
        bEdit.onclick = () => openDispatchFormModal(it);
        tdOp.appendChild(bEdit);
      }
      if (own || d.canAdmin) {
        const bDel = el('button', 'fav-del', '🗑');
        bDel.title = own ? '删除自己的申请' : '管理员删除';
        bDel.onclick = async () => {
          if (!confirm('删除「' + it.by + '」在 ' + it.date + ' 的外派申请？')) return;
          try {
            await api('POST', '/api/dispatch-item', { action: 'delete', id: it.id });
            loadDispatch();
          } catch (e) { alert(e.message); }
        };
        tdOp.appendChild(bDel);
      }
      tr.appendChild(tdOp);
      tbody.appendChild(tr);
    });
    tbl.appendChild(tbody);
    box.appendChild(tbl);
  }

  function openDispatchFormModal(existing) {
    openModal(existing ? '修改外派申请' : '新增外派申请');
    const body = $('#modal-body');
    body.appendChild(el('div', 'modal-hint', existing
      ? '内容一旦修改，批准状态将重置为「未批」，需管理员重新批准。'
      : '申请人默认为当前账号；提交后由管理员批准。客户名称/详细地址默认所有人可见，管理员可在工具栏统一设置可见名单。'));
    const grid = el('div', 'recv-edit-grid');
    body.appendChild(grid);
    const mk = (labelText, input, wide) => {
      const w = el('label', 'rf-field' + (wide ? ' rf-wide' : ''));
      w.appendChild(el('span', 'rf-label', labelText));
      w.appendChild(input);
      grid.appendChild(w);
    };
    const inDate = el('input');
    inDate.type = 'date';
    inDate.min = dispatchData ? dispatchData.today : '';
    inDate.value = existing ? existing.date : '';
    mk('日期（点击日历选择）', inDate);
    const inBy = el('input');
    inBy.value = dispatchData ? dispatchData.me : '';
    inBy.disabled = true;
    mk('申请人', inBy);
    const inClient = el('input');
    inClient.placeholder = '客户名称';
    inClient.value = existing ? (existing.clientName || '') : '';
    mk('客户名称', inClient, true);
    const inAddr = el('input');
    inAddr.placeholder = '详细地址';
    inAddr.value = existing ? (existing.address || '') : '';
    mk('详细地址', inAddr, true);
    const inMatter = el('input');
    inMatter.placeholder = '事宜（如：设备巡检 / 方案讲解）';
    inMatter.value = existing ? (existing.matter || '') : '';
    mk('事宜', inMatter, true);
    const inNote = el('input');
    inNote.placeholder = '备注（可选）';
    inNote.value = existing ? (existing.note || '') : '';
    mk('备注', inNote, true);
    const foot = el('div', 'form-row');
    const bOk = el('button', 'primary', existing ? '保存修改' : '提交申请');
    const bCancel = el('button', '', '取消');
    bCancel.onclick = closeModal;
    foot.appendChild(bOk);
    foot.appendChild(bCancel);
    body.appendChild(foot);
    bOk.onclick = async () => {
      const payload = { date: inDate.value, clientName: inClient.value, address: inAddr.value, matter: inMatter.value, note: inNote.value };
      try {
        if (existing) await api('POST', '/api/dispatch-item', { action: 'update', id: existing.id, item: payload });
        else await api('POST', '/api/dispatch-item', { action: 'add', item: payload });
        closeModal();
        loadDispatch();
      } catch (e) { alert(e.message); }
    };
  }

  async function openDispatchVisModal(visBtn) {
    openModal('客户名称/详细地址可见性（全部申请统一生效）');
    const body = $('#modal-body');
    if (!favUsers) {
      body.appendChild(el('div', 'modal-hint', '加载成员列表中…'));
      try {
        const ur = await api('GET', '/api/users');
        favUsers = (ur.users || []).map((u) => ({ username: u.username, role: u.role }));
      } catch (err) { favUsers = []; }
      if ($('#modal-title').textContent.indexOf('可见性') === -1) return;
      body.innerHTML = '';
    }
    const cur = new Set((dispatchData && dispatchData.visList) || []);
    body.appendChild(el('div', 'modal-hint', '这里的名单对**所有**外派申请统一生效：名单内成员与管理员能看到「客户名称/详细地址」明文；名单外成员这两列显示 *******。勾选「所有成员」= 全员可见。'));
    // 空名单 = 所有人可见 → 渲染成全员勾选，保证「所有人」与成员勾选框状态永远一致
    const sel = cur.size === 0 ? new Set((favUsers || []).map((u) => u.username)) : cur;
    const publicRow = el('label', 'fav-vis-item fav-vis-all');
    const cbAll = el('input');
    cbAll.type = 'checkbox';
    publicRow.appendChild(cbAll);
    publicRow.appendChild(el('span', '', '所有成员（勾选=全员可见，取消=全员不可见）'));
    body.appendChild(publicRow);
    const members = (favUsers || []).filter((u) => u.username !== me.username);
    members.forEach((u) => {
      const lab = el('label', 'fav-vis-item');
      const cb = el('input');
      cb.type = 'checkbox';
      cb.checked = sel.has(u.username);
      cb.onchange = () => {
        if (cb.checked) sel.add(u.username); else sel.delete(u.username);
        cbAll.checked = members.length > 0 && members.every((x) => sel.has(x.username));
      };
      lab.appendChild(cb);
      lab.appendChild(el('span', '', u.username));
      body.appendChild(lab);
    });
    cbAll.checked = members.length > 0 && members.every((x) => sel.has(x.username));
    cbAll.onchange = () => {
      members.forEach((u) => { if (cbAll.checked) sel.add(u.username); else sel.delete(u.username); });
      members.forEach((u, i) => { body.querySelectorAll('.fav-vis-item input[type=checkbox]')[i + 1].checked = cbAll.checked; });
    };
    const foot = el('div', 'form-row');
    const bOk = el('button', 'primary', '保存');
    const bCancel = el('button', '', '取消');
    bCancel.onclick = closeModal;
    foot.appendChild(bOk);
    foot.appendChild(bCancel);
    body.appendChild(foot);
    bOk.onclick = async () => {
      try {
        const r = await api('POST', '/api/dispatch-item', { action: 'vis', value: cbAll.checked ? [] : members.filter((x) => sel.has(x.username)).map((x) => x.username) });
        const n = (r.value || []).length;
        if (visBtn) visBtn.textContent = '👥 客户/地址可见性：' + (n ? n + ' 人可见' : '所有人可见');
        closeModal();
        loadDispatch();
      } catch (e) { alert(e.message); }
    };
  }

  let dispatchHistory = null; // 历史记录缓存：预取后打开秒渲染

  async function refreshDispatchHistory() {
    // 后台静默刷新历史缓存；若历史弹窗正开着则同步重渲染
    try {
      dispatchHistory = await api('GET', '/api/dispatch-history');
      if (!$('#modal-mask').classList.contains('hidden') && ($('#modal-title').textContent || '').indexOf('历史') !== -1) {
        const body = $('#modal-body');
        body.innerHTML = '';
        renderDispatchHistoryBody(body);
      }
    } catch (e) { /* 静默 */ }
  }

  function renderDispatchHistoryBody(body) {
    const items = (dispatchHistory && dispatchHistory.items) || [];
    if (!items.length) { body.appendChild(el('div', 'modal-hint', '还没有任何外派申请记录')); return; }
    const tbl = el('table', 'stock-table dispatch-table history-table');
    const trh = el('tr');
    [['col-dp-date', '日期'], ['col-dp-by', '申请人'], ['col-dp-client', '客户名称'], ['col-dp-addr', '详细地址'], ['col-dp-matter', '事宜'], ['col-dp-note', '备注'], ['col-dp-appr', '批准'], ['col-dp-op', '操作']].forEach(([c, t]) => trh.appendChild(el('th', c, t)));
    const thead = el('thead');
    thead.appendChild(trh);
    tbl.appendChild(thead);
    const tbody = el('tbody');
    items.forEach((it) => {
      const tr = el('tr');
      if (it.approved === true) tr.classList.add('dp-row-yes');
      if (it.approved === false) tr.classList.add('dp-row-no');
      const mk = (cls, text, label) => { const td = el('td', cls); td.dataset.label = label; td.textContent = text; td.title = text; tr.appendChild(td); };
      mk('col-dp-date-t', it.date, '日期');
      mk('col-dp-by-t', it.by, '申请人');
      mk('col-dp-client-t', it.clientName || '', '客户名称');
      mk('col-dp-addr-t', it.address || '', '详细地址');
      mk('col-dp-matter-t', it.matter || '', '事宜');
      mk('col-dp-note-t', it.note || '', '备注');
      mk('col-dp-appr-t', dpApprText(it.approved), '批准');
      const tdOp = el('td', 'col-dp-op');
      tdOp.dataset.label = '操作';
      const bDel = el('button', 'fav-del', '🗑');
      bDel.title = '删除这条申请（含已过期的），删除后不可恢复';
      bDel.onclick = async () => {
        if (!confirm('删除「' + it.by + '」在 ' + it.date + ' 的外派申请？删除后不可恢复。')) return;
        try {
          await api('POST', '/api/dispatch-item', { action: 'delete', id: it.id });
          await refreshDispatchHistory(); // 重新拉取并重渲染本弹窗
          loadDispatch(); // 若删的是未过期条目，主列表同步
        } catch (e) { alert(e.message); }
      };
      tdOp.appendChild(bDel);
      tr.appendChild(tdOp);
      tbody.appendChild(tr);
    });
    tbl.appendChild(tbody);
    body.appendChild(tbl);
  }

  async function openDispatchHistoryModal() {
    openModal('全部外派历史记录（含已过期，倒序）', true);
    const body = $('#modal-body');
    body.appendChild(el('div', 'modal-hint', '所有外派申请的存档（含已过期从列表自动消失的），按日期从近到远排列；可删除单条。'));
    if (dispatchHistory) { renderDispatchHistoryBody(body); refreshDispatchHistory(); return; } // 预取缓存秒开
    body.appendChild(el('div', 'modal-hint', '加载中…'));
    try {
      dispatchHistory = await api('GET', '/api/dispatch-history');
    } catch (e) {
      body.innerHTML = '';
      body.appendChild(el('div', 'modal-hint', '加载失败：' + e.message));
      return;
    }
    body.innerHTML = '';
    body.appendChild(el('div', 'modal-hint', '所有外派申请的存档（含已过期从列表自动消失的），按日期从近到远排列；可删除单条。'));
    renderDispatchHistoryBody(body);
  }

  let dispatchStatsCache = null; // 统计缓存 { from, to, data }：预取后打开秒渲染

  function renderDispatchStatsTable(zone, r, from, to) {
    zone.innerHTML = '';
    const rangeTxt = (from || to) ? ('统计范围：' + (from || '最早') + ' ～ ' + (to || '至今')) : '统计范围：全部历史申请';
    zone.appendChild(el('div', 'modal-hint', rangeTxt + '（含已过期/已完成的申请）'));
    const users = (r && r.users) || [];
    if (!users.length) { zone.appendChild(el('div', 'modal-hint', '该时间范围内还没有任何外派申请记录')); return; }
    const tbl = el('table', 'stock-table stats-table');
    const trh = el('tr');
    trh.appendChild(el('th', 'col-stats-user', '成员'));
    trh.appendChild(el('th', '', '申请次数'));
    const thead = el('thead');
    thead.appendChild(trh);
    tbl.appendChild(thead);
    const tbody = el('tbody');
    users.forEach((u) => {
      const tr = el('tr');
      tr.appendChild(el('td', 'col-stats-user-t', u.user));
      tr.appendChild(el('td', 'num stats-total', String(u.count || 0)));
      tbody.appendChild(tr);
    });
    tbl.appendChild(tbody);
    zone.appendChild(tbl);
  }

  async function renderDispatchStatsContent(zone, from, to) {
    zone.innerHTML = '';
    zone.appendChild(el('div', 'modal-hint', '统计中…'));
    try {
      const r = await api('POST', '/api/dispatch-stats', { from: from || '', to: to || '' });
      dispatchStatsCache = { from: from || '', to: to || '', data: r };
      renderDispatchStatsTable(zone, r, from, to);
    } catch (e) {
      zone.innerHTML = '';
      zone.appendChild(el('div', 'modal-hint', '加载失败：' + e.message));
    }
  }

  function refreshDispatchStats(zone, from, to) {
    // 后台静默刷新统计缓存；仅当统计弹窗仍开着时重渲染
    api('POST', '/api/dispatch-stats', { from: from || '', to: to || '' }).then((r) => {
      dispatchStatsCache = { from: from || '', to: to || '', data: r };
      if (!$('#modal-mask').classList.contains('hidden') && ($('#modal-title').textContent || '').indexOf('统计') !== -1) {
        renderDispatchStatsTable(zone, r, from, to);
      }
    }).catch(() => {});
  }

  function openDispatchStatsModal() {
    openModal('外派申请次数统计');    const body = $('#modal-body');
    const rangeRow = el('div', 'stats-range');
    body.appendChild(rangeRow);
    const mkDate = (labelText, value) => {
      const w = el('label', 'rf-field stats-date');
      w.appendChild(el('span', 'rf-label', labelText));
      const i = el('input');
      i.type = 'date';
      if (value) i.value = value;
      w.appendChild(i);
      rangeRow.appendChild(w);
      return i;
    };
    const now = new Date();
    const monthFirst = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-01';
    const todayStr = now.toLocaleDateString('sv-SE'); // 本地时区 YYYY-MM-DD
    const inFrom = mkDate('从', monthFirst);
    const inTo = mkDate('到', todayStr);
    const zone = el('div');
    const bGo = el('button', 'btn-query', '查询');
    bGo.onclick = () => {
      if (inFrom.value && inTo.value && inFrom.value > inTo.value) { alert('起始日期不能晚于结束日期'); return; }
      renderDispatchStatsContent(zone, inFrom.value, inTo.value);
    };
    rangeRow.appendChild(bGo);
    body.appendChild(zone);
    if (dispatchStatsCache && dispatchStatsCache.from === inFrom.value && dispatchStatsCache.to === inTo.value) {
      renderDispatchStatsTable(zone, dispatchStatsCache.data, inFrom.value, inTo.value); // 预取缓存秒开
      refreshDispatchStats(zone, inFrom.value, inTo.value); // 后台静默刷新
    } else {
      renderDispatchStatsContent(zone, inFrom.value, inTo.value);
    }
  }

  let priceEdit = null; // 价格表改价进行中 {name, value}
  let priceBatch = null; // 批量编辑进行中 {edits: {原始名: {name, price}}}
  let priceTotalMode = false; // 当前显示「总表」而不是某个机型
  let priceTotal = []; // 总表条目（apiCatalog 返回）
  let dragMachineId = null; // 拖动排序中正在拖的机型 id

  async function loadPriceData() {
    const box = $('#price-content');
    if (priceData && priceData.length) { renderPricePage(); refreshPrice(); return; } // 缓存秒开 + 后台静默刷新
    box.innerHTML = '';
    box.appendChild(el('div', 'modal-hint', '加载中…'));
    try {
      const r = await api('GET', '/api/catalog');
      priceData = r.machines || [];
      priceTotal = r.totalSheet || [];
      pricePerms = { canEditPrice: !!r.canEditPrice, canEditMachine: !!r.canEditMachine, canEditTotal: !!r.canEditTotal, canChat: !!r.canChat }; // 功能权限表驱动
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

  function refreshPrice() {
    // 后台刷新：只更新数据重渲染；进行中的改价/批量编辑不被动覆盖（priceEdit/priceBatch 存在时跳过重渲染）
    api('GET', '/api/catalog').then((r) => {
      priceData = r.machines || [];
      priceTotal = r.totalSheet || [];
      pricePerms = { canEditPrice: !!r.canEditPrice, canEditMachine: !!r.canEditMachine, canEditTotal: !!r.canEditTotal, canChat: !!r.canChat };
      if (!priceTotalMode && !priceMachineId || !priceData.some((m) => m.id === priceMachineId)) {
        const priced = priceData.find((m) => m.priced);
        priceMachineId = priced ? priced.id : (priceData[0] && priceData[0].id);
      }
      if (!priceEdit && !priceBatch) renderPricePage();
    }).catch(() => {});
  }

  function renderPricePage() {
    const canMachine = !!(pricePerms && pricePerms.canEditMachine); // 机型管理 = 功能权限表
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
      if (m.priced || canMachine) {
        b.onclick = () => { priceMachineId = m.id; priceTotalMode = false; priceEdit = null; priceBatch = null; renderPricePage(); };
      }
      // 有机型管理权限的人可拖动页签调整机型顺序
      if (canMachine) {
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

    if (canMachine && !priceTotalMode && priceMachineId) {
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
    const canTotal = !!(pricePerms && pricePerms.canEditTotal); // 总表管理 = 功能权限表
    box.appendChild(el('div', 'price-banner admin',
      '总表 = 所有配件的唯一主数据：修改总表（价格/描述/名称/分类）会立即写穿到所有机型里的同名配件；删除总表配件时，所有机型里的同名配件一并删除。' +
      '机型页的「批量导入」可直接从总表选配件。'));

    if (canTotal) {
      const toolbar = el('div', 'price-toolbar');
      if (!priceBatch) {
        const addBtn = el('button', 'btn-edit ok', '+ 新增配件');
        addBtn.classList.add('desk-only'); // 手机端隐藏：新增配件是桌面管理操作
        addBtn.onclick = () => openItemModal(null, null, true);
        toolbar.appendChild(addBtn);
        toolbar.appendChild(document.createTextNode(' '));
        const batchBtn = el('button', 'btn-edit', '批量编辑');
        batchBtn.classList.add('desk-only'); // 手机端隐藏
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

    const cols = canTotal ? ['配件', '单价', '操作'] : ['配件', '单价'];
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

        if (canTotal) {
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
    const canPrice = !!(pricePerms && pricePerms.canEditPrice); // 价格表内容管理 = 功能权限表

    if (canPrice) {
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
  function openModal(title, wide) {
    $('#modal-title').textContent = title;
    $('#modal-body').innerHTML = '';
    $('#modal-box').classList.toggle('modal-wide', !!wide); // 账号管理等宽弹窗
    $('#modal-mask').classList.remove('hidden');
  }

  function closeModal() {
    $('#modal-mask').classList.add('hidden');
    $('#modal-body').innerHTML = '';
    $('#modal-box').classList.remove('modal-wide');
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
    openModal('账号管理', true); // 加宽弹窗：容纳岗位下拉 + 四个操作按钮 + 登录统计
    const body = $('#modal-body');

    const form = el('div', 'form-row');
    const inUser = el('input'); inUser.placeholder = '新账号（2-32位）';
    const inPass = el('input'); inPass.type = 'password'; inPass.placeholder = '初始密码（至少6位）';
    const btnAdd = el('button', '', '添加账号');
    form.appendChild(inUser); form.appendChild(inPass); form.appendChild(btnAdd);
    body.appendChild(form);
    const hint = el('div', 'modal-hint', '权限管理：请在「设置 → 功能权限管理」里按功能勾选每个账号的可用权限（管理员始终全部可用）。岗位名只是历史模板标签，不再决定权限。删除规则：admin 可以删除任何人（历史报价一并删除），唯独不能删除自己。');
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
            warn.title = '系统仅保留一个管理员：该账号始终拥有全部权限。如不再需要可直接删除。';
            row.appendChild(warn);
          }
          const tag = el('span', 'fav-vis-role', roleText(u.role)); // 历史模板标签（权限已改由功能权限表管理，岗位不再参与判断）
          row.appendChild(tag);
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
            imp.title = '以该账号的身份查看系统（网页版新标签页；桌面版当前窗口打开，可用左下角「退出模拟」返回）';
            imp.onclick = async () => {
              if (!confirm('以「' + u.username + '」的身份打开查看页面？')) return;
              try {
                const r2 = await api('POST', '/api/users-impersonate', { username: u.username });
                if (isTauriApp) { location.href = location.pathname + '?imp=' + encodeURIComponent(r2.token); } // 桌面单窗口：原地跳转
                else { window.open(location.pathname + '?imp=' + encodeURIComponent(r2.token), '_blank'); }
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
      const perr = pwdPolicyClientError(np);
      if (perr) { alert('新密码不合规：' + perr); return; }
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
    const inNew = el('input'); inNew.type = 'password'; inNew.placeholder = '新密码（≥10位，含大小写字母+数字+符号）';
    const inNew2 = el('input'); inNew2.type = 'password'; inNew2.placeholder = '再输一遍新密码';
    const btn = el('button', '', '确认修改');
    const row = el('div');
    [inOld, inNew, inNew2].forEach((x) => { x.style.marginBottom = '10px'; x.style.width = '100%'; x.style.padding = '9px 10px'; x.style.border = '1px solid #d9dce1'; x.style.borderRadius = '8px'; row.appendChild(x); });
    row.appendChild(btn);
    body.appendChild(row);
    btn.onclick = async () => {
      const perr = pwdPolicyClientError(inNew.value);
      if (perr) { alert(perr); return; }
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
  $('#login-form').onsubmit = (e) => { e.preventDefault(); doLogin(); };
  $('#login-pass-toggle').onclick = () => setLoginPasswordVisible($('#login-pass').type === 'password');
  $('#send').onclick = send;
  $('#new-chat').onclick = () => {
    // 在其他页面时第一次点击 = 回到上次报价的界面；已经在报价页再点一次才真正新建
    if ($('#chat-page').classList.contains('hidden')) { showPage('chat'); return; }
    newChat();
  };
  $('#btn-prices').onclick = () => showPage('price');
  $('#btn-stock').onclick = () => showPage('stock');
  $('#btn-recv').onclick = () => showPage('recv');
  $('#btn-inv').onclick = () => showPage('inv');
  $('#btn-fav').onclick = () => showPage('fav');
  $('#btn-apps').onclick = () => showPage('apps');
  $('#apps-search').oninput = () => renderAppsPage();
  $('#btn-dispatch').onclick = () => showPage('dispatch');
  $('#btn-perf').onclick = () => showPage('perf');
  $('#btn-todo').onclick = () => showPage('todo');
  $('#btn-pay').onclick = () => showPage('pay');
  $('#btn-io').onclick = () => showPage('io');
  $('#dispatch-search').oninput = () => renderDispatchPage();
  $('#btn-settings').onclick = () => openSettingsModal();
  $('#btn-exit-imp').onclick = () => {
    try { sessionStorage.removeItem('qa_imp_token'); } catch (e) {}
    location.reload(); // 回到本窗口自己的登录态（admin 的 token 一直在 localStorage，无需重新输密码）
  };
  $('#stock-search').oninput = () => renderStockPage();
  $('#inv-search').oninput = () => renderInvPage();
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

  // ---------- 手机适配（≤768px 生效；桌面端不受影响） ----------
  (function () {
    const mnav = $('#mobile-nav');
    const mmask = $('#mobile-mask');
    if (!mnav || !mmask) return;
    const closeDrawer = () => document.body.classList.remove('m-drawer-open');
    mnav.addEventListener('click', (e) => {
      const b = e.target.closest('.mnav-btn');
      if (!b) return;
      if (b.id === 'mnav-drawer') {
        document.body.classList.toggle('m-drawer-open');
        return;
      }
      const t = document.getElementById(b.dataset.target);
      if (t) { t.click(); closeDrawer(); }
    });
    mmask.addEventListener('click', closeDrawer);

    // 抽屉手势：抽屉打开时，在屏幕任意区域向左滑动即退出（上下滑动仍正常滚动）
    const sidebar = document.querySelector('.sidebar');
    let sx = 0, sy = 0, sdx = 0, dragging = false, horiz = null;
    const gestStart = (e) => {
      if (!document.body.classList.contains('m-drawer-open')) return;
      sx = e.touches[0].clientX; sy = e.touches[0].clientY;
      sdx = 0; horiz = null; dragging = true;
      sidebar.style.transition = 'none';
    };
    const gestMove = (e) => {
      if (!dragging) return;
      const dx = e.touches[0].clientX - sx;
      const dy = e.touches[0].clientY - sy;
      if (horiz === null && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) horiz = Math.abs(dx) > Math.abs(dy);
      if (horiz !== true) return; // 纵向手势让位给列表滚动
      if (dx < 0) {
        if (e.cancelable) e.preventDefault(); // 阻止浏览器把这个手势当滚动/后退处理
        sdx = dx;
        sidebar.style.transform = 'translateX(' + dx + 'px)';
      }
    };
    const gestEnd = () => {
      if (!dragging) return;
      dragging = false;
      sidebar.style.transition = '';
      sidebar.style.transform = '';
      if (sdx < -45) closeDrawer();
      sdx = 0;
    };
    // 全区域：直接挂在 document 上，抽屉/遮罩/内容区任意位置左滑都生效
    document.addEventListener('touchstart', gestStart, { passive: true });
    document.addEventListener('touchmove', gestMove, { passive: false });
    document.addEventListener('touchend', gestEnd);
    document.addEventListener('touchcancel', gestEnd);

    // 报价输入框：手机端去掉桌面快捷键提示字样
    const DESK_PH = '输入需求，Enter 发送 / Shift+Enter 换行\n';
    const applyMobilePh = () => {
      const i = $('#input');
      if (i) i.placeholder = (window.matchMedia && window.matchMedia('(max-width: 768px)').matches) ? '' : DESK_PH;
    };
    applyMobilePh();
    if (window.matchMedia) {
      try { window.matchMedia('(max-width: 768px)').addEventListener('change', applyMobilePh); } catch (e) { /* 老浏览器忽略 */ }
    }
  })();

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
