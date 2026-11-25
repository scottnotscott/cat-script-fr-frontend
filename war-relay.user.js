// ==UserScript==
// @name         Feudal World War Relay
// @namespace    scottnotscott.feudalworld
// @version      0.5.0
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
  let revision, me, order, rosterAt = 0, online = [], leaders, target, directive, presence, owner, notice;
  const candidates = new Map();
  const commands = ['EVERYONE TURTLE','EVERYONE PILE ON','DRAG CHAIN OUT','AIMING FOR 1k CHAIN','INSIDE HITS ONLY','Clear order'];
  function accept(data) {
    me = data.me; order = data.order; online = data.online || []; rosterAt = data.rosterAt || 0;
    feed = data.attacks || [];
  }
  function render() {
    if (!title) return;
    title.textContent = (me ? me.name + ' · ' + me.role : 'War relay') + ' · ' + status + (order && !panel.open ? ' · ' + order.text : '');
    if (!panel.open) return;
    leaders.hidden = !me?.leader;
    owner.textContent = order ? order.text + ' — ' + order.by : '';
    presence.textContent = !rosterAt ? 'Waiting for faction roster' : 'Online (' + online.length + '): ' + (online.join(', ') || 'none') + ' · updated ' + Math.max(0,Math.floor((Date.now()-rosterAt)/1000)) + 's ago';
    output.textContent = feed.length ? feed.map(r => (r.live ? 'In progress' : r.finished ? 'Finished' : 'Observed') + ' · ' + (r.attacker || '?') + ' → ' + (r.defender || '?') + (r.at ? ' · ' + (r.observed ? 'seen ' : '') + Math.max(0,Math.floor((Date.now()-r.at)/1000)) + 's ago' : '')).join('\n') : 'Waiting for chain observations';
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
  async function postNative(url, auth, data, extra = {}) {
    const args = [url, {Authorization: auth, 'Content-Type':'application/json', ...extra}, JSON.stringify(data)];
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
        revision = null;
      }
      const batch = [...pending.values()];
      if (!feed.length && status !== 'Connected · PDA') { status = 'Syncing with PC'; render(); }
      const res = await post('/sync', 'Bearer ' + sessionToken, {attacks:batch,revision});
      if (Number(res.status) === 401) sessionToken = null;
      if (Number(res.status) !== 200) throw Error('Sync HTTP ' + (res.status || 0));
      const data = JSON.parse(res.responseText);
      if (!data.unchanged) { accept(data); revision = data.revision; }
      if (rosterAt && Date.now()-rosterAt > 45000) await postNative(base+'/roster','Bearer '+sessionToken,{}, {'X-Torn-Key':key});
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
      if (data.type === 'orderDenied') {notice.textContent='Order refused. Check your faction role.';return;}
      if (data.type !== 'snapshot' || !Array.isArray(data.attacks)) return;
      authenticated = true;
      status = 'Connected';
      panel?.querySelector('form')?.remove();
      accept(data);
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
  setInterval(() => {if (authenticated) socket.send(JSON.stringify({type:'roster',key}));},45000);
  function observe(data) {
    const members = data?.rankedWarMembers || data?.warDesc?.members;
    if (members && typeof members === 'object') {
      const fresh = new Map();
      for (const [id,m] of Object.entries(members)) {
        const name = m?.playername || m?.name || m?.userName;
        if (typeof name === 'string') fresh.set(String(m.userID ?? id),name);
      }
      if (fresh.size) { candidates.clear(); for (const [id,name] of fresh) candidates.set(id,name); fillTargets(); }
    }
    const desc = data?.warDesc ?? data;
    const users = desc?.users ?? data?.users ?? {};
    const label = (id,value) => String(users[id]?.playername ?? users[id]?.name ?? value?.name ?? value ?? id ?? '').slice(0,60);
    for (const [live,rows] of [[true,desc?.currentAttacks ?? data?.currentAttacks],[false,desc?.recentAttacks ?? data?.recentAttacks]]) {
      for (const r of Object.values(rows || {}).slice(-100)) {
        if (!r || typeof r !== 'object') continue;
        const aid = r.attackerID ?? r.attackerId ?? r.attacker_id, did = r.defenderID ?? r.defenderId ?? r.defender_id;
        const pair = aid && did ? aid + '-' + did : '';
        const raw = live ? (r.key ?? pair) : (r.publicID ?? r.attackID ?? r.attackId ?? r.attack_id ?? r.id);
        if (!raw || !/^[\w-]{1,70}$/.test(String(raw))) continue;
        const id = (live ? 'live-' : '') + raw;
        const time = Number(r.finishTimestamp ?? r.timestamp_ended);
        pending.set(id,{id,pair,live,finished:!live,at:time > 1e12 ? time : time*1000,attacker:label(aid,r.attackerName ?? r.attacker),defender:label(did,r.defenderName ?? r.defender)});
        if (pending.size > 100) pending.delete(pending.keys().next().value);
      }
    }
    flush();
  }
  const relevant = value => {
    try { const u = new URL(value,location.href); return u.origin === location.origin && (u.pathname === '/faction_wars.php' || ['getwardata','getwarusers'].includes(u.searchParams.get('step'))); } catch { return false; }
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
  function fillTargets() {
    if (!target) return;
    const names = new Set(candidates.values());
    for (const link of document.querySelectorAll('#faction_war_list_id a[href*="profiles.php"],.f-war-list a[href*="profiles.php"]')) {
      const n = link.textContent.trim();
      if (/^[a-zA-Z0-9_ -]{1,40}$/.test(n)) names.add(n);
    }
    names.add('Nutbaws');
    const list = [...names].sort();
    if (JSON.stringify(list) === target.dataset.names) return;
    const selected = target.value;
    target.replaceChildren(...list.map(name=>new Option(name,name)));
    target.value = names.has(selected) ? selected : 'Nutbaws';
    target.dataset.names = JSON.stringify(list);
  }
  function newsButton(button) {
    let hidden = false;
    try { hidden = localStorage.getItem('fw.hideNews') === '1'; } catch {}
    const style = document.createElement('style');
    style.textContent = '[data-fw-hide-news]{display:none!important}';
    document.head.append(style);
    let section;
    function apply() {
      if (!section?.isConnected) {
        const headings = document.querySelectorAll('h2,h3,h4,[role="heading"],.title-black,.title-gray,[class*="title___"]');
        const head = [...headings].find(el=>el.textContent.trim().toLowerCase()==='main news');
        section = head?.closest('.faction-news,.news-wrap,[class*="newsWrap"],[class*="newsContainer"],section,.sortable-box');
        if (!section && head?.parentElement?.children.length > 1 && head.parentElement.textContent.length > head.textContent.length && !head.parentElement.querySelector('.f-war-list,#faction_war_list_id')) section = head.parentElement;
      }
      section?.toggleAttribute('data-fw-hide-news',hidden);
      button.textContent = hidden ? 'Show main news' : 'Hide main news';
    }
    button.onclick = () => {hidden=!hidden; try {localStorage.setItem('fw.hideNews',hidden?'1':'0');} catch {} apply();};
    apply();
    let timer;
    new MutationObserver(() => {if (!section?.isConnected && !timer) timer=setTimeout(()=>{timer=null;apply();},1000);}).observe(document.body,{childList:true,subtree:true});
  }
  function mount() {
    const host = document.createElement('div');
    host.style.cssText = 'all:initial;position:fixed;bottom:12px;left:8px;z-index:99999';
    const root = host.attachShadow({mode:'closed'});
    const style = document.createElement('style');
    style.textContent = `
      [hidden]{display:none!important} strong{display:block;color:#ffe194}
      details { color-scheme:dark; background:#182123; color:#f3f6f6; border:1px solid #55676b; padding:7px 10px; font:13px/1.45 system-ui; border-radius:6px; max-width:85vw }
      summary { cursor:pointer }
      pre { max-height:25vh; overflow:auto; white-space:pre-wrap; font:inherit }
      select,input,button { background:#29383c; color:#fff; border:1px solid #839498; border-radius:4px; padding:6px; font:inherit }
      input::placeholder { color:#c6d0d2 }
      form { display:flex; gap:4px; flex-wrap:wrap }
    `;
    panel = document.createElement('details');
    title = document.createElement('summary');
    output = document.createElement('pre');
    owner = document.createElement('strong');
    presence = document.createElement('p');
    leaders = document.createElement('div');
    leaders.hidden = true;
    directive = document.createElement('select');
    directive.setAttribute('aria-label','War direction');
    for (const name of commands) directive.add(new Option(name,name));
    target = document.createElement('select');
    target.setAttribute('aria-label','Pile-on target');
    target.hidden = true;
    directive.onchange = () => {target.hidden=directive.value !== commands[1]; fillTargets();};
    const send = document.createElement('button');
    send.textContent = 'Send order';
    notice = document.createElement('span');
    send.onclick = async () => {
      const request = {type:'order',command:directive.value,target:target.value};
      send.disabled=true;
      try {
        if (authenticated) socket.send(JSON.stringify(request));
        else {
          const res = await postNative(RELAY_URL.replace(/^ws/,'http').replace('/relay','/order'),'Bearer '+sessionToken,request);
          if (Number(res.status)!==200) throw Error();
        }
        notice.textContent=' Sent';
      } catch {notice.textContent=' Order refused or relay offline';}
      finally {send.disabled=false;}
    };
    leaders.append(directive,target,send,notice);
    const news = document.createElement('button');
    newsButton(news);
    fillTargets();
    panel.ontoggle = () => {if(panel.open) fillTargets(); render();};
    panel.append(title,owner,presence,leaders,output,news);
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
