// ==UserScript==
// @name         Feudal World War Relay
// @namespace    scottnotscott.feudalworld
// @version      0.9.7
// @match        https://www.torn.com/*
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
  const sentObservations = new Map();
  const RELAY_BASE = 'http://167.114.182.109:8787';
  const RELAY_URL = RELAY_BASE.replace(/^http/,'ws')+'/relay';
  const TORN_API_KEY = '###PDA-APIKEY###';
  const validKey = value => /^[a-zA-Z0-9]{16}$/.test(value);
  let key = validKey(TORN_API_KEY) ? TORN_API_KEY : '';
  let retry;
  let revision, me, order, rosterAt = 0, online = [], leaders, target, directive, presence, owner, notice;
  const candidates = new Map();
  const commands = ['EVERYONE TURTLE','EVERYONE ATTACK','DRAG CHAIN OUT','AIM->1k CHAIN','INSIDE HITS ONLY','Clear order','BUILD CHAIN','CHAIN DENIAL - HOSP ONLINERS'];
  let ops={}, nextIntel=0, chainObservation=null, opsBox, assignments, recipient, memberCommand, watchList, extras, attackAlert, shareButton;
  let previousFights=null, fightUntil=0, selectedFight=null, previousSignal=null;

  const endpoint = path => RELAY_BASE+path;
  async function refreshIntel(){
    if(Date.now()<nextIntel || (!sessionToken && !authenticated))return;
    nextIntel=Date.now()+30000;
    if(authenticated){socket.send(JSON.stringify({type:'intel',key}));return;}
    try { await postNative(endpoint('/intel'),'Bearer '+sessionToken,{}, {'X-Torn-Key':key}); } catch {}
  }
  function accept(data) {
    ops=data.ops || {};
    if(Array.isArray(data.attackChanges)){
      const entries=new Map(feed.map(a=>[a.id,a]));
      for(const id of data.removedAttacks || [])entries.delete(id);
      for(const a of data.attackChanges)entries.set(a.id,a);
      data.attacks=[...entries.values()].sort((a,b)=>b.at-a.at);
    }
    const recent=data.attacks || [];
    const signatures=new Map(recent.map(a=>[a.id,JSON.stringify([a.result,a.live,a.attackerLife,a.defenderLife,a.attackerMax,a.defenderMax,a.respect])]));
    if(selectedFight?.live){const latest=recent.find(a=>a.id===selectedFight.id);if(latest){selectedFight=latest;if(Date.now()-(latest.sampleAt||latest.at)<15000)fightUntil=Date.now()+7500;}else fightUntil=0;}
    if(!previousFights){selectedFight=recent.find(a=>a.live && Date.now()-(a.sampleAt||a.at)<15000);if(selectedFight)fightUntil=Date.now()+7500;}
    if(previousFights){
      const changed=recent.filter(a=>signatures.get(a.id)!==previousFights.get(a.id) && Date.now()-(a.sampleAt || a.at)<45000);
      if(changed.length){selectedFight=changed.sort((a,b)=>(b.sampleAt||b.at)-(a.sampleAt||a.at))[0];fightUntil=Date.now()+7500;}
    }
    previousFights=signatures;
    me = data.me; order = data.order; online = data.online || []; rosterAt = data.rosterAt || 0;
    feed = data.attacks || [];
  }
  function elapsed(stamp) {
    const seconds = Math.max(0, Math.floor((Date.now()-stamp)/1000));
    if (seconds < 60) return seconds+'s';
    const pad = n => String(n).padStart(2,'0');
    const mins = Math.floor(seconds/60);
    return (mins>=60 ? Math.floor(mins/60)+':'+pad(mins%60) : mins)+':'+pad(seconds%60);
  }
  function element(tag,cls,text) {
    const node=document.createElement(tag);
    node.className=cls;
    if (text!=null) node.textContent=text;
    return node;
  }
  function clock(at) {
    const t=element('time','age');
    if (at) {t.dataset.stamp=at;t.textContent=elapsed(at)+' ago';}
    return t;
  }
  let lastOrder='', lastRoster='', lastFeed='', flash, flashTimer;
  function visibleIconRow() {
    const selectors = '#sidebarroot [class*="status-icons"],#sidebarroot [class*="statusIcons"],#status-icons,.status-icons,[class*="iconTray"],[class*="icon-tray"],[class*="statusIcons"],[class*="status-icons"],[class*="user-information-icons"]';
    for (const node of document.querySelectorAll(selectors)) {
      const r=node.getBoundingClientRect();
      if (r.width>80 && r.height>8 && r.height<100 && r.right>0 && r.left<innerWidth) return node;
    }
    // On mobile layouts the row may only expose individual icon tooltips.
    for (const icon of document.querySelectorAll('[title*="Points" i],[aria-label*="points" i],[data-tooltip*="points" i],#user_points')) {
      for (let n=icon; n && n!==document.body; n=n.parentElement) {
        const r=n.getBoundingClientRect();
        if (r.height>90) break;
        if (r.width>innerWidth*.55 && r.height>=12 && r.bottom>0 && r.top<innerHeight/2 && n.querySelectorAll('img,svg,i,a,li').length>=3) return n;
      }
    }
    return null;
  }
  let stopTracking=()=>{};
  function dismissFlash() {
    clearTimeout(flashTimer);
    stopTracking();
    if (flash) flash.hidden=true;
  }
  function showFlash() {
    dismissFlash();
    if(!isWarView())return;
    flash.hidden=false;flash.classList.remove('anchored');flash.style.removeProperty('top');flashTimer=setTimeout(dismissFlash,10000);
  }
  function isWarView(){const q=new URLSearchParams(location.search);const h=location.hash;return location.pathname==='/factions.php'&&q.get('step')!=='rankreport'&&q.get('step')!=='profile'&&(!q.get('type')||q.get('type')==='1')&&!h.includes('tab=')&&!/^#\/war\/\d+$/.test(h)&&(!h||h==='#/'||h.startsWith('#/war'));}
  function render() {
    if (!title) return;
    title.textContent = 'War room · '+(me ? me.name+' · '+me.role+' · '+status : status);
    title.title=status;
    const signature=JSON.stringify(order || null);
    if (signature!==lastOrder) {
      lastOrder=signature;
      owner.hidden=!order||!isWarView();
      dismissFlash();
      if (order) {
        const command=element('b','command',order.text);
        const who=element('div','issued','Issued by '+order.by+' · ');
        who.append(clock(order.at));
        owner.replaceChildren(element('small','','ACTIVE WAR ORDER'),command,who);
        if (Date.now()-order.at<30000) {
          flash.replaceChildren(element('small','','NEW WAR ORDER'),command.cloneNode(true),element('span','',order.by));
          showFlash();
        }
      } else owner.replaceChildren();
    }
    renderOps();
    if (!panel.open) return;
    leaders.hidden=!me?.leader || (roomTabs && roomTabs.querySelector('.selected')?.dataset.tab!=='Orders');
    const rosterKey=JSON.stringify([online,rosterAt,me?.leader,ops.available,ops.views]);
    if (rosterKey!==lastRoster) {
      lastRoster=rosterKey;
      const grid=element('ul','people');
      for (const name of [...online].sort((a,b)=>a.localeCompare(b))) {
        const cell=element('li','','');
        if(me?.leader && (ops.available||[]).includes(name)){const b=element('button','member',name+' · '+((ops.views||[]).find(v=>v.name===name)?.page||'Other')+((ops.views||[]).find(v=>v.name===name)?.visible===false?' · background':''));b.onclick=()=>{roomTabs?.querySelector('[data-tab="Orders"]')?.click();recipient.value=name;assignments.open=true;assignments.scrollIntoView({block:'nearest'});};cell.append(b);}
        else cell.textContent=name;
        grid.append(cell);
      }
      presence.replaceChildren(element('h4','','Online now · '+online.length),grid,clock(rosterAt));
    }
    const feedKey=JSON.stringify(feed);
    if (feedKey!==lastFeed) {
      lastFeed=feedKey;
      const items=feed.map(r=>{
        const item=element('article','fight');
        item.append(element('b',r.live?'live':'result',r.live?'LIVE FIGHT':outcome(r)+(Number.isFinite(r.respect)?' · +'+r.respect.toFixed(2)+' R':'')),clock(r.sampleAt || r.at));
        const fighter=(name,life)=> (name && name!=='0'?name:'Unknown') + (r.live?' (last HP '+(life??'?')+')':'');
        if(r.live){const bars=element('div','fighters hpgrid');bars.append(hpBar(r.attacker,r.attackerLife,r.attackerMax),hpBar(r.defender,r.defenderLife,r.defenderMax));item.append(bars);}else item.append(element('div','fighters',fighter(r.attacker,r.attackerLife)+' → '+fighter(r.defender,r.defenderLife)));
        return item;
      });
      output.replaceChildren(element('h4','','Chain activity'),...(items.length?items:[element('p','','Waiting for chain observations')]));
    }
  }
  function flush() {
    if (!authenticated || socket.readyState !== 1 || (!pending.size && !chainObservation)) return;
    socket.send(JSON.stringify({type:'observe',chain:chainObservation, attacks:[...pending.values()]}));
    pending.clear();
  }
  let sessionToken;
  function currentPage(){
    const p=location.pathname, h=location.hash;
    if(p==='/factions.php')return /war|chain/i.test(h)?'Faction war':'Faction';
    if(p==='/loader.php' && new URLSearchParams(location.search).get('sid')==='attack')return 'Attack';
    return ({'/hospital.php':'Hospital','/travelagency.php':'Travel','/item.php':'Items','/gym.php':'Gym','/crimes.php':'Crimes','/profiles.php':'Profile'})[p]||'Other';
  }
  function pageInfo(){const targetId=new URLSearchParams(location.search).get('user2ID');const heading=document.querySelector('#mainContainer h1, .content-title h4, main h1');const title=(heading?.textContent?.trim()||document.title.replace(/\s*[-|–]\s*Torn.*$/i,'')||currentPage()).slice(0,70);const targetName=feed.find(a=>a.pair?.split('-')[1]===targetId)?.defender||document.querySelector('a[href*="XID='+targetId+'"]')?.textContent?.trim()||targetId;return {page:currentPage()==='Attack'&&targetId?'→ '+targetName:title,focused:document.hasFocus(),visible:!document.hidden,targetId};}
  function reportPresence(){if(authenticated && socket?.readyState===1)socket.send(JSON.stringify({type:'presence',...pageInfo()}));}
  setInterval(reportPresence,5000);
  window.addEventListener('hashchange',reportPresence);

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
        status = 'Signing in to VPS'; render();
        const login = await post('/login', 'ApiKey ' + key, {});
        if (Number(login.status) === 403) { status = 'Check Torn key and faction'; render(); return; }
        if (Number(login.status) !== 200) throw Error('Login HTTP ' + (login.status || 0));
        sessionToken = JSON.parse(login.responseText).token;
        revision = null;
      }
      const batch = [...pending.values()];
      if (!feed.length && status !== 'Connected · PDA') { status = '↺'; render(); }
      const res = await post('/sync', 'Bearer ' + sessionToken, {attacks:batch,revision,delta:true,chain:chainObservation,...pageInfo()});
      if (Number(res.status) === 401) sessionToken = null;
      if (Number(res.status) !== 200) throw Error('Sync HTTP ' + (res.status || 0));
      const data = JSON.parse(res.responseText);
      if (!data.unchanged) { accept(data); revision = data.revision; }
      if (rosterAt && Date.now()-rosterAt > 45000) await postNative(base+'/roster','Bearer '+sessionToken,{}, {'X-Torn-Key':key});
      for (const row of batch) if (pending.get(row.id) === row) pending.delete(row.id);
      void refreshIntel();
      status = 'Connected';
      panel?.querySelector('form')?.remove();
    } catch (err) {
      const message = String(err?.message || '');
      status = (/^(Login HTTP \d+|Sync HTTP \d+|Request timed out)$/.test(message) ? message : 'request failed') + ' · retrying';
      delay = 10000;
    } finally { syncing = false; }
    render();
    retry = setTimeout(syncNative, delay);
  }
  function fallback() {
    if (nativeAvailable()) return syncNative();
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
    socket.onopen = () => socket.send(JSON.stringify({type:'auth',delta:true, key}));
    socket.onmessage = e => {
      let data;
      try { data = JSON.parse(e.data); } catch { return; }
      if(data.type==='orderResult'){const cb=orderWaiters.get(data.requestId);if(cb){orderWaiters.delete(data.requestId);cb(data);}return;}
      if (data.type === 'orderDenied') {notice.textContent='Order refused. Check your faction role.';return;}
      if (data.type !== 'snapshot' || !(Array.isArray(data.attacks)||Array.isArray(data.attackChanges))) return;
      authenticated = true;
      status = 'Connected';
      void refreshIntel();
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
  setInterval(() => {if (authenticated) {socket.send(JSON.stringify({type:'roster',key}));void refreshIntel();}},45000);
  function observe(data, sampleAt=Date.now()) {
    const own=String(data?.factionID ?? data?.warDesc?.factionID ?? '')==='55412';
    const source=data?.wars?.find?.(w=>w.key==='chain'||w.type==='chain')?.data ?? data?.warDesc ?? data;
    const count=source?.chainBar?.chain ?? source?.chain?.chain;
    if(own && count!=null && Number.isSafeInteger(Number(count)))chainObservation={count:Number(count),at:sampleAt,timeout:source?.chainBar?.timeout ?? source?.chain?.timeout};
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
        const life = id => {
          const raw = users[id]?.life;
          const n = raw?.current ?? raw;
          return (typeof n === 'number' || typeof n === 'string' && /^\d+$/.test(n)) && Number.isSafeInteger(Number(n)) && Number(n)>=0 ? Number(n) : null;
        };
        const maxLife=id=>{const n=Number(users[id]?.life?.maximum ?? users[id]?.life?.max);return Number.isSafeInteger(n)&&n>0?n:null;};
        const rawRespect=r.respect ?? r.respect_gain ?? r.respectGain;
        const report={id,sampleAt,attackerMax:maxLife(aid),defenderMax:maxLife(did),respect:rawRespect!=null && Number.isFinite(Number(rawRespect))?Number(rawRespect):null,result:typeof r.result === 'string' ? r.result : '',attackerLife:live ? life(aid) : null,defenderLife:live ? life(did) : null,pair,live,finished:!live,at:time > 1e12 ? time : time*1000,attacker:label(aid,r.attackerName ?? r.attacker),defender:label(did,r.defenderName ?? r.defender)};
        const signature=JSON.stringify({...report,sampleAt:0});
        const prior=sentObservations.get(id);
        if(prior?.signature===signature && (!live || sampleAt-prior.at<15000))continue;
        sentObservations.set(id,{signature,at:sampleAt});
        if(sentObservations.size>300)sentObservations.delete(sentObservations.keys().next().value);
        pending.set(id,report);
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
    const sampleAt=Date.now();
    const res = await original.apply(this,args);
    if (relevant(res.url)) { try { res.clone().json().then(data=>observe(data,sampleAt)).catch(() => {}); } catch {} }
    return res;
  };
  const open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method,url,...rest) {
    const sampleAt=Date.now();
    if (relevant(url)) this.addEventListener('load',function() {
      try { if (relevant(this.responseURL)) observe(this.responseType === 'json' ? this.response : JSON.parse(this.responseText),sampleAt); } catch {}
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
  function layout(host,button) {
    const hideClass='fw-news-hidden';
    const css=element('style','');
    css.textContent='.'+hideClass+'{display:none!important}';
    document.head.append(css);
    let hidden=false,section,anchor,chainAnchor,timer;
    try {hidden=localStorage.getItem('fw.hideNews')==='1';} catch {}
    function locate() {
      const scope=document.querySelector('#faction-main,.content-wrapper,#mainContainer,main') || document.body;
      const walker=document.createTreeWalker(scope,NodeFilter.SHOW_TEXT);
      const news=[];
      let announcement,chainLabel,warLabel;
      for(let node; (node=walker.nextNode());) {
        const text=node.nodeValue.trim().toLowerCase();
        if(!chainLabel && /^(no active chain|active chain|current chain)$/.test(text)) chainLabel=node.parentElement;
        if(!warLabel && /your faction is (?:not )?in a war|your faction is at war/.test(text)) warLabel=node.parentElement;
        if(text==='main news') news.push(node.parentElement);
        if(text==='faction announcement') announcement=node.parentElement;
      }
      const first=news[0];
      section=scope.querySelector('#faction-news,#faction-main-news,[data-section="main-news"],.faction-news') || null;
      if(!section && first) {
        // The outer title and inner filter have identical labels. Find their
        // common container and include the list beneath the filter.
        const last=news[news.length-1];
        let candidate=first;
        while(candidate && candidate!==scope && candidate!==document.body && !candidate.contains(announcement || host)) {
          const hasList=candidate.querySelector('ul,ol,table,[class*="news-list"],[class*="newsList"],[class*="news-row"]');
          if(candidate.contains(last) && (hasList || candidate.textContent.trim().length>110)) {section=candidate;break;}
          candidate=candidate.parentElement;
        }
      }
      if(section && (section.contains(announcement || host) || section===scope || section===document.body)) section=null;
      // Insert at the section boundary, outside anything the toggle hides.
      const widget = scope.querySelector('#chain-widget,#faction-chain,[data-widget="chain"],[class*="chain-box"],[class*="chainBox"],[class*="chain-widget"],[class*="chainWidget"]');
      chainAnchor=chainLabel || widget;
      if(chainAnchor) {
        // Climb to the branch immediately after the war summary. Never move
        // above their common ancestor or into the chain's title/controls.
        const boundary = warLabel || announcement;
        if(boundary && !chainAnchor.contains(boundary)) {
          while(chainAnchor.parentElement && chainAnchor.parentElement!==scope && !chainAnchor.parentElement.contains(boundary))
            chainAnchor=chainAnchor.parentElement;
        } else {
          chainAnchor=widget || chainAnchor.closest('section,.sortable-box,[class*="chain-wrap"],[class*="chainWrap"]') || chainAnchor.parentElement;
        }
      }
      anchor=chainAnchor || section || announcement?.closest('.sortable-box,section,[class*="announcement-wrap"]') || scope.querySelector('#faction_war_list_id,.f-war-list');
      if(anchor && anchor!==host && !host.contains(anchor)) {
        if(host.nextElementSibling!==anchor) anchor.before(host);
      } else if(!host.isConnected) scope.prepend(host);
      section?.classList.toggle(hideClass,hidden);
      button.textContent=section ? (hidden?'Show main news':'Hide main news') : 'Main news unavailable';
      button.disabled=!section;
    }
    button.onclick=()=>{hidden=!hidden;try{localStorage.setItem('fw.hideNews',hidden?'1':'0');}catch{}locate();};
    locate();
    new MutationObserver(()=>{
      if(host.isConnected && section?.isConnected && chainAnchor?.isConnected && host.nextElementSibling===anchor) return;
      if(!timer) timer=setTimeout(()=>{timer=null;locate();},700);
    }).observe(document.body,{childList:true,subtree:true});
  }
  function outcome(a){return /^attacked$/i.test(a.result||'')?'Left':a.result||'Outcome unavailable';}
  function hpBar(name,hp,max){const wrap=element('div','hpwrap');const percent=Number.isFinite(hp)&&hp>=0&&hp<=100;const exact=Number.isFinite(hp)&&Number.isFinite(max)&&max>100&&hp>100;const ratio=percent?hp:exact?100*hp/max:null;wrap.append(element('div','hplabel',name+' · '+(percent?hp+'%':exact?hp+' / '+max:'HP unknown')));if(ratio!==null){const bar=element('div','hpbar'),fill=element('div','hpfill');fill.style.width=Math.max(0,Math.min(100,ratio))+'%';bar.append(fill);wrap.append(bar);}return wrap;}
  function positionFight() {
    if(!attackAlert)return;
    attackAlert.hidden=!selectedFight || Date.now()>=fightUntil;
    if(attackAlert.hidden)return;
    const a=selectedFight;
    const fighter=(name,hp)=> (name && name!=='0'?name:'Unknown')+(a.live?' · HP '+(hp??'?'):'');
    if(a.live){const bars=element('div','hpgrid');bars.append(hpBar(a.attacker,a.attackerLife,a.attackerMax),hpBar(a.defender,a.defenderLife,a.defenderMax));attackAlert.replaceChildren(element('small','','LIVE · '+elapsed(a.sampleAt||a.at)+' ago'),bars);}else attackAlert.textContent=outcome(a)+' · '+fighter(a.attacker)+' → '+fighter(a.defender);
    attackAlert.style.position='static';attackAlert.style.removeProperty('top');
    
  }
  const orderWaiters=new Map();
  async function sendAction(scope,command,target,ids) {
    const payload={type:'order',scope,command,target,ids};
    notice.textContent=' Sending…';
    try {
      if(authenticated && socket?.readyState===1){
        const requestId=Date.now().toString(36)+'-'+Math.random().toString(36).slice(2);
        const result=await new Promise((resolve,reject)=>{
          const timer=setTimeout(()=>{orderWaiters.delete(requestId);reject(Error('No order acknowledgement'));},12000);
          orderWaiters.set(requestId,data=>{clearTimeout(timer);resolve(data);});
          try{socket.send(JSON.stringify({...payload,key,requestId}));}catch(err){clearTimeout(timer);orderWaiters.delete(requestId);reject(err);}
        });
        if(!result.ok)throw Error(result.error||'Order rejected');
      }else{
        if(!sessionToken)throw Error('Not signed in to VPS');
        const r=await postNative(endpoint('/order'),'Bearer '+sessionToken,payload,{'X-Torn-Key':key});
        if(Number(r.status)===401){sessionToken=null;clearTimeout(retry);void syncNative();throw Error('Session expired; reconnecting, retry order');}
        if(Number(r.status)!==200){let reason;try{reason=JSON.parse(r.responseText).error;}catch{}throw Error(reason||'Order HTTP '+(r.status||0));}
        clearTimeout(retry);if(!syncing)void syncNative();
      }
      notice.textContent=' Confirmed';
      return true;
    }catch(err){notice.textContent=' '+(err?.message||'Order failed');return false;}
  }
  function options(select,list) {
    const sig=JSON.stringify(list);
    if(select.dataset.options===sig)return;
    const selected=[...select.selectedOptions].map(o=>o.value);
    select.replaceChildren(...list.map(([id,name])=>new Option(name,id)));
    for(const o of select.options)if(selected.includes(o.value))o.selected=true;
    select.dataset.options=sig;
  }
  function buildOps() {

    opsBox=element('details','headcount');
    opsBox.append(element('summary','','Energy headcount'),element('div','readings'));
    assignments=element('details','assignments');
    assignments.append(element('summary','','Member orders and chain watch'));
    recipient=element('select','');recipient.setAttribute('aria-label','Faction member');
    memberCommand=element('select','');
    options(memberCommand,['SIT ABROAD (CLOSE)','SIT ABROAD (FAR)','TURTLE','OUTSIDE HITS ONLY','INSIDE HITS ONLY','BUILD CHAIN','Clear personal order'].map(s=>[s,s]));
    memberCommand.onchange=()=>renderOps();
    const issue=element('button','','Apply to member');
    issue.onclick=()=>{if(recipient.value && (['Assign watcher','Remove watcher','Clear personal order'].includes(memberCommand.value)||(ops.available||[]).includes(recipient.value)))sendAction('member',memberCommand.value,recipient.value);};
    watchList=element('select','');watchList.multiple=true;watchList.size=4;
    const enable=element('button','','Build chain · watch selected');
    enable.onclick=()=>sendAction('watch','Watch enemies','',[...watchList.selectedOptions].map(o=>o.value));
    const disable=element('button','','Stop enemy watch');disable.onclick=()=>sendAction('watch','Stop watching enemies');
    watchSection=element('details','assignments');watchSection.append(element('summary','','Enemy watch'),watchList,enable,disable);
    assignments.append(element('h4','','Individual orders'),recipient,memberCommand,issue);activeOrders=element('div','activeOrders');assignments.append(activeOrders);watcherSettings=element('div','orderGroup');primarySelect=element('select','');secondarySelect=element('select','');primarySelect.setAttribute('aria-label','Primary watcher');secondarySelect.setAttribute('aria-label','Secondary watcher');const saveWatch=element('button','','Save watchers');saveWatch.onclick=()=>{if(primarySelect.value&&primarySelect.value===secondarySelect.value){notice.textContent='Choose two different members';return;}sendAction('member','Set chain watchers','',[primarySelect.value,secondarySelect.value]);};const pLabel=element('label','','Primary');pLabel.append(primarySelect);const sLabel=element('label','','Secondary');sLabel.append(secondarySelect);watcherSettings.append(element('h4','','Chain watchers'),pLabel,sLabel,saveWatch);assignments.append(watcherSettings);panel.insertBefore(watchSection,output);
    rosterTabs.append(opsBox);opsBox.hidden=true;panel.insertBefore(assignments,output);
  }
  let opsKey='', watchSection, guard, personalHeader, rosterTabs, headerRect, roomTabs, primarySelect, secondarySelect, watcherSettings, activeOrders, watcherSignature='', slotSignature='';
  function placePersonal(personal){
    if(!personalHeader)return;
    const activePersonal=personal&&!personal.cleared?personal:null;
    const shown=isWarView()?activePersonal:(order||activePersonal);
    personalHeader.hidden=true;if(!shown)return;
    const logo=document.querySelector('a[href="/"],a[href="/index.php"],#logo,.logo');
    const search=document.querySelector('[aria-label*="search" i],[title="Search"],button[class*="search"]');
    const menu=document.querySelector('[aria-label*="menu" i],button[class*="burger"]');
    const a=logo?.getBoundingClientRect(),b=search?.getBoundingClientRect(),c=menu?.getBoundingClientRect();
    const left=Math.max(a?.right||0,c?.right||0)+4;
    if(!a||!b||a.top<0||a.bottom>innerHeight||a.top>120||Math.abs(a.top-b.top)>=40||b.left-left<25)return;
    personalHeader.textContent=shown.text;personalHeader.title=shown.text;
    personalHeader.style.cssText='position:fixed;left:'+left+'px;top:'+a.top+'px;width:'+(b.left-left-4)+'px;height:'+Math.max(16,a.height)+'px;font-size:'+Math.max(8,Math.min(13,(b.left-left-4)/(shown.text.length*.58)))+'px';
    personalHeader.hidden=false;
  }
  let flowHost, roomHost, newsControl, watcherNode, flowRoot;
  function positionFlow(){
    if(!flowHost||!roomHost)return;
    const war=isWarView();
    roomHost.hidden=!war;
    owner.hidden=!war||!order;
    panel.hidden=!war;
    if(!war)flash.hidden=true;
    const hasContent=[flash,attackAlert,guard,watcherNode].some(n=>n&&!n.hidden)||!!extras?.children.length;
    if(!hasContent){flowHost.hidden=true;flowHost.style.setProperty('display','none','important');return;}
    const row=visibleIconRow();
    let anchor=row;
    // Escape fixed-height header wrappers and insert in the normal page flow.
    if(anchor){for(let p=anchor.parentElement;p&&p!==document.body;p=p.parentElement){
      const css=getComputedStyle(p),r=p.getBoundingClientRect();
      if(r.height>360)break;
      if(/^(fixed|absolute|sticky)$/.test(css.position)||/hidden|clip/.test(css.overflowY)||/flex|grid/.test(css.display)||p.clientHeight<p.scrollHeight-2)anchor=p;
    }}
    const main=document.querySelector('#mainContainer,main,.content-wrapper');
    if(anchor?.parentElement && !flowHost.contains(anchor) && !roomHost.contains(anchor) && !/^(fixed|absolute)$/.test(getComputedStyle(anchor.parentElement).position)){
      if(anchor.nextElementSibling!==flowHost)anchor.after(flowHost);
    }else if(main && !flowHost.contains(main) && !/^(fixed|absolute)$/.test(getComputedStyle(main).position)){
      if(main.firstElementChild!==flowHost)main.prepend(flowHost);
    }
    flowHost.hidden=!flowHost.isConnected;
    flowHost.style.setProperty('display',flowHost.hidden?'none':'block','important');

  }

  function renderOps() {
    if(!extras || !opsBox || !flowRoot || !roomHost || !personalHeader)return;
    const personal=ops.personal?.cleared && Date.now()-ops.personal.at>=10000 ? null : ops.personal;
    const lines=[...(ops.instructions || [])];
    if(personal?.cleared)lines.unshift('@'+personal.by+' cleared your order');
    const signal=JSON.stringify([lines,personal?.at,personal?.text]);
    if(signal!==previousSignal){
      const first=previousSignal===null;
      previousSignal=signal;
      extras.replaceChildren(...lines.map(line=>element('div','signal',line)));
      if((lines.length || (personal && !personal.cleared)) && (!first || (personal && Date.now()-personal.at<30000))){
        dismissFlash();flash.replaceChildren(element('small','','WAR DIRECTION'),element('b','command',lines.length?lines.join(' · '):personal.text));showFlash();
      }
    }
    const secs=Math.max(0,Math.ceil(((ops.chain?.endsAt||0)-Date.now())/1000));const timer=ops.chain?.endsAt?Math.floor(secs/60)+':'+String(secs%60).padStart(2,'0'):'--:--';
    const watchers='🔗 '+(ops.chain?.count||0)+' · '+(ops.chain?.count?timer:'Inactive')+' · '+(ops.claim?ops.claim.name+' next':'Unclaimed');
    let watcher=watcherNode;if(!watcher){watcher=watcherNode=element('div','watchers');flowRoot.append(watcher);}
    const slots=ops.watchSlots||{primary:ops.watchers?.[0],secondary:ops.watchers?.[1]};
    const watchSig=JSON.stringify([slots,ops.watcherEnergy,ops.claim,me?.name]);
    const unavailable=Object.values(slots).filter(Boolean).some(name=>{const m=(ops.watcherEnergy||[]).find(v=>v.name===name);return !m?.online || !Number.isFinite(m.energy) || m.energy<25;});
    watcher.classList.toggle('watchWarning',unavailable);
    watcher.hidden=!slots.primary&&!slots.secondary;
    if(watcherSignature!==watchSig||!watcher.firstChild){watcherSignature=watchSig;const heading=element('div','watchTitle');const grid=element('div','watchGrid');for(const [role,name] of Object.entries(slots)){if(!name)continue;const m=(ops.watcherEnergy||[]).find(v=>v.name===name);const card=element('div','watchMember');card.classList.toggle('watchUnavailable',!m?.online||!Number.isFinite(m.energy)||m.energy<25);card.title=!m?.online?'Offline':!Number.isFinite(m.energy)?'Energy unknown':m.energy<25?'Insufficient energy':'Ready';card.append(element('span','watchName',(role==='primary'?'P':'S')+' · '+name),element('span','watchEnergy','⚡'+(m?.energy??'?')+'/'+(m?.maxEnergy??'?')));if(!m?.online)card.append(element('span','watchProblem','OFFLINE'));else if(!Number.isFinite(m.energy)||m.energy<25)card.append(element('span','watchProblem',Number.isFinite(m.energy)?'LOW E':'UNKNOWN E'));if(ops.claim?.name===name)card.append(element('span','claimed','NEXT'));if(name===me?.name){const b=element('button','claim',ops.claim?.name===name?'Release':'Next hit');b.disabled=!!ops.claim&&ops.claim.name!==name;b.onclick=()=>sendAction('claim',ops.claim?.name===name?'Release next hit':'Claim next hit');card.append(b);}grid.append(card);}watcher.replaceChildren(heading,grid);}
    watcher.firstChild.textContent=watchers;
    placePersonal(personal);
    if(isWarView() && personal && !personal.cleared && personalHeader?.hidden){let fallback=extras.querySelector('.personalFallback');if(!fallback){fallback=element('div','signal personalFallback');extras.prepend(fallback);}fallback.textContent=personal.text;}else extras.querySelector('.personalFallback')?.remove();
    positionFight();positionFlow();
    if(roomTabs){const selected=roomTabs.querySelector('.selected')?.dataset.tab;assignments.hidden=!me?.leader||selected!=='Orders';opsBox.hidden=selected!=='Energy';leaders.hidden=!me?.leader||selected!=='Orders';for(const label of ['Orders','Watch']){const b=roomTabs.querySelector('[data-tab="'+label+'"]');if(b)b.hidden=!me?.leader||(label==='Watch'&&!ops.warActive);}}
    watchSection.hidden=!me?.leader || !ops.warActive || (roomTabs && roomTabs.querySelector('.selected')?.dataset.tab!=='Watch');
    if(guard){const id=new URLSearchParams(location.search).get('user2ID');const inside=order?.text==='INSIDE HITS ONLY'||(ops.instructions||[]).some(x=>x.startsWith('INSIDE HITS ONLY'));guard.hidden=!(currentPage()==='Attack' && inside && ops.warActive && ops.enemyRosterFresh && id && !(ops.enemyIds||[]).includes(id));}
    positionFlow();
    if(!panel.open)return;
    if(me?.leader){
    options(recipient,(['Assign watcher','Remove watcher','Clear personal order'].includes(memberCommand.value)?ops.members||[]:ops.available||[]).map(n=>[n,n]));
    const before=watchList.dataset.options;
    options(watchList,(ops.enemies || []).map(m=>[m.id,m.name+(m.online?' · online':'')]));
    if(before!==watchList.dataset.options)for(const o of watchList.options)o.selected=(ops.watchIds || []).includes(o.value);
    const list=[['','Unassigned'],...(ops.members||[]).map(n=>[n,n])];options(primarySelect,list);options(secondarySelect,list);const slotKey=JSON.stringify(ops.watchSlots||{});if(slotSignature!==slotKey){slotSignature=slotKey;primarySelect.value=ops.watchSlots?.primary||'';secondarySelect.value=ops.watchSlots?.secondary||'';}
    const records=Array.isArray(ops.assignments)?ops.assignments:[];const key=JSON.stringify(records);if(activeOrders.dataset.key!==key){activeOrders.dataset.key=key;activeOrders.replaceChildren(element('h4','','Current individual orders · '+records.length));if(!records.length)activeOrders.append(element('p','','No active individual orders'));for(const r of records){const line=element('div','orderLine');const info=element('div','');info.append(element('b','',r.name),element('span','',r.text));const clear=element('button','','Clear');clear.onclick=()=>sendAction('member','Clear personal order',r.name);line.append(info,clear);activeOrders.append(line);}}
    }
    const members=ops.resources || [], now=Date.now();
    const fresh=members.filter(m=>Number.isFinite(m.energy)&&now-m.at<=90000);
    const ready=fresh.filter(m=>m.online && /^(ok|okay)$/i.test(m.status));
    const sum=list=>list.reduce((n,m)=>n+m.energy,0);
    const label='👥 '+online.length+' · ⚡ '+sum(fresh.filter(m=>m.online))+'E online · '+sum(ready)+'E ready';
    if(roomTabs)roomTabs.dataset.energy=label;
    opsBox.firstChild.textContent=label;
    const sig=JSON.stringify([members,ready.length,Math.floor(now/5000)]);
    if(sig===opsKey)return;opsKey=sig;
    const readings=opsBox.lastChild;
    const delta=t=>elapsed(now-Math.max(0,t-now));
    const totals=element('div','energyTotals');for(const [name,value] of [['Online E',sum(fresh.filter(m=>m.online))],['Ready E',sum(ready)],['Fresh',fresh.filter(m=>m.online).length+'/'+members.filter(m=>m.online).length]]){const cell=element('div','energyTotal');cell.append(element('small','',name),element('b','',String(value)));totals.append(cell);}
    const table=element('div','energyTable');const header=element('div','energyRow energyHead');for(const name of ['Member','⚡ Energy','♥ HP','Booster'])header.append(element('span','',name));table.append(header);
    for(const m of members.filter(m=>m.online).sort((a,b)=>(b.energy??-1)-(a.energy??-1))){
      const stale=!m.at||now-m.at>90000;const row=element('div','energyRow');const person=element('div','energyPerson');person.append(element('b','',m.name),element('small','',stale?'No fresh data':m.status||'Unknown'));row.append(person,element('span','',stale?'—':m.energy+'/'+(m.maxEnergy??'?')),element('span','',stale?'—':String(m.life??'?')),element('span','',stale||m.boosterUntil==null?'—':m.boosterUntil<=now?'Ready':delta(m.boosterUntil)));table.append(row);
      if(!stale&&m.destination&&m.destination!=='Torn')table.append(element('div','energyTravel','↳ '+m.destination+(m.landAt?' · '+new Date(m.landAt).toLocaleTimeString():'')));
    }
    readings.replaceChildren(totals,table);

  }
  function mount() {
    const host = document.createElement('div');
    host.style.cssText='display:block;position:relative;width:100%;min-width:0;box-sizing:border-box;margin:8px 0;clear:both';
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
    style.textContent += `
      :host{font:14px/1.4 system-ui;color:#f4f6f7} *{box-sizing:border-box}
      details{max-width:none;border-radius:4px;background:#20262a;padding:0}
      summary{padding:11px 12px;font-weight:650;background:#333a3e}
      .banner,.flash{background:#ffd46a;color:#211900;border-left:6px solid #ef9128;padding:10px 13px;line-height:1.25}
      .banner small,.flash small{display:block;font-size:10px;letter-spacing:.12em;font-weight:800}
      .command{display:block;font-size:clamp(20px,5vw,30px);margin:4px 0;overflow-wrap:anywhere}
      .issued,.issued .age{font-size:12px;color:#423111}
      .flash{display:block;width:100%;background:rgba(255,212,106,.5);border:0;border-left:6px solid rgba(239,145,40,.5);border-radius:0;text-align:left;cursor:pointer;color:white;text-shadow:0 1px 2px #000,0 0 3px #000}
      .flash.anchored{position:fixed;z-index:2147483646;left:0;right:0}
      .flash:focus-visible{outline:2px solid white;outline-offset:-2px}
      h4{margin:0 0 6px;font-size:13px}.roster,.feed,.controls{margin:10px 12px}
      .people{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(auto-fit,minmax(105px,1fr));gap:4px}
      .people li{padding:4px 6px;background:#30393e;border-radius:3px;overflow-wrap:anywhere}
      .people li:before{content:'●';color:#87d6a2;margin-right:6px}
      .feed{max-height:32vh;overflow:auto}.fight{border-top:1px solid #465057;padding:7px 0;display:grid;grid-template-columns:1fr auto;gap:2px 8px}
      .age{font:12px system-ui;color:#becbd3;font-variant-numeric:tabular-nums}
      .fighters{grid-column:1/-1;overflow-wrap:anywhere}.live{color:#ffcd65}.result{color:#d7e9f0}
      .controls{display:flex;gap:5px;flex-wrap:wrap}button.news{margin:0 12px 10px}
    `;
    style.textContent+=`
      .signal{padding:8px 12px;background:#63471b;color:#fff3cd;font-weight:750}.watchers,.reading{padding:5px 10px;background:#253038;color:#ecf2f5}
      .fightAlert{z-index:2147483645;left:0;right:0;width:100%;background:#263944eb;color:white;padding:6px 10px;border:0;border-radius:0;text-align:left;font-size:12px}
      .roomNav{display:flex;gap:3px;padding:6px;background:#171e22}.roomNav button{flex:1;min-width:0;padding:6px 2px;font-size:11px;border-color:#43535c}.roomNav button.selected{background:#45616a;color:#fff}.roomContent{padding:6px;min-height:54px}.roomContent .headcount,.roomContent .assignments{margin:0;border:0;background:transparent}.roomContent .headcount>summary,.roomContent .assignments>summary{display:none}.roomContent .roster,.roomContent .feed,.roomContent .controls{margin:3px}.watchers{border:1px solid #50616a;border-radius:5px;margin:4px 0;padding:6px!important}.watchTitle{font-weight:700}.watchMember{padding:3px 0}.roomContent .controls{display:flex;flex-direction:column;align-items:stretch;padding:10px;border:1px solid #43535c;border-radius:5px;background:#252f35;margin:0 0 9px}.roomContent .controls h4,.orderGroup h4,.activeOrders h4,.assignments h4{color:#d5e0e5;font-size:12px;letter-spacing:.035em;margin:0 0 7px}.roomContent .assignments{padding:10px;border:1px solid #43535c;border-radius:5px;background:#252f35}.assignments select,.assignments button{max-width:100%;margin:3px 0}.assignments>select{width:100%}.orderGroup,.activeOrders{border-top:1px solid #43535c;margin-top:12px;padding-top:10px}.orderGroup label{display:block;font-size:11px;color:#b8c8ce}.orderGroup select{display:block;width:100%}.orderLine{display:flex;align-items:center;justify-content:space-between;gap:5px;padding:6px 0;border-bottom:1px solid #39464d}.orderLine span{display:block;font-size:11px;color:#e8c780}.watchGrid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px;margin-top:6px}.watchMember{display:flex;flex-direction:column;gap:3px;background:#182329;border:1px solid #40535e;border-radius:4px;padding:6px!important;overflow-wrap:anywhere}.watchMember small{color:#a9bbc6;font-size:9px;letter-spacing:.06em}.watchMember .claim{margin:2px 0 0;width:100%;pointer-events:auto}.claimed{color:#91d18b;font-size:10px;font-weight:700}.hpgrid{display:grid;grid-template-columns:1fr 1fr;gap:8px}.hpbar{height:5px;background:#a74040;border-radius:3px;overflow:hidden}.hpfill{height:100%;background:#77c75a}.hplabel{font-size:11px;overflow-wrap:anywhere}.claim{pointer-events:auto;margin-left:5px;font-size:11px;padding:3px}.watchers{font-size:11px}.personalHeader{z-index:2147483647;color:#ffe194;background:#252525;display:flex;align-items:center;justify-content:center;text-align:center;line-height:1;overflow:hidden;pointer-events:none}.tabrow{display:flex;gap:4px;padding:4px}.tabrow button{flex:1;font-size:12px;padding:4px}.people{grid-template-columns:1fr!important}.people li{padding:2px 5px!important}.member{background:transparent;border:0;color:inherit;padding:2px}.headcount,.assignments,.share{margin:7px}.assignments select,.assignments button{margin:3px;max-width:96%}
    `;
    style.textContent+=`\n.watchers{margin:2px 0;padding:3px 5px!important;border-radius:3px;font-size:11px}.watchTitle{font-size:11px;line-height:15px}.watchGrid{gap:4px;margin-top:2px}.watchMember{display:flex;flex-direction:row;flex-wrap:wrap;align-items:center;gap:3px 5px;padding:3px!important;min-width:0}.watchName{font-weight:650;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}.watchEnergy{white-space:nowrap;color:#d0dce0}.watchMember .claim{width:auto;margin:0;padding:2px 5px;line-height:14px;font-size:10px}.signal{padding:3px 6px;font-size:11px}.flash{position:static!important;padding:4px 6px;background:#5d4b28;color:#fff;text-shadow:none}.flash .command{font-size:12px;margin:1px 0}.flash small{font-size:9px}.fightAlert{position:static!important;padding:4px 6px}.banner{padding:5px 8px}.banner .command{font-size:15px}.banner small{font-size:9px}.issued{font-size:10px}.personalHeader{white-space:nowrap;background:transparent;text-overflow:ellipsis}`;
    style.textContent+=`
    .watchWarning{border-color:#e06868!important;animation:fwPulse 1.8s ease-in-out infinite}.watchUnavailable{border-color:#a95757}.watchProblem{font-size:9px;color:#ff9b9b;font-weight:700}@keyframes fwPulse{50%{box-shadow:inset 0 0 9px #c54a4a99}}@media(prefers-reduced-motion:reduce){.watchWarning{animation:none;box-shadow:inset 0 0 5px #c54a4a}}
    .energyTotals{display:grid;grid-template-columns:repeat(3,1fr);gap:4px;margin-bottom:6px}.energyTotal{padding:6px;background:#26363d;border-radius:4px;display:flex;flex-direction:column;text-align:center}.energyTotal small{font-size:10px;color:#b5c6cc}.energyTotal b{font-size:16px;color:#d5eadb}.energyRow{display:grid;grid-template-columns:minmax(0,1.3fr) minmax(0,1fr) minmax(0,.8fr) minmax(0,.9fr);gap:4px;align-items:center;border-bottom:1px solid #39464d;padding:6px 3px;font-size:11px;font-variant-numeric:tabular-nums}.energyRow>span{text-align:right;overflow-wrap:anywhere}.energyHead{font-size:10px;color:#aebfc6}.energyPerson{min-width:0;overflow-wrap:anywhere}.energyPerson small{display:block;font-size:10px;color:#a8b9bf}.energyTravel{font-size:10px;padding:2px 4px;color:#a8b9bf}
    `;
    panel = document.createElement('details');
    title = document.createElement('summary');
    panel.open=true;
    output=element('section','feed');
    owner=element('aside','banner'); owner.hidden=true; owner.setAttribute('aria-live','polite');
    flash=element('button','flash');flash.type='button';flash.hidden=true;flash.title='Dismiss new order alert';flash.setAttribute('aria-live','assertive');flash.onclick=dismissFlash;
    presence=element('section','roster');
    leaders=element('div','controls');
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
    send.onclick=async()=>{send.disabled=true;try{await sendAction('global',directive.value,target.value);}finally{send.disabled=false;}};
    leaders.append(element('h4','','Global orders'),directive,target,send,notice);
    const news = document.createElement('button');
    news.className='news';
    fillTargets();
    panel.ontoggle = () => {if(panel.open) fillTargets(); render();};
    const onlineTab=element('details','');onlineTab.append(element('summary','','👥 Members & energy'));rosterTabs=element('div','rosterTabs');const tabs=element('div','tabrow');const peopleButton=element('button','','👥 Online');const energyButton=element('button','','⚡ Energy');peopleButton.onclick=()=>{presence.hidden=false;opsBox.hidden=true;};energyButton.onclick=()=>{if(me?.leader){presence.hidden=true;opsBox.hidden=false;opsBox.open=true;}};tabs.append(peopleButton,energyButton);rosterTabs.append(tabs,presence);onlineTab.append(rosterTabs);
    const globalTab=element('details','');globalTab.append(element('summary','','Global orders'),leaders);
    panel.append(title,onlineTab,globalTab,output,news);
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
    attackAlert=element('button','fightAlert');attackAlert.hidden=true;attackAlert.onclick=()=>{fightUntil=0;attackAlert.hidden=true;};
    extras=element('div','signals');
    buildOps();
    guard=element('aside','banner','CHAIN BONUS WARNING · Outside target. Return to the faction war and select an enemy.');guard.hidden=true;guard.setAttribute('role','alert');
    roomTabs=element('div','roomTabs');const pages=[['Online',presence],['Energy',opsBox],['Orders',leaders,assignments],['Watch',watchSection]];const bar=element('div','roomNav');const content=element('div','roomContent');let active='Online';function choose(name){active=name;for(const [label,...nodes] of pages){for(const n of nodes)n.hidden=label!==name;const b=bar.querySelector('[data-tab="'+label+'"]');if(b)b.classList.toggle('selected',label===name);}if(name==='Energy')opsBox.open=true;if(name==='Orders')assignments.open=true;if(name==='Watch')watchSection.open=true;render();}for(const [label,...nodes] of pages){const b=element('button','',label);b.dataset.tab=label;b.onclick=()=>choose(label);bar.append(b);for(const n of nodes)content.append(n);}roomTabs.append(bar,content);panel.insertBefore(roomTabs,news);onlineTab.remove();globalTab.remove();output.remove();
    personalHeader=element('div','personalHeader');personalHeader.hidden=true;const overlay=document.createElement('div');overlay.style.cssText='position:fixed;inset:0;z-index:2147483647;pointer-events:none';const overlayRoot=overlay.attachShadow({mode:'closed'});overlayRoot.append(style.cloneNode(true),personalHeader);document.documentElement.append(overlay);root.append(style,owner,panel);roomHost=host;flowHost=document.createElement('div');flowHost.id='fw-inline-status';flowHost.style.cssText='display:block;position:static;width:100%;min-width:0;min-height:0;height:auto;flex:none;box-sizing:border-box;clear:both;overflow:visible';flowRoot=flowHost.attachShadow({mode:'closed'});flowRoot.append(style.cloneNode(true),flash,attackAlert,guard,extras);
    if(location.pathname==='/factions.php')layout(host,news);else {news.hidden=true;panel.hidden=true;}choose('Online');positionFlow();
    let scheduled=false;const observer=new MutationObserver(()=>{if(scheduled)return;scheduled=true;requestAnimationFrame(()=>{scheduled=false;positionFlow();});});observer.observe(document.body,{childList:true,subtree:true});window.addEventListener('hashchange',()=>{positionFlow();renderOps();});
    window.addEventListener('resize',()=>{headerRect=null;placePersonal(ops.personal);});
    let headerFrame=0;window.addEventListener('scroll',()=>{if(!headerFrame)headerFrame=requestAnimationFrame(()=>{headerFrame=0;placePersonal(ops.personal);});},true);
    setInterval(()=>{if(document.hidden)return;positionFight();renderOps();for(const time of [...root.querySelectorAll('time[data-stamp]'),...flowRoot.querySelectorAll('time[data-stamp]')]) {if(time.getClientRects().length) time.textContent=elapsed(Number(time.dataset.stamp))+' ago';}},1000);
    render();
  }
  function initialize(){mount();connect();}
  if (document.body) initialize(); else document.addEventListener('DOMContentLoaded',initialize,{once:true});
})();
