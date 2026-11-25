// ==UserScript==
// @name         Feudal World War Relay
// @namespace    scottnotscott.feudalworld
// @version      0.1.0
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
  let socket, authenticated = false, status = 'Setup required', feed = [], panel, output, title;
  const pending = new Map();
  let config;
  try { config = JSON.parse(sessionStorage.getItem('fwRelay') || 'null'); } catch {}
  function render() {
    if (!title) return;
    title.textContent = 'War relay � ' + status;
    output.textContent = feed.length ? feed.map(r => (r.finished ? 'Finished' : 'Observed') + ' � ' + (r.attacker || '?') + '  ' + (r.defender || '?') + '  #' + r.id).join('\n') : 'Waiting for chain observations';
  }
  function flush() {
    if (!authenticated || socket.readyState !== 1 || !pending.size) return;
    socket.send(JSON.stringify({type:'observe', attacks:[...pending.values()]}));
    pending.clear();
  }
  function connect() {
    if (!config) return;
    status = 'Connecting';
    render();
    try { socket = new WebSocket(config.url); } catch { status = 'WebSocket blocked'; render(); return; }
    socket.onopen = () => socket.send(JSON.stringify({type:'auth', token:config.token}));
    socket.onmessage = e => {
      let data;
      try { data = JSON.parse(e.data); } catch { return; }
      if (data.type !== 'snapshot' || !Array.isArray(data.attacks)) return;
      authenticated = true;
      status = 'Connected';
      feed = data.attacks;
      render();
      flush();
    };
    socket.onclose = e => {
      authenticated = false;
      status = e.code === 1008 ? 'Access refused' : 'Disconnected';
      render();
      if (e.code !== 1008) setTimeout(connect,10000);
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
    panel = document.createElement('details');
    panel.style.cssText = 'position:fixed;bottom:12px;left:8px;z-index:99999;background:#182123;color:white;padding:7px;font:12px system-ui;border-radius:5px;max-width:85vw';
    title = document.createElement('summary');
    output = document.createElement('pre');
    output.style.cssText = 'max-height:25vh;overflow:auto;white-space:pre-wrap';
    const settings = document.createElement('button');
    settings.textContent = 'Connect / change relay';
    settings.onclick = () => {
      const url = prompt('Your faction relay (wss://host/relay)',config?.url || '');
      if (!url) return;
      try { if (new URL(url).protocol !== 'wss:') throw Error(); } catch { alert('Enter a secure wss:// address'); return; }
      const token = prompt('Your individual relay token');
      if (!token) return;
      config = {url,token:token.trim()};
      try {sessionStorage.setItem('fwRelay',JSON.stringify(config));} catch {}
      if (socket) {socket.onclose=null; socket.close();}
      authenticated=false;
      connect();
    };
    panel.append(title,output,settings);
    document.body.append(panel);
    render();
  }
  connect();
  if (document.body) mount(); else document.addEventListener('DOMContentLoaded',mount,{once:true});
})();
