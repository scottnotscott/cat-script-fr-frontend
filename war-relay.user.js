// ==UserScript==
// @name         Feudal World War Relay
// @namespace    scottnotscott.feudalworld
// @version      0.7.0
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
  const sentObservations = new Map();
  const RELAY_URL = 'ws://100.103.255.117:8787/relay';
  const TORN_API_KEY = '###PDA-APIKEY###';
  const validKey = value => /^[a-zA-Z0-9]{16}$/.test(value);
  let key = validKey(TORN_API_KEY) ? TORN_API_KEY : '';
  let retry;
  let revision, me, order, rosterAt = 0, online = [], leaders, target, directive, presence, owner, notice;
  const candidates = new Map();
  const commands = ['EVERYONE TURTLE','EVERYONE PILE ON','DRAG CHAIN OUT','AIMING FOR 1k CHAIN','INSIDE HITS ONLY','Clear order','BUILD CHAIN','CHAIN DENIAL, HOSP ONLINERS'];
  let ops={}, share=false, nextIntel=0, chainObservation=null, opsBox, assignments, recipient, memberCommand, watchList, extras, attackAlert, shareButton;
  let previousFights=null, fightUntil=0, selectedFight=null, previousSignal=null;
  try {share=localStorage.getItem('fw.shareReadiness')==='yes';} catch {}
  const endpoint = path => RELAY_URL.replace(/^ws/,'http').replace('/relay',path);
  async function refreshIntel(){
    if(Date.now()<nextIntel || (!sessionToken && !authenticated))return;
    nextIntel=Date.now()+30000;
    if(authenticated){socket.send(JSON.stringify({type:'intel',key,share}));return;}
    try { await postNative(endpoint('/intel'),'Bearer '+sessionToken,{}, {'X-Torn-Key':key,'X-Share':share?'yes':'no'}); } catch {}
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
    const signatures=new Map(recent.map(a=>[a.id,JSON.stringify([a.result,a.live,a.attackerLife,a.defenderLife])]));
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
      if (r.width>80 && r.height>8 && r.height<100 && r.bottom>0 && r.top<innerHeight/2 && r.right>0 && r.left<innerWidth) return node;
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
    flash.hidden=false;
    let row, frame, searchAfter=0;
    function place() {
      frame=0;
      if (!row?.isConnected || !row.getClientRects().length) {
        if(performance.now()>=searchAfter){row=visibleIconRow();searchAfter=performance.now()+400;}
      }
      const r=row?.getBoundingClientRect();
      const safe=r && r.height>0 && r.bottom>0 && r.bottom<innerHeight-65 && r.right>0 && r.left<innerWidth;
      flash.classList.toggle('anchored',Boolean(safe));
      if(safe) flash.style.top=Math.ceil(r.bottom)+'px';
    }
    function schedule(){if(!frame)frame=requestAnimationFrame(place);}
    place();
    const timer=setInterval(schedule,400);
    window.addEventListener('scroll',schedule,true);
    window.addEventListener('resize',schedule);
    stopTracking=()=>{clearInterval(timer);cancelAnimationFrame(frame);window.removeEventListener('scroll',schedule,true);window.removeEventListener('resize',schedule);stopTracking=()=>{};};
    flashTimer=setTimeout(dismissFlash,10000);
  }
  function render() {
    if (!title) return;
    title.textContent = 'War room · '+(me ? me.name+' · '+me.role+' · '+status : status);
    title.title=status;
    const signature=JSON.stringify(order || null);
    if (signature!==lastOrder) {
      lastOrder=signature;
      owner.hidden=!order;
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
    leaders.hidden=!me?.leader;
    const rosterKey=JSON.stringify([online,rosterAt,me?.leader]);
    if (rosterKey!==lastRoster) {
      lastRoster=rosterKey;
      const grid=element('ul','people');
      for (const name of [...online].sort((a,b)=>a.localeCompare(b))) {
        const cell=element('li','','');
        if(me?.leader){const b=element('button','member',name);b.onclick=()=>{recipient.value=name;assignments.open=true;assignments.scrollIntoView({block:'nearest'});};cell.append(b);}
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
        item.append(element('b',r.live?'live':'result',r.live?'LIVE FIGHT':r.result || (r.finished?'Outcome unavailable':'Observed')),clock(r.sampleAt || r.at));
        const fighter=(name,life)=> (name && name!=='0'?name:'Unknown') + (r.live?' (last HP '+(life??'?')+')':'');
        item.append(element('div','fighters',fighter(r.attacker,r.attackerLife)+' → '+fighter(r.defender,r.defenderLife)));
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
      const res = await post('/sync', 'Bearer ' + sessionToken, {attacks:batch,revision,delta:true,chain:chainObservation});
      if (Number(res.status) === 401) sessionToken = null;
      if (Number(res.status) !== 200) throw Error('Sync HTTP ' + (res.status || 0));
      const data = JSON.parse(res.responseText);
      if (!data.unchanged) { accept(data); revision = data.revision; }
      if (rosterAt && Date.now()-rosterAt > 45000) await postNative(base+'/roster','Bearer '+sessionToken,{}, {'X-Torn-Key':key});
      for (const row of batch) if (pending.get(row.id) === row) pending.delete(row.id);
      void refreshIntel();
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
    socket.onopen = () => socket.send(JSON.stringify({type:'auth',delta:true, key}));
    socket.onmessage = e => {
      let data;
      try { data = JSON.parse(e.data); } catch { return; }
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
    if(own && count!=null && Number.isSafeInteger(Number(count)))chainObservation={count:Number(count),at:sampleAt};
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
        const report={id,sampleAt,result:typeof r.result === 'string' ? r.result : '',attackerLife:live ? life(aid) : null,defenderLife:live ? life(did) : null,pair,live,finished:!live,at:time > 1e12 ? time : time*1000,attacker:label(aid,r.attackerName ?? r.attacker),defender:label(did,r.defenderName ?? r.defender)};
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
  function positionFight() {
    if(!attackAlert)return;
    attackAlert.hidden=!selectedFight || Date.now()>=fightUntil;
    if(attackAlert.hidden)return;
    const a=selectedFight;
    const fighter=(name,hp)=> (name && name!=='0'?name:'Unknown')+(a.live?' · HP '+(hp??'?'):'');
    attackAlert.textContent=(a.live?'LIVE':a.result || 'Attack ended')+'   '+fighter(a.attacker,a.attackerLife)+' → '+fighter(a.defender,a.defenderLife)+' · '+elapsed(a.sampleAt || a.at)+' ago';
    const bar=visibleIconRow()?.getBoundingClientRect();
    attackAlert.style.position=bar?'fixed':'relative';
    attackAlert.style.top=bar?Math.ceil(Math.max(bar.bottom,flash.hidden?0:flash.getBoundingClientRect().bottom))+'px':'';
  }
  async function sendAction(scope,command,target,ids) {
    const payload={type:'order',scope,command,target,ids};
    try {
      if(authenticated)socket.send(JSON.stringify(payload));
      else {
        const r=await postNative(endpoint('/order'),'Bearer '+sessionToken,payload);
        if(Number(r.status)!==200)throw Error();
      }
      notice.textContent=' Sent';
    } catch {notice.textContent=' Order refused or relay offline';}
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
    shareButton=element('button','share');
    shareButton.onclick=()=>{share=!share;try{localStorage.setItem('fw.shareReadiness',share?'yes':'no');}catch{}nextIntel=0;void refreshIntel();renderOps();};
    opsBox=element('details','headcount');
    opsBox.append(element('summary','','Energy headcount'),element('div','readings'));
    assignments=element('details','assignments');
    assignments.append(element('summary','','Member orders and chain watch'));
    recipient=element('select','');recipient.setAttribute('aria-label','Faction member');
    memberCommand=element('select','');
    options(memberCommand,['SIT ABROAD (CLOSE)','SIT ABROAD (FAR)','TURTLE','OUTSIDE HITS ONLY','INSIDE HITS ONLY','BUILD CHAIN','Clear personal order','Assign watcher','Remove watcher'].map(s=>[s,s]));
    const issue=element('button','','Apply to member');
    issue.onclick=()=>sendAction('member',memberCommand.value,recipient.value);
    watchList=element('select','');watchList.multiple=true;watchList.size=4;
    const enable=element('button','','Build chain · watch selected');
    enable.onclick=()=>sendAction('watch','Watch enemies','',[...watchList.selectedOptions].map(o=>o.value));
    const disable=element('button','','Stop enemy watch');disable.onclick=()=>sendAction('watch','Stop watching enemies');
    assignments.append(recipient,memberCommand,issue,element('h4','','Watch for online opponents'),watchList,enable,disable);
    panel.insertBefore(opsBox,output);panel.insertBefore(assignments,output);panel.append(shareButton);
  }
  let opsKey='';
  function renderOps() {
    if(!extras || !opsBox)return;
    const personal=ops.personal;
    const lines=[...(ops.instructions || [])];
    if(personal)lines.unshift('@'+personal.by+(personal.cleared?' cleared your order':' has issued you an order: '+personal.text));
    const signal=JSON.stringify([lines,personal?.at]);
    if(signal!==previousSignal){
      const first=previousSignal===null;
      previousSignal=signal;
      extras.replaceChildren(...lines.map(line=>element('div','signal',line)));
      if(lines.length && (!first || (personal && Date.now()-personal.at<30000))){
        dismissFlash();flash.replaceChildren(element('small','','WAR DIRECTION'),element('b','command',lines.join(' · ')));showFlash();
      }
    }
    const watchers='Chain watchers: '+((ops.watchers || []).join(', ') || 'unassigned');
    let watcher=extras.querySelector('.watchers');if(!watcher){watcher=element('div','watchers');extras.append(watcher);}watcher.textContent=watchers;
    positionFight();
    opsBox.hidden=assignments.hidden=!me?.leader;
    shareButton.textContent=share?(Date.now()-(ops.sampleAt || 0)<90000?'Sharing energy, booster & travel · Turn off':'Sharing enabled · waiting for a limited-key reading'):'Share my energy, booster & travel with leaders';
    if(!me?.leader || !panel.open)return;
    options(recipient,(ops.members || []).map(n=>[n,n]));
    const before=watchList.dataset.options;
    options(watchList,(ops.enemies || []).map(m=>[m.id,m.name+(m.online?' · online':'')]));
    if(before!==watchList.dataset.options)for(const o of watchList.options)o.selected=(ops.watchIds || []).includes(o.value);
    const members=ops.resources || [], now=Date.now();
    const fresh=members.filter(m=>Number.isFinite(m.energy)&&now-m.at<=90000);
    const ready=fresh.filter(m=>m.online && m.status==='Okay');
    const sum=list=>list.reduce((n,m)=>n+m.energy,0);
    const label='Energy · '+sum(ready)+'E online & Okay · '+fresh.length+'/'+members.length+' fresh';
    opsBox.firstChild.textContent=label;
    const sig=JSON.stringify([members,ready.length,Math.floor(now/5000)]);
    if(sig===opsKey)return;opsKey=sig;
    const readings=opsBox.lastChild;
    const delta=t=>elapsed(now-Math.max(0,t-now));
    readings.replaceChildren(element('p','','Reported total: '+sum(fresh)+'E · readings older than 1:30 excluded'));
    for(const m of members.filter(m=>m.at).sort((a,b)=>b.energy-a.energy)){
      readings.append(element('div','reading',m.name+' · '+m.energy+'E · '+m.status+
        ' · booster '+(m.boosterUntil==null?'unknown':m.boosterUntil<=now?'ready':delta(m.boosterUntil))+
        (m.landAt?' · '+m.destination+' ETA '+new Date(m.landAt).toLocaleTimeString():m.destination?' · '+m.destination:'')+
        ' · seen '+elapsed(m.at)+' ago'));
    }
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
      .member{background:transparent;border:0;color:inherit;padding:2px}.headcount,.assignments,.share{margin:7px}.assignments select,.assignments button{margin:3px;max-width:96%}
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
    news.className='news';
    fillTargets();
    panel.ontoggle = () => {if(panel.open) fillTargets(); render();};
    panel.append(title,presence,leaders,output,news);
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
    root.append(style,flash,attackAlert,owner,extras,panel);
    layout(host,news);
    setInterval(()=>{if(document.hidden)return;positionFight();for(const time of root.querySelectorAll('time[data-stamp]')) {if(time.getClientRects().length) time.textContent=elapsed(Number(time.dataset.stamp))+' ago';}},1000);
    render();
  }
  connect();
  if (document.body) mount(); else document.addEventListener('DOMContentLoaded',mount,{once:true});
})();
