// chatgpt-queue：ChatGPT 网页版积压发送。
// 生成中按 Enter（或任何时候按 ⌥Enter）= 把输入框内容放进队列；
// 上一轮回复完整生成完、停稳 2 秒后，自动发队列里的下一条。
// 不用任何 chrome.* 接口，同一份代码也能直接注入页面跑。
(() => {
  if (window.__cgq) return;
  window.__cgq = true;

  const KEY = 'cgq-state';
  const IDLE_MS = 2000;      // 回复结束后要停稳多久才发下一条
  const TICK_MS = 500;

  // ---------- 状态（按标签页存 sessionStorage，刷新不丢） ----------
  const load = () => {
    try { return JSON.parse(sessionStorage.getItem(KEY)) || null; } catch { return null; }
  };
  let st = load() || { path: null, items: [], paused: false };
  const save = () => { sessionStorage.setItem(KEY, JSON.stringify(st)); render(); };
  // 新对话刚发第一条时地址是 /c/local-chatgpt:xxx，过一会儿才换成真 id，临时 id 不算
  const convKey = () => {
    const id = (decodeURIComponent(location.pathname).match(/\/c\/([^/]+)/) || [])[1] || null;
    return id && !id.startsWith('local') ? id : null;
  };

  // ---------- 页面元素 ----------
  const composer = () => document.querySelector('form .ProseMirror[contenteditable="true"]') ||
                         document.querySelector('#prompt-textarea');
  const form = () => composer()?.closest('form');
  const stopShown = () => {
    const f = form();
    if (!f) return false;
    if (f.querySelector('[data-testid="stop-button"]')) return true;
    return [...f.querySelectorAll('button')].some(b => /停止|stop/i.test(b.getAttribute('aria-label') || ''));
  };
  // 刚发出去、停止键还没出来的那一两秒也算「在生成」：
  // 实测这时再按 Enter，ChatGPT 会把前一条吞掉，只留后一条。
  let submitAt = 0;
  const markSubmit = () => { submitAt = Date.now(); };
  const isGenerating = () => {
    if (stopShown()) { submitAt = 0; return true; }
    return !!submitAt && Date.now() - submitAt < 8000;
  };
  const sendBtn = () => {
    const f = form();
    return f && (f.querySelector('[data-testid="send-button"]') ||
                 [...f.querySelectorAll('button[type=submit]')].find(b => /发送|send/i.test(b.getAttribute('aria-label') || '')) ||
                 f.querySelector('button[type=submit]'));
  };
  const composerText = () => (composer()?.innerText || '').replace(/\n+$/, '');
  const clearComposer = () => {
    const c = composer(); if (!c) return;
    c.focus(); document.execCommand('selectAll'); document.execCommand('delete');
  };
  const putComposer = (text) => {
    const c = composer(); if (!c) return;
    c.focus();
    const dt = new DataTransfer(); dt.setData('text/plain', text);
    c.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  };
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const waitFor = async (fn, ms) => { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return true; await sleep(100); } return false; };

  // ---------- 入队 ----------
  const enqueue = (text) => {
    text = text.trim(); if (!text) return false;
    if (!st.items.length) st.path = convKey();
    st.items.push({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), text });
    save(); toast(`已加入队列，第 ${st.items.length} 条`);
    return true;
  };
  const enqueueComposer = () => { if (enqueue(composerText())) clearComposer(); };

  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing || e.keyCode === 229) return;
    // 不跟 composer() 比是不是同一个节点：新对话换真 id 时 ChatGPT 会重建输入框，
    // 按键可能落在旧节点上（实测 ⌥Enter 漏过一次）
    if (!e.target.closest?.('form .ProseMirror, #prompt-textarea')) return;
    // ⌥Enter：无论什么状态都入队
    // Enter：正在生成，或队列里还有没发完的（没暂停），也入队，保证顺序
    const busy = isGenerating() || (st.items.length && !st.paused);
    if (!composerText().trim()) return;
    if (e.altKey || busy) {
      e.preventDefault(); e.stopImmediatePropagation();
      enqueueComposer();
    } else markSubmit();                    // 放行给 ChatGPT 正常发送
  }, true);
  document.addEventListener('click', (e) => {
    const b = e.target.closest?.('form button[type=submit]');
    if (b && !b.disabled && b === sendBtn() && composerText().trim()) markSubmit();
  }, true);

  // ---------- 自动发送 ----------
  let idleSince = 0, sending = false, mismatch = false;
  const tick = async () => {
    if (sending) return;
    const cur = convKey();
    if (st.items.length && !st.path && cur) { st.path = cur; save(); }
    mismatch = !!(st.items.length && st.path && cur !== st.path);
    if (isGenerating() || !composer()) { idleSince = 0; render(); return; }
    if (!idleSince) idleSince = Date.now();
    render();
    if (st.paused || !st.items.length || mismatch) return;
    if (Date.now() - idleSince < IDLE_MS) return;
    await sendNext();
  };

  const sendNext = async () => {
    sending = true;
    const item = st.items[0];
    const draft = composerText();           // 用户正在输入的草稿先收起来，发完放回去
    try {
      if (draft.trim()) clearComposer();
      putComposer(item.text);
      const ready = await waitFor(() => { const b = sendBtn(); return b && !b.disabled && composerText().trim(); }, 3000);
      if (!ready) throw new Error('发送按钮不可用');
      sendBtn().click(); markSubmit();
      const gone = await waitFor(() => !composerText().trim() || stopShown(), 6000);
      if (!gone) throw new Error('点了发送但没发出去');
      st.items = st.items.filter(x => x.id !== item.id);
      if (!st.path) st.path = convKey();
      save();
      await waitFor(stopShown, 15000);      // 等它开始生成，再进入下一轮判断
      await waitFor(() => convKey(), 5000);
      if (!st.path) { st.path = convKey(); save(); }
    } catch (err) {
      st.paused = true; save();
      if (composerText().trim() === item.text.trim()) clearComposer();
      toast(`${err.message}，队列已暂停`, 5000);
    } finally {
      if (draft.trim()) putComposer(draft);
      idleSince = 0; sending = false;
    }
  };

  // ---------- 面板 ----------
  const css = `
  #cgq{position:fixed;right:16px;bottom:96px;z-index:2147483000;width:320px;max-height:55vh;display:flex;flex-direction:column;
    font:13px/1.45 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;color:#1f1f1f;background:#fff;border:1px solid #e3e3e3;
    border-radius:12px;box-shadow:0 6px 24px rgba(0,0,0,.12);overflow:hidden}
  #cgq.min{width:auto}
  #cgq .hd{display:flex;align-items:center;gap:6px;padding:8px 10px;border-bottom:1px solid #eee;cursor:default;user-select:none}
  #cgq.min .hd{border-bottom:0}
  #cgq .ttl{font-weight:600;flex:1;white-space:nowrap}
  #cgq .st{font-size:12px;color:#888;white-space:nowrap}
  #cgq button{border:0;background:#f2f2f2;border-radius:6px;padding:2px 8px;font:inherit;cursor:pointer;color:inherit}
  #cgq button:hover{background:#e6e6e6}
  #cgq .list{overflow:auto;padding:6px}
  #cgq .it{display:flex;gap:6px;align-items:flex-start;padding:6px;border-radius:8px}
  #cgq .it:hover{background:#f7f7f7}
  #cgq .n{color:#999;min-width:16px;text-align:right}
  #cgq .tx{flex:1;white-space:pre-wrap;word-break:break-word;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
  #cgq .it.open .tx{display:block}
  #cgq .ops{display:flex;gap:2px;opacity:.35}
  #cgq .it:hover .ops{opacity:1}
  #cgq .ops button{padding:0 5px;background:transparent}
  #cgq textarea{flex:1;min-height:60px;font:inherit;border:1px solid #ccc;border-radius:6px;padding:4px;resize:vertical}
  #cgq .ft{display:flex;gap:6px;padding:6px 10px;border-top:1px solid #eee;align-items:center}
  #cgq .tip{flex:1;font-size:11px;color:#999}
  #cgq .warn{padding:6px 10px;background:#fff4e5;color:#8a5300;font-size:12px}
  #cgq-toast{position:fixed;left:50%;bottom:120px;transform:translateX(-50%);z-index:2147483001;background:#222;color:#fff;
    padding:6px 14px;border-radius:8px;font:13px -apple-system,"PingFang SC",sans-serif;opacity:0;transition:opacity .2s;pointer-events:none}
  @media (prefers-color-scheme: dark){
    #cgq{background:#2b2b2b;color:#eee;border-color:#444}
    #cgq .hd,#cgq .ft{border-color:#3a3a3a}
    #cgq button{background:#3a3a3a} #cgq button:hover{background:#474747}
    #cgq .it:hover{background:#333} #cgq textarea{background:#222;color:#eee;border-color:#555}
    #cgq .warn{background:#4a3410;color:#ffd89a}
  }`;
  const style = document.createElement('style'); style.textContent = css;
  document.documentElement.appendChild(style);

  let minimized = sessionStorage.getItem('cgq-min') === '1';
  let editing = null;
  const box = document.createElement('div'); box.id = 'cgq';
  const esc = (s) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function statusText() {
    if (mismatch) return '不在本对话';
    if (st.paused) return '已暂停';
    if (sending) return '发送中…';
    if (!st.items.length) return '空';
    if (isGenerating()) return '等回复完成';
    return '即将发送';
  }

  let lastHtml = '';
  function render() {
    if (!document.body) return;
    if (!box.isConnected) document.body.appendChild(box);
    if (editing) return;                       // 正在编辑时不重绘
    box.className = minimized ? 'min' : '';
    const n = st.items.length;
    let h = `<div class="hd"><span class="ttl">积压队列 ${n ? '· ' + n + ' 条' : ''}</span>
      <span class="st">${statusText()}</span>
      ${n ? `<button data-a="pause">${st.paused ? '▶ 继续' : '⏸ 暂停'}</button>` : ''}
      <button data-a="min" title="${minimized ? '展开' : '收起'}">${minimized ? '▴' : '▾'}</button></div>`;
    if (!minimized) {
      if (mismatch) h += `<div class="warn">这个队列是在另一个对话里攒的，当前对话不会自动发。
        <button data-a="adopt">改发到当前对话</button></div>`;
      h += `<div class="list">${n ? st.items.map((it, i) => `
        <div class="it" data-id="${it.id}"><span class="n">${i + 1}</span><span class="tx">${esc(it.text)}</span>
        <span class="ops"><button data-a="up" title="上移">↑</button><button data-a="edit" title="编辑">✎</button><button data-a="del" title="删除">✕</button></span></div>`).join('')
        : '<div class="tip" style="padding:6px">生成中按 Enter，或任何时候按 ⌥Enter，输入框内容就进队列；上一轮回复完了自动发下一条。</div>'}</div>
      <div class="ft"><span class="tip">⌥Enter 入队 · 生成中 Enter 也入队</span>
        <button data-a="add">＋ 输入框入队</button>${n ? '<button data-a="clear">清空</button>' : ''}</div>`;
    }
    if (h !== lastHtml) { box.innerHTML = h; lastHtml = h; }
  }

  box.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    const a = b.dataset.a, id = b.closest('.it')?.dataset.id;
    const idx = st.items.findIndex(x => x.id === id);
    if (a === 'pause') { st.paused = !st.paused; idleSince = 0; save(); }
    else if (a === 'min') { minimized = !minimized; sessionStorage.setItem('cgq-min', minimized ? '1' : '0'); render(); }
    else if (a === 'add') enqueueComposer();
    else if (a === 'clear') { if (confirm(`清空队列里的 ${st.items.length} 条？`)) { st.items = []; save(); } }
    else if (a === 'adopt') { st.path = convKey(); save(); }
    else if (a === 'del') { st.items.splice(idx, 1); save(); }
    else if (a === 'up' && idx > 0) { [st.items[idx - 1], st.items[idx]] = [st.items[idx], st.items[idx - 1]]; save(); }
    else if (a === 'edit') startEdit(idx);
  });
  box.addEventListener('dblclick', (e) => { const it = e.target.closest('.it'); if (it) it.classList.toggle('open'); });

  function startEdit(idx) {
    const it = st.items[idx]; if (!it) return;
    const row = box.querySelector(`.it[data-id="${it.id}"]`);
    editing = it.id;
    row.innerHTML = `<span class="n">${idx + 1}</span><textarea></textarea>
      <span class="ops" style="opacity:1;flex-direction:column"><button data-e="ok">存</button><button data-e="no">取消</button></span>`;
    const ta = row.querySelector('textarea'); ta.value = it.text; ta.focus();
    const done = (ok) => {
      const x = st.items.find(y => y.id === editing);
      if (ok && x) { if (ta.value.trim()) x.text = ta.value; else st.items = st.items.filter(y => y !== x); }
      editing = null; lastHtml = ''; save();
    };
    row.querySelector('[data-e=ok]').onclick = (e) => { e.stopPropagation(); done(true); };
    row.querySelector('[data-e=no]').onclick = (e) => { e.stopPropagation(); done(false); };
    ta.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) done(true);
      if (e.key === 'Escape') done(false);
    });
  }

  let toastEl, toastT;
  function toast(msg, ms = 1800) {
    if (!toastEl) { toastEl = document.createElement('div'); toastEl.id = 'cgq-toast'; document.body.appendChild(toastEl); }
    toastEl.textContent = msg; toastEl.style.opacity = '1';
    clearTimeout(toastT); toastT = setTimeout(() => toastEl.style.opacity = '0', ms);
  }

  // 编辑队列时，发送逻辑不能动正在编辑的那条
  const origTick = tick;
  setInterval(() => { if (!(editing && st.items[0]?.id === editing)) origTick(); }, TICK_MS);
  render();
})();
