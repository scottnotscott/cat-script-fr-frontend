// ==UserScript==
// @name         Feudal World War Relay
// @namespace    scottnotscott.feudalworld
// @version      0.4.1
// @match        https://www.torn.com/factions.php*
// @run-at       document-start
// @grant        none
// @updateURL    https://raw.githubusercontent.com/scottnotscott/cat-script-fr-frontend/main/war-relay.user.js
// @downloadURL  https://raw.githubusercontent.com/scottnotscott/cat-script-fr-frontend/main/war-relay.user.js
// ==/UserScript==
(() => {
  'use strict';
  if (window.top !== window.self || window.__fwRelay) return;
  window.__fwRelay = true;
  let socket, authenticated = false, status = 'Torn key needed', feed = [], panel, output, title;
  const pending = new Map();
  const RELAY_URL = 'ws://100.103.255.117:8787/relay';
  const TORN_API_KEY = '###PDA-APIKEY###';
  const validKey = value => /^[a-zA-Z0-9]{16}$/.test(value);
  let key = validKey(TORN_API_KEY) ? TORN_API_KEY : '';
  let retry;
  function render() {
    if (!title) return;
    title.textContent = 'War relay · ' + status;
    output.textContent = feed.length ? feed.map(r => (r.finished ? 'Finished' : 'Observed') + ' · ' + (r.attacker || '?') + ' → ' + (r.defender || '?') + '  #' + r.id).join('\n') : 'Waiting for chain observations';
  }
  function flush() {
    if (!authenticated || socket.readyState !== 1 || !pending.size) return;
    socket.send(JSON.stringify({type:'observe', attacks:[...pending.values()]}));
    pending.clear();
  }
  let sessionToken;
  let syncing = false;
  function nativeAvailable() {
    return typeof PDA_httpPost === 'function' || typeof window.flutter_inappwebview?.callHandler === 'function';
  }
  async function postNative(url, auth, data) {
    const args = [url, {Authorization: auth, 'Content-Type':'application/json'}, JSON.stringify(data)];
    let timer;
    try {
      const request = typeof PDA_httpPost === 'function' ? PDA_httpPost(...args)
        : window.flutter_inappwebview.callHandler('PDA_httpPost', ...args);
      const result = await Promise.race([request, new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error('Request timed out')), 15000);
      })]);
      return typeof result === 'string' ? JSON.parse(result) : result;
    } finally { clearTimeout(timer); }
  }
  async function syncNative() {
    if (syncing) return;
    if (!nativeAvailable()) {
      status = 'Waiting for PDA HTTP bridge';
      render();
      retry = setTimeout(syncNative, 2000);
      return;
    }
    syncing = true;
    const base = RELAY_URL.replace(/^ws/, 'http').replace(/\/relay$/, '');
    const post = (path, auth, body) => postNative(base + path, auth, body);
    let delay = 3000;
    try {
      if (!sessionToken) {
        status = 'Signing in to PC'; render();
        const login = await post('/login', 'ApiKey ' + key, {});
        if (Number(login.status) === 403) { status = 'Check Torn key and faction'; render(); return; }
        if (Number(login.status) !== 200) throw Error('Login HTTP ' + (login.status || 0));
        sessionToken = JSON.parse(login.responseText).token;
      }
      const batch = [...pending.values()];
      if (!feed.length && status !== 'Connected · PDA') { status = 'Syncing with PC'; render(); }
      const res = await post('/sync', 'Bearer ' + sessionToken, batch);
      if (Number(res.status) === 401) sessionToken = null;
      if (Number(res.status) !== 200) throw Error('Sync HTTP ' + (res.status || 0));
      feed = JSON.parse(res.responseText).attacks;
      for (const row of batch) if (pending.get(row.id) === row) pending.delete(row.id);
      status = 'Connected · PDA';
      panel?.querySelector('form')?.remove();
    } catch (err) {
      const message = String(err?.message || '');
      status = (/^(Login HTTP \d+|Sync HTTP \d+|Request timed out)$/.test(message) ? message : 'PDA request failed') + ' · retrying';
      delay = 10000;
    } finally { syncing = false; }
    render();
    retry = setTimeout(syncNative, delay);
  }
  function fallback() {
    if (typeof PDA_httpPost === 'function') return syncNative();
    status = 'WebSocket unavailable';
    render();
    retry = setTimeout(connect,10000);
  }
  function connect() {
    clearTimeout(retry);
    if (!key) return;
    if (validKey(TORN_API_KEY) || nativeAvailable()) return syncNative();
    status = 'Connecting';
    render();
    try { socket = new WebSocket(RELAY_URL); } catch { return fallback(); }
    socket.onerror = () => { status = 'WebSocket blocked or unreachable'; render(); };
    socket.onopen = () => socket.send(JSON.stringify({type:'auth', key}));
    socket.onmessage = e => {
      let data;
      try { data = JSON.parse(e.data); } catch { return; }
      if (data.type !== 'snapshot' || !Array.isArray(data.attacks)) return;
      authenticated = true;
      status = 'Connected';
      panel?.querySelector('form')?.remove();
      feed = data.attacks;
      render();
      flush();
    };
    socket.onclose = e => {
      const hadSession = authenticated;
      authenticated = false;
      if (!hadSession && e.code === 1006) return fallback();
      status = e.code === 1008 ? (e.reason || 'Access refused') : 'Disconnected';
      render();
      if (e.code !== 1008) retry = setTimeout(connect,10000);
    };
  }
  function observe(data) {
    const rows = data?.warDesc?.recentAttacks ?? data?.recentAttacks;
    if (!rows || typeof rows !== 'object') return;
    const name = v => typeof v === 'object' ? String(v?.name || v?.id || '') : String(v ?? '');
    for (const r of Object.values(rows).slice(-100)) {
      if (!r || typeof r !== 'object') continue;
      const id = String(r.attackID ?? r.attackId ?? r.attack_id ?? r.id ?? '');
      if (!/^[\w-]{1,80}$/.test(id)) continue;
      pending.set(id,{id,attacker:name(r.attacker ?? r.attackerName),defender:name(r.defender ?? r.defenderName),finished:r.finished === true || Number(r.timestamp_ended) > 0 || r.status === 'finished'});
      if (pending.size > 100) pending.delete(pending.keys().next().value);
    }
    flush();
  }
  const relevant = value => {
    try { const u = new URL(value,location.href); return u.origin === location.origin && u.pathname === '/faction_wars.php'; } catch { return false; }
  };
  const original = window.fetch;
  window.fetch = async function(...args) {
    const res = await original.apply(this,args);
    if (relevant(res.url)) { try { res.clone().json().then(observe).catch(() => {}); } catch {} }
    return res;
  };
  const open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method,url,...rest) {
    if (relevant(url)) this.addEventListener('load',function() {
      try { if (relevant(this.responseURL)) observe(this.responseType === 'json' ? this.response : JSON.parse(this.responseText)); } catch {}
    },{once:true});
    return open.call(this,method,url,...rest);
  };
  function mount() {
    const host = document.createElement('div');
    host.style.cssText = 'all:initial;position:fixed;bottom:12px;left:8px;z-index:99999';
    const root = host.attachShadow({mode:'closed'});
    const style = document.createElement('style');
    style.textContent = `
      details { color-scheme:dark; background:#182123; color:#f3f6f6; border:1px solid #55676b; padding:7px 10px; font:13px/1.45 system-ui; border-radius:6px; max-width:85vw }
      summary { cursor:pointer }
      pre { max-height:25vh; overflow:auto; white-space:pre-wrap; font:inherit }
      input,button { background:#29383c; color:#fff; border:1px solid #839498; border-radius:4px; padding:6px; font:inherit }
      input::placeholder { color:#c6d0d2 }
      form { display:flex; gap:4px; flex-wrap:wrap }
    `;
    panel = document.createElement('details');
    title = document.createElement('summary');
    output = document.createElement('pre');
    panel.append(title,output);
    if (!key) {
      const form = document.createElement('form');
      const input = document.createElement('input');
      input.type = 'password';
      input.placeholder = 'Public-access Torn API key';
      input.setAttribute('aria-label',input.placeholder);
      input.required = true;
      input.pattern = '[a-zA-Z0-9]{16}';
      const submit = document.createElement('button');
      submit.textContent = 'Sign in';
      form.append(input,submit);
      panel.append(form);
      form.onsubmit = event => {
        event.preventDefault();
        if (!validKey(input.value)) return;
        key = input.value;
        input.value = '';
        if (socket) {socket.onclose = null; socket.close();}
        authenticated = false;
        connect();
      };
    }
    root.append(style,panel);
    document.body.append(host);
    render();
  }
  connect();
  if (document.body) mount(); else document.addEventListener('DOMContentLoaded',mount,{once:true});
})();
