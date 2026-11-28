// ==UserScript==
// @name         Feudal World War Relay
// @namespace    scottnotscott.feudalworld
// @version      0.9.28
// @match        https://www.torn.com/*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      167.114.182.109
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
  if(!key){try{const saved=sessionStorage.getItem('fw.relay.key');if(validKey(saved))key=saved;}catch{}}
  let signedIn=false, loginForm, connectionNote;
  let retry;
  let revision, me, order, rosterAt = 0, online = [], leaders, target, directive, presence, owner, notice;
  const candidates = new Map();
  const commands = ['EVERYONE TURTLE','EVERYONE PILE ON','DRAG CHAIN OUT','AIM->1k CHAIN','INSIDE HITS ONLY','Clear order','BUILD CHAIN','CHAIN DENIAL - HOSP ONLINERS'];
  let ops={}, nextIntel=0, chainObservation=null, opsBox, assignments, recipient, memberCommand, watchList, extras, attackAlert, shareButton;
  let previousFights=null, fightUntil=0, selectedFight=null, previousSignal=null;
  const dismissedFights=new Map();

  const endpoint = path => RELAY_BASE+path;
  const activityHints=new Set();let hintTimer;
  function hintActivity(url,method){try{const u=new URL(String(url),location.href);if(u.origin!==location.origin)return;const path=(u.pathname+' '+u.search+' '+location.pathname+' '+location.search).toLowerCase();if(String(method).toUpperCase()!=='POST')return;for(const [category,pattern] of [['Gym',/gym/],['Racing',/racing|race/],['Armoury',/armou?ry|item\.php|itemuse/],['Attacks',/attack/]])if(pattern.test(path))activityHints.add(category);if(activityHints.size&&!hintTimer)hintTimer=setTimeout(()=>{hintTimer=null;void refreshIntel();},2500);}catch{}}
  async function refreshIntel(){
    if(Date.now()<nextIntel || (!sessionToken && !authenticated))return;
    const hints=[...activityHints];activityHints.clear();
    nextIntel=Date.now()+30000;
    if(authenticated){socket.send(JSON.stringify({type:'intel',key,hints}));return;}
    try { await postNative(endpoint('/intel'),'Bearer '+sessionToken,{}, {'X-Torn-Key':key,'X-Activity-Hints':hints.join(',')}); } catch {}
  }
  let titleLabel;
  let orderHistory=[],primaryDuration,secondaryDuration,orderHistoryBox,inlineOrder,takeoverDialog;
  let detailedActivity=null, ownActivityPreferences={}, activityLoading=false, activityRequest=0;
  const activityCategories=['Racing','Gym','Attacks','Armoury'];
  let sharedMembers=[], activityDialog, activityId, activityTab='Pages', activitySignature='', personalInline;
  function accept(data) {
    if(data.badges)rankBadges=data.badges;
    if(Array.isArray(data.members))sharedMembers=data.members;if(Array.isArray(data.orderHistory))orderHistory=data.orderHistory;
    ops=data.ops || {};
    if(Array.isArray(data.attackChanges)){
      const entries=new Map(feed.map(a=>[a.id,a]));
      for(const id of data.removedAttacks || [])entries.delete(id);
      for(const a of data.attackChanges)entries.set(a.id,a);
      data.attacks=[...entries.values()].sort((a,b)=>b.at-a.at);
    }
    const recent=data.attacks || [];
    const now=Date.now();
    const signatures=new Map(recent.map(a=>[a.id,JSON.stringify([a.result,a.live,a.attackerLife,a.defenderLife,a.attackerMax,a.defenderMax,a.respect])]));
    for(const [id,stamp] of dismissedFights)if(now-stamp>120000)dismissedFights.delete(id);
    const live=recent.filter(a=>a.live&&now-(a.sampleAt||a.at)<25000&&!dismissedFights.has(a.id)).sort((a,b)=>(b.sampleAt||b.at)-(a.sampleAt||a.at));
    // Live fights are independent of chain count, war state and watcher assignments.
    if(live.length){selectedFight=live[0];fightUntil=(selectedFight.sampleAt||selectedFight.at)+25000;}
    else if(previousFights){
      const changed=recent.filter(a=>!a.live&&signatures.get(a.id)!==previousFights.get(a.id)&&now-(a.sampleAt||a.at)<15000);
      if(changed.length){selectedFight=changed.sort((a,b)=>b.at-a.at)[0];fightUntil=now+5000;}
      else if(selectedFight?.live)fightUntil=0;
    }
    previousFights=signatures;
    me = data.me; order = data.order; online = data.online || []; rosterAt = data.rosterAt || 0;
    feed = data.attacks || [];
  }
  function metricAge(stamp){return Number(stamp)>0?elapsed(stamp)+' ago':'Unknown';}
  function metricCooldown(until){if(until==null||!Number.isFinite(Number(until)))return 'Unknown';const n=Math.max(0,Math.ceil((Number(until)-Date.now())/1000));return n===0?'Ready':n>=3600?Math.floor(n/3600)+'h '+Math.floor(n%3600/60)+'m':Math.floor(n/60)+':'+String(n%60).padStart(2,'0');}
  function metricHits(m){return Number.isFinite(m?.energy)?String(Math.max(0,Math.floor(m.energy/25))):'?';}
  function metricHP(m){return m?.life==null?'?':String(m.life)+'/'+(m.maxLife??'?');}
  function liveMetric(kind,value,prefix){const n=element('span','metricAge');n.dataset.metric=kind;n.dataset.value=value??'';n.dataset.prefix=prefix;n.textContent=prefix+(kind==='cooldown'?metricCooldown(value):metricAge(value));return n;}
  function refreshMetrics(root){for(const n of root.querySelectorAll('[data-metric]')){const v=n.dataset.value===''?null:Number(n.dataset.value);n.textContent=n.dataset.prefix+(n.dataset.metric==='cooldown'?metricCooldown(v):metricAge(v));}}
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
  function roomView(){return true;}
  function presenceDot(state){const d=element('span','presenceDot '+(state||'offline'),'●');d.title=state||'offline';d.setAttribute('aria-label',state||'offline');return d;}
  let armouryQuery={kind:'used',xanax:false,page:1},rankBadges={},leaderboardQuery={metric:'strength',period:'month'},leaderboardData=null,leaderboardMode=false;
  async function loadActivity(preferences){
    const id=activityId,request=++activityRequest;const leaderboard=leaderboardMode?leaderboardQuery:undefined;activityLoading=true;activitySignature='';renderActivity();
    try{
      if(authenticated&&socket?.readyState===1){socket.send(JSON.stringify({type:'activity',id,preferences,armoury:armouryQuery,leaderboard}));return;}
      if(!sessionToken)throw Error('Not connected');
      const r=await postNative(endpoint('/activity'),'Bearer '+sessionToken,{id,preferences,armoury:armouryQuery,leaderboard});
      if(Number(r.status)!==200)throw Error('Activity request failed');
      const d=JSON.parse(r.responseText);if(request!==activityRequest)return;detailedActivity=d.activity;leaderboardData=d.leaderboard||null;ownActivityPreferences=d.ownPreferences||{};activityLoading=false;
    }catch{if(request!==activityRequest)return;detailedActivity=null;activityLoading=false;}
    activitySignature='';renderActivity();
  }
  function openActivity(id,name){leaderboardMode=false;activityId=id??name;armouryQuery={kind:'used',xanax:false,page:1};activityTab='Overview';activitySignature='';detailedActivity=null;activityDialog.hidden=false;void loadActivity();}
  function openLeaderboard(){leaderboardMode=true;leaderboardData=null;activityId=sharedMembers.find(m=>m.name===me?.name)?.id;activitySignature='';activityDialog.hidden=false;void loadActivity();}
  function compactStat(n){if(!Number.isFinite(n))return '—';const a=Math.abs(n);return a>=1e9?(n/1e9).toFixed(2).replace(/\.?0+$/,'')+'b':a>=1e6?(n/1e6).toFixed(2).replace(/\.?0+$/,'')+'m':a>=1e3?(n/1e3).toFixed(1).replace(/\.0$/,'')+'k':n.toLocaleString('en-GB',{maximumFractionDigits:2});}
  function statTile(label,value,cls=''){const tile=element('div','statTile');tile.append(element('small','',label),element('strong',cls,value));return tile;}
  function periodNav(body,week){const bar=element('div','periodNav'),prev=element('button','','‹'),next=element('button','','›');prev.title='Previous week';next.title='Next week';prev.onclick=()=>{armouryQuery={...armouryQuery,week:week-604800000};loadActivity();};next.disabled=week+604800000>Date.now();next.onclick=()=>{armouryQuery={...armouryQuery,week:week+604800000};loadActivity();};const fmt=t=>new Date(t).toLocaleDateString('en-GB',{day:'numeric',month:'short',timeZone:'UTC'});bar.append(prev,element('b','',fmt(week)+' – '+fmt(week+6*86400000)+' · TCT'),next);body.append(bar);}
  function gymPanel(body,d,week){periodNav(body,week);if(!d?.base){body.append(element('p','emptyState','No gym readings for this week.'));return;}const keys=['strength','defense','speed','dexterity'],complete=keys.every(k=>Number.isFinite(d.base[k])&&Number.isFinite(d.delta?.[k]));const total=complete?keys.reduce((n,k)=>n+d.base[k],0):null,gain=complete?keys.reduce((n,k)=>n+d.delta[k],0):null;const summary=element('div','statTiles');summary.append(statTile('Starting total stats',compactStat(total)),statTile('Total gains',gain==null?'—':(gain>=0?'+':'')+compactStat(gain),'positive'));body.append(summary);for(const [k,label] of [['strength','Strength'],['defense','Defence'],['speed','Speed'],['dexterity','Dexterity']]){const row=element('div','gymStat'),left=element('div','gymName');left.append(element('b','',label),element('small','','Starting: '+(Number.isFinite(d.base[k])?d.base[k].toLocaleString('en-GB',{maximumFractionDigits:0}):'—')));const g=d.delta?.[k];row.append(left,element('strong',g<0?'negative':'positive',Number.isFinite(g)?(g>=0?'+':'')+compactStat(g):'—'));body.append(row);}const foot=element('div','gymFoot');foot.append(element('span','','Gym energy expenditure'),element('b','',Number.isFinite(d.delta?.gymenergy)?d.delta.gymenergy.toLocaleString('en-GB')+' E':'—'));body.append(foot);if(d.since)body.append(element('small','panelNote','Baseline '+new Date(d.since).toISOString().slice(0,16).replace('T',' ')+' TCT · Stat changes may include non-gym gains.'));}
  function armouryPanel(body,d){const t=d?.xanaxTotals||{},summary=element('div','statTiles');summary.append(statTile('Xanax events',String(t.events??0)),statTile('Known units',String(t.quantity??0),'gold'));body.append(summary);const controls=element('div','roomNav activityNav armouryTabs');for(const [kind,label] of [['donated','Deposited'],['used','Used'],['xanax','Xanax']]){const selected=kind==='xanax'?d?.xanax:!d?.xanax&&d?.kind===kind;const b=element('button',selected?'selected':'',label);b.onclick=()=>{armouryQuery={...armouryQuery,kind:kind==='xanax'?'used':kind,xanax:kind==='xanax',page:1};loadActivity();};controls.append(b);}body.append(controls);body.append(element('small','panelNote','Lifetime recorded history · '+(d?.count??0)+' matching records'));if(t.unknown)body.append(element('small','panelNote',t.unknown+' Xanax events have unknown quantity.'));for(const r of d?.rows||[]){const row=element('div','armouryCard'),symbol=element('span','itemSymbol',r.xanax?'X':'▦'),content=element('div','armouryText');content.append(element('b','',r.xanax?'Xanax':r.text),element('small','',new Date(r.at).toISOString().slice(0,16).replace('T',' ')+' TCT'));if(r.xanax)content.append(element('small','',r.text));row.append(symbol,content);if(r.quantity!=null)row.append(element('strong',r.kind==='donated'?'positive':'gold',(r.kind==='donated'?'+':'−')+r.quantity));body.append(row);}if(!d?.rows?.length)body.append(element('p','emptyState','No recorded armoury activity.'));const pager=element('div','periodNav'),prev=element('button','','Previous'),next=element('button','','Next');prev.disabled=(d?.page||1)<=1;next.disabled=(d?.page||1)>=(d?.pages||1);prev.onclick=()=>{armouryQuery={...armouryQuery,page:d.page-1};loadActivity();};next.onclick=()=>{armouryQuery={...armouryQuery,page:d.page+1};loadActivity();};pager.append(prev,element('small','','Page '+(d?.page||1)+' / '+(d?.pages||1)),next);body.append(pager);}
  function renderLeaderboard(){const heading=element('div','activityHeading');const close=element('button','','Close');close.onclick=()=>{activityDialog.hidden=true;activityRequest++;leaderboardMode=false;};heading.append(element('b','','Faction leaderboard'),close);const controls=element('div','roomNav');const metric=element('select',''),period=element('select','');for(const [v,label] of [['strength','Strength gains'],['defense','Defence gains'],['speed','Speed gains'],['dexterity','Dexterity gains'],['attacks','Outgoing attacks'],['respect','Respect earned'],['xanax','Xanax used/withdrawn'],['raceSkill','Racing skill gains'],['raceWins','Races won'],['activity','Relay active minutes'],['damage','Damage'],['boosters','Boosters used']])metric.add(new Option(label,v));for(const [v,label] of [['month','This month'],['week','This week'],['7d','Last 7 days'],['30d','Last 30 days'],['1y','Last year'],['life','Lifetime recorded']])period.add(new Option(label,v));metric.value=leaderboardQuery.metric;period.value=leaderboardQuery.period;metric.onchange=period.onchange=()=>{leaderboardQuery={metric:metric.value,period:period.value};loadActivity();};controls.append(metric,period);const body=element('div','activityBody');if(activityLoading)body.append(element('p','','Loading rankings…'));else if(!leaderboardData?.rows?.length)body.append(element('p','','No recorded rankings yet'));else for(const r of leaderboardData.rows){const line=element('button','leaderboardRow');const rank=element('strong','rankNumber rank'+r.rank,'#'+r.rank),detail=element('div','rankDetail'),top=element('div','rankingRow');top.append(element('b','',r.name),element('span','',r.value.toLocaleString('en-GB',{maximumFractionDigits:2})));const bar=element('div','rankingTrack'),fill=element('div','rankingFill');fill.style.width=Math.max(0,Math.min(100,100*r.value/Math.max(1,leaderboardData.rows[0].value)))+'%';bar.append(fill);detail.append(top,bar);line.append(rank,detail);line.onclick=()=>openActivity(r.id,r.name);body.append(line);}body.append(element('small','','Based on recorded data; historical coverage may vary.'));activityDialog.replaceChildren(heading,controls,body);}
  function statLines(body,values){for(const [k,v] of Object.entries(values||{})){const row=element('div','activityRow');row.append(element('b','',k.replace(/_/g,' ')),element('span','',typeof v==='number'?v.toLocaleString('en-GB',{maximumFractionDigits:2}):String(v)));body.append(row);}}
  function renderActivity(){
    if(!activityDialog||activityDialog.hidden)return;
    const m=sharedMembers.find(v=>String(v.id)===String(activityId)||v.name===activityId),v=(ops.resources||[]).find(r=>String(r.id)===String(m?.id));
    const signature=JSON.stringify([leaderboardMode,leaderboardQuery,leaderboardData,m?.name,m?.page,m?.presence,activityTab,detailedActivity,activityLoading,activityTab==='Overview'?v:activityTab==='Pages'?m?.visits:activityTab==='Sent'?m?.sent:activityTab==='Received'?m?.received:null]);if(signature===activitySignature)return;activitySignature=signature;
    if(leaderboardMode){renderLeaderboard();return;}
    const heading=element('div','activityHeading');heading.append(element('b','',m?.name||String(activityId)));const close=element('button','','Close');close.onclick=()=>{activityDialog.hidden=true;activityRequest++;};heading.append(close);
    const nav=element('div','roomNav activityNav');for(const tab of ['Overview','Pages','Sent','Received',...activityCategories]){const btn=element('button',tab===activityTab?'selected':'',tab);btn.onclick=()=>{activityTab=tab;renderActivity();};nav.append(btn);}
    const body=element('div','activityBody');
    if(activityTab==='Overview'){body.append(element('p','','Status: '+(m?.presence||'Unknown')+' · '+(m?.page||'Unknown page')),hpBar('HP',v?.life,v?.maxLife,true,!!v?.at&&Date.now()-v.at>90000));statLines(body,{Energy:v?.energy==null?'Unknown':v.energy+'/'+(v.maxEnergy??'?'),Hits:metricHits(v),'Relay heartbeat':metricAge(m?.seenAt),'Torn activity':metricAge(m?.tornLastAt),'Medical cooldown':metricCooldown(v?.medicalUntil),'Booster cooldown':metricCooldown(v?.boosterUntil)});}
    else if(activityTab==='Gym'||activityTab==='Armoury'){if(activityLoading)body.append(element('p','emptyState','Loading activity…'));else if(activityTab==='Gym')gymPanel(body,detailedActivity?.categories?.Gym,detailedActivity?.week||armouryQuery.week||Date.now());else armouryPanel(body,detailedActivity?.categories?.Armoury);}
    else if(activityCategories.includes(activityTab)){const d=detailedActivity?.categories?.[activityTab];if(activityLoading)body.append(element('p','','Loading activity…'));else if(!detailedActivity)body.append(element('p','','Activity unavailable. Check backend version or connection.'));else if(!d)body.append(element('p','','Awaiting first collection while member is connected.'));else{body.append(element('small','',d.lifetime?'Lifetime recorded armoury history':'Week from '+new Date(detailedActivity.week).toISOString().slice(0,10)+' TCT'));if(activityTab==='Armoury'&&d.lifetime){const controls=element('div','roomNav activityNav');for(const [kind,label] of [['used','Used'],['donated','Deposited'],['xanax','Xanax']]){const b=element('button',(kind==='xanax'?d.xanax:!d.xanax&&d.kind===kind)?'selected':'',label);b.onclick=()=>{armouryQuery={...armouryQuery,kind:kind==='xanax'?'used':kind,xanax:kind==='xanax',page:1};loadActivity();};controls.append(b);}body.append(controls);const t=d.xanaxTotals||{};body.append(element('p','','Xanax used/withdrawn: '+(t.events??0)+' recorded events · '+(t.quantity??0)+' known units'+(t.unknown?' · '+t.unknown+' events with unknown quantity':'')));body.append(element('small','',d.count+' matching records'));}if(d.at)body.append(element('p','','Updated '+metricAge(d.at)));if(d.error&&activityTab!=='Armoury')body.append(element('p','',d.error));if(d.since)body.append(element('small','','Baseline: '+new Date(d.since).toISOString().slice(0,16).replace('T',' ')+' TCT'));if(activityTab==='Gym'&&d.base){const prev=element('button','','Previous week'),next=element('button','','Next week');prev.onclick=()=>{armouryQuery={...armouryQuery,week:detailedActivity.week-604800000};loadActivity();};next.disabled=detailedActivity.week+604800000>Date.now();next.onclick=()=>{armouryQuery={...armouryQuery,week:detailedActivity.week+604800000};loadActivity();};body.append(prev,next);const stats=['strength','defense','speed','dexterity'];const total=stats.reduce((n,k)=>n+(d.base[k]||0),0),gain=stats.reduce((n,k)=>n+(d.delta?.[k]||0),0);statLines(body,{'Total at baseline':total,'Total gain':gain});for(const k of stats){if(d.base[k]==null)continue;const line=element('div','rankingRow');line.append(element('b','',k+' '+d.base[k].toLocaleString('en-GB')),element('span','gain',(d.delta?.[k]>=0?'+':'')+(d.delta?.[k]??0).toLocaleString('en-GB',{maximumFractionDigits:2})));body.append(line);}if(d.delta?.gymenergy!=null)statLines(body,{'Gym energy':d.delta.gymenergy});}else if(d.delta)statLines(body,d.delta);if(activityTab==='Racing'&&d.raceSkill!=null)statLines(body,{'Racing skill':d.raceSkill});if(d.totals)statLines(body,d.totals);if(d.partial)body.append(element('small','','Observed API history only; coverage may be incomplete. Damage unavailable.'));if(activityTab==='Gym')body.append(element('small','','Battle stat changes include non-gym gains. Gym energy only when contributor data is available.'));for(const r of d.rows||[]){const line=element('div','activityRow');line.append(element('b','',r.text||r.track||'Race'),element('small','',[r.position!=null?'Position '+r.position:r.status,r.at?new Date(r.at<1e12?r.at*1000:r.at).toISOString().slice(0,16).replace('T',' ')+' TCT':''].filter(Boolean).join(' · ')));body.append(line);}if(!d.rows?.length&&!d.delta&&!d.totals&&!d.error)body.append(element('p','','No records returned'));if(activityTab==='Armoury'&&d.lifetime){const pager=element('div','roomNav');const prev=element('button','','Previous'),next=element('button','','Next');prev.disabled=d.page<=1;next.disabled=d.page>=d.pages;prev.onclick=()=>{armouryQuery={...armouryQuery,page:d.page-1};loadActivity();};next.onclick=()=>{armouryQuery={...armouryQuery,page:d.page+1};loadActivity();};pager.append(prev,element('span','','Page '+d.page+' / '+d.pages),next);body.append(pager);}}}
    else{const rows=activityTab==='Pages'?m?.visits:activityTab==='Sent'?m?.sent:m?.received;for(const r of rows||[]){const line=element('div','activityRow');line.append(element('b','',activityTab==='Pages'?r.page:(activityTab==='Sent'?r.defender:r.attacker)+' · '+outcome(r)),element('small','',new Date(r.at).toLocaleString()));body.append(line);}if(!rows?.length)body.append(element('p','','No recorded activity'));}
    if(activityCategories.includes(activityTab)){const refresh=element('button','','Refresh displayed data');refresh.onclick=()=>loadActivity();body.append(refresh);}
    activityDialog.replaceChildren(heading,nav,body);
  }

  function render() {
    if (!title || !flowRoot) return;
    if(connectionNote){connectionNote.textContent=status;connectionNote.hidden=signedIn&&status==='Connected';}
    if(loginForm)loginForm.hidden=signedIn||!!key;
    titleLabel.textContent = 'War room · '+(me ? me.name+' · '+me.role+' · '+status : status)+' · v0.9.28';
    title.title=status+' · v0.9.28';
    const signature=JSON.stringify(order || null);
    if (signature!==lastOrder) {
      lastOrder=signature;
      owner.hidden=!order||(!order.allPages&&location.pathname!=='/factions.php'&&order.allPages===false);
      dismissFlash();
      if (order) {
        const command=element('b','command',order.text);
        const who=element('div','issued','Issued by '+order.by+' · ');
        who.append(clock(order.at));
        owner.replaceChildren(element('small','','ACTIVE WAR ORDER'),command,who);owner.className='banner severity-'+(order.severity||'neutral')+(order.pulse?' orderPulse':'');
        if (false) {
          flash.replaceChildren(element('small','','NEW WAR ORDER'),command.cloneNode(true),element('span','',order.by));
          showFlash();
        }
      } else owner.replaceChildren();
    }
    renderOps();
    if (!panel.open) return;
    leaders.hidden=!(me?.canOrder??me?.leader) || (roomTabs && roomTabs.querySelector('.selected')?.dataset.tab!=='Orders');
    renderActivity();
    const rosterKey=JSON.stringify([rankBadges,sharedMembers.map(m=>[m.id,m.name,m.presence,m.page,m.seenAt,m.tornLastAt]),online,(ops.resources||[]).map(m=>[m.id,m.energy,m.medicalUntil,m.boosterUntil,m.life,m.maxLife,m.at,!!m.at&&Date.now()-m.at>90000])]);
    if (rosterKey!==lastRoster) {
      lastRoster=rosterKey;
      const grid=element('ul','people');
      for(const m of (sharedMembers.length?sharedMembers.filter(m=>m.presence!=='offline'||(m.seenAt&&Date.now()-m.seenAt<50000)):online.map(name=>({name,presence:'online'}))).sort((a,b)=>a.name.localeCompare(b.name))){
        const cell=element('li','presenceMember');if(m.presence==='offline'){cell.classList.add('offlineGrace');cell.dataset.offlineSince=String(Number(m.seenAt)+20000);}const btn=element('button','member');const v=(ops.resources||[]).find(r=>String(r.id)===String(m.id)||r.name===m.name);const health=hpBar('',v?.life,v?.maxLife,true,!!v?.at&&Date.now()-v.at>90000);health.classList.add('onlineHealth');const identity=element('div','memberIdentity');identity.append(element('b','',m.name));for(const badge of rankBadges[m.id]||[])identity.append(element('small','rankTag','['+badge+']'));const right=element('div','memberRight');right.append(health,element('span','memberPage',m.page||'Unknown page'));btn.append(presenceDot(m.presence),identity,right);btn.onclick=()=>openActivity(m.id,m.name);const metrics=element('div','memberMetrics');metrics.append(liveMetric('age',m.seenAt,'Relay '),liveMetric('age',m.tornLastAt,'Torn '),element('span','',metricHits(v)+' hits'+(v?.at&&Date.now()-v.at>90000?'*':'')),liveMetric('cooldown',v?.medicalUntil,'Med '),liveMetric('cooldown',v?.boosterUntil,'Boost '));metrics.hidden=false;cell.append(btn,metrics);if(m.presence==='offline'){const countdown=element('span','offlineCountdown');countdown.textContent='Offline for '+Math.max(0,Math.floor((Date.now()-Number(cell.dataset.offlineSince))/1000))+'s';cell.append(countdown);}grid.append(cell);
      }
      const head=element('div','rankingRow');const rank=element('button','','Leaderboard');rank.onclick=openLeaderboard;head.append(element('h4','','Connected · '+online.length),rank);presence.replaceChildren(head,grid);
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
    if((p==='/loader.php'||p==='/page.php') && new URLSearchParams(location.search).get('sid')==='attack')return 'Attack';
    return ({'/hospital.php':'Hospital','/travelagency.php':'Travel','/item.php':'Items','/gym.php':'Gym','/crimes.php':'Crimes','/profiles.php':'Profile'})[p]||'Other';
  }
  function pageInfo(){const q=new URLSearchParams(location.search),kind=currentPage(),targetId=kind==='Attack'?q.get('user2ID'):kind==='Profile'?q.get('XID'):null;const heading=document.querySelector('#mainContainer h1,.content-title h4,main h1');const title=(heading?.textContent?.trim()||document.title.replace(/\s*[-|–]\s*Torn.*$/i,'')||kind).slice(0,70);const targetName=sharedMembers.find(m=>String(m.id)===targetId)?.name||feed.find(a=>a.pair?.split('-')[1]===targetId)?.defender||document.querySelector('a[href*="XID='+targetId+'"]')?.textContent?.trim()||targetId;return {page:targetId&&(kind==='Attack'||kind==='Profile')?kind+' · '+targetName:title,focused:pdaAvailable()? !document.hidden:document.hasFocus(),visible:!document.hidden,targetId};}

  function reportPresence(){if(authenticated && socket?.readyState===1)socket.send(JSON.stringify({type:'presence',...pageInfo()}));}
  setInterval(reportPresence,5000);
  window.addEventListener('hashchange',reportPresence);

  let syncing = false;
  const pageWindow=typeof unsafeWindow!=='undefined'?unsafeWindow:window;
  function pdaAvailable(){return typeof PDA_httpPost==='function'||typeof pageWindow.PDA_httpPost==='function'||typeof pageWindow.flutter_inappwebview?.callHandler==='function';}
  function gmAvailable(){return typeof GM_xmlhttpRequest==='function';}
  function nativeAvailable(){return pdaAvailable()||gmAvailable();}
  function transportName(){return pdaAvailable()?'PDA HTTP':gmAvailable()?'Tampermonkey HTTP':'HTTP bridge';}
  async function postNative(url, auth, data, extra = {}) {
    const args = [url, {Authorization: auth, 'Content-Type':'application/json', ...extra}, JSON.stringify(data)];
    let timer;
    try {
      let request;
      if(typeof PDA_httpPost==='function')request=PDA_httpPost(...args);
      else if(typeof pageWindow.PDA_httpPost==='function')request=pageWindow.PDA_httpPost(...args);
      else if(typeof pageWindow.flutter_inappwebview?.callHandler==='function')request=pageWindow.flutter_inappwebview.callHandler('PDA_httpPost',...args);
      else if(gmAvailable())request=new Promise((resolve,reject)=>GM_xmlhttpRequest({method:'POST',url,headers:args[1],data:args[2],timeout:14000,anonymous:true,onload:r=>resolve({status:r.status,responseText:r.responseText}),onerror:()=>reject(Error('VPS HTTP request failed')),ontimeout:()=>reject(Error('Request timed out')),onabort:()=>reject(Error('Request aborted'))}));
      else throw Error('No HTTP bridge');
      const result = await Promise.race([request, new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error('Request timed out')), 15000);
      })]);
      return typeof result === 'string' ? JSON.parse(result) : result;
    } finally { clearTimeout(timer); }
  }
  async function syncNative() {
    if (syncing) return;
    if (!nativeAvailable()) {
      status = 'Waiting for HTTP bridge';
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
        if (Number(login.status) === 403) { status = 'Key rejected · check faction membership and API key';signedIn=false;key='';try{sessionStorage.removeItem('fw.relay.key');}catch{}render();return; }
        if (Number(login.status) !== 200) throw Error('Login HTTP ' + (login.status || 0));
        sessionToken = JSON.parse(login.responseText).token;
        revision = null;
      }
      const batch = [...pending.values()];
      if (!signedIn) { status = 'Connecting via '+transportName(); render(); }
      const res = await post('/sync', 'Bearer ' + sessionToken, {attacks:batch,revision,delta:true,chain:chainObservation,...pageInfo()});
      if (Number(res.status) === 401) sessionToken = null;
      if (Number(res.status) !== 200) throw Error('Sync HTTP ' + (res.status || 0));
      const data = JSON.parse(res.responseText);
      if (!data.unchanged) { accept(data); revision = data.revision; }
      if (rosterAt && Date.now()-rosterAt > 45000) await postNative(base+'/roster','Bearer '+sessionToken,{}, {'X-Torn-Key':key});
      for (const row of batch) if (pending.get(row.id) === row) pending.delete(row.id);
      void refreshIntel();
      status = 'Connected';signedIn=true;
      if(loginForm)loginForm.hidden=true;
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
    status = 'HTTP bridge unavailable · enable Tampermonkey permissions or use PDA';
    render();
    retry = setTimeout(connect,10000);
  }
  function connect() {
    clearTimeout(retry);
    if (!key) return;
    if (nativeAvailable() || validKey(TORN_API_KEY)) return syncNative();
    status = 'Connecting';
    render();
    try { socket = new WebSocket(RELAY_URL); } catch { return fallback(); }
    socket.onerror = () => { status = 'WebSocket blocked or unreachable'; render(); };
    socket.onopen = () => socket.send(JSON.stringify({type:'auth',delta:true, key}));
    socket.onmessage = e => {
      let data;
      try { data = JSON.parse(e.data); } catch { return; }
      if(data.type==='activity'){if(String(data.id)===String(activityId)){detailedActivity=data.activity;leaderboardData=data.leaderboard||null;ownActivityPreferences=data.ownPreferences||{};activityLoading=false;activitySignature='';renderActivity();}return;}
      if(data.type==='orderResult'){const cb=orderWaiters.get(data.requestId);if(cb){orderWaiters.delete(data.requestId);cb(data);}return;}
      if (data.type === 'orderDenied') {notice.textContent='Order refused. Check your faction role.';return;}
      if (data.type !== 'snapshot' || !(Array.isArray(data.attacks)||Array.isArray(data.attackChanges))) return;
      authenticated = true;
      status = 'Connected';
      void refreshIntel();
      signedIn=true;if(loginForm)loginForm.hidden=true;
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
      if(e.code===1008){signedIn=false;key='';try{sessionStorage.removeItem('fw.relay.key');}catch{}render();}else retry = setTimeout(connect,10000);
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
    const desc = data?.warDesc ?? source?.warDesc ?? source ?? data;
    const users = desc?.users ?? source?.users ?? data?.users ?? {};
    const label = (id,value) => String(users[id]?.playername ?? users[id]?.name ?? value?.name ?? value ?? id ?? '').slice(0,60);
    for (const [live,rows] of [[true,desc?.currentAttacks ?? source?.currentAttacks ?? data?.currentAttacks],[false,desc?.recentAttacks ?? source?.recentAttacks ?? data?.recentAttacks]]) {
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
  // With GM grants Tampermonkey runs in a sandbox; observe the page's own network APIs.
  try {
  const original = pageWindow.fetch;
  const observedFetch = async function(...args) {
    const sampleAt=Date.now();
    const res = await original.apply(this,args);
    if(res.ok)hintActivity(res.url,args[1]?.method||args[0]?.method||'GET');
    if (relevant(res.url)) { try { res.clone().json().then(data=>observe(data,sampleAt)).catch(() => {}); } catch {} }
    return res;
  };
  pageWindow.fetch=typeof exportFunction==='function'?exportFunction(observedFetch,pageWindow):observedFetch;
  const open = pageWindow.XMLHttpRequest.prototype.open;
  const observedOpen = function(method,url,...rest) {
    const sampleAt=Date.now();
    this.addEventListener('load',function(){if(this.status>=200&&this.status<300)hintActivity(this.responseURL||url,method);},{once:true});
    if (relevant(url)) this.addEventListener('load',function() {
      try { if (relevant(this.responseURL)) observe(this.responseType === 'json' ? this.response : JSON.parse(this.responseText),sampleAt); } catch {}
    },{once:true});
    return open.call(this,method,url,...rest);
  };
  pageWindow.XMLHttpRequest.prototype.open=typeof exportFunction==='function'?exportFunction(observedOpen,pageWindow):observedOpen;
  }catch(err){console.warn('[War Relay] Page observation hooks unavailable',err?.message);}
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
      const scope=document.querySelector('#faction-main') || safeContent();
      if(!scope)return;
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
      // The faction React app owns its internal layout, including positioned
      // ranked-war widgets. Never insert a sibling inside that app.
      mountRoom();
      section?.classList.toggle(hideClass,hidden);
      button.textContent=section ? (hidden?'Show main news':'Hide main news') : 'Main news unavailable';
      button.disabled=!section;
    }
    button.onclick=()=>{hidden=!hidden;try{localStorage.setItem('fw.hideNews',hidden?'1':'0');}catch{}locate();};
    locate();
    new MutationObserver(()=>{
      if(host.parentElement===safeContent() && section?.isConnected) return;
      if(!timer) timer=setTimeout(()=>{timer=null;locate();},700);
    }).observe(document.body,{childList:true,subtree:true});
  }
  function outcome(a){return /^attacked$/i.test(a.result||'')?'Left':a.result||'Outcome unavailable';}
  function hpBar(name,hp,max,absolute=false,stale=false){
    const wrap=element('div','hpwrap'+(stale?' hpstale':''));
    const valid=Number.isFinite(hp)&&hp>=0;
    const exact=valid&&Number.isFinite(max)&&max>0&&(absolute||hp>100);
    const percent=valid&&!absolute&&!exact&&hp<=100;
    const ratio=exact?100*hp/max:percent?hp:null;
    const value=exact?hp.toLocaleString('en-GB')+'/'+max.toLocaleString('en-GB'):percent?hp+'%':valid&&absolute?hp.toLocaleString('en-GB')+'/?':'Unknown';
    const label=(name?name+' · ':'')+value+(stale&&valid?'*':'');
    wrap.append(element('div','hplabel',label));
    const bar=element('div','hpbar'+(ratio===null?' hpunknown':'')),fill=element('div','hpfill');
    if(ratio!==null){const pct=Math.max(0,Math.min(100,ratio));fill.style.width=pct+'%';bar.setAttribute('role','progressbar');bar.setAttribute('aria-label',(name||'Health')+(stale?' (last known)':''));bar.setAttribute('aria-valuemin','0');bar.setAttribute('aria-valuemax','100');bar.setAttribute('aria-valuenow',String(Math.round(pct)));bar.setAttribute('aria-valuetext',value);bar.append(fill);}else bar.setAttribute('aria-label','Health percentage unknown');
    wrap.append(bar);return wrap;
  }
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
  async function sendAction(scope,command,target,ids,extra={}) {
    const payload={type:'order',scope,command,target,ids,...extra};
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
  function durationSelect(){const s=element('select','');for(let n=30;n<=720;n+=30)s.add(new Option((n>=60?Math.floor(n/60)+'h ':'')+(n%60?n%60+'m':''),String(n)));return s;}
  function takeOver(role){if(!takeoverDialog)return;const select=durationSelect(),confirm=element('button','','Take over'),cancel=element('button','','Cancel'),msg=element('p','','Choose your availability');confirm.onclick=async()=>{confirm.disabled=true;const ok=await sendAction('takeover','Take over',role,undefined,{minutes:Number(select.value)});if(ok)takeoverDialog.hidden=true;else{msg.textContent=notice.textContent;confirm.disabled=false;}};cancel.onclick=()=>takeoverDialog.hidden=true;takeoverDialog.replaceChildren(element('h4','','Take over '+role),msg,select,confirm,cancel);takeoverDialog.hidden=false;}
  function buildOps() {

    opsBox=element('details','headcount');
    opsBox.append(element('summary','','Energy headcount'),element('div','readings'));
    assignments=element('details','assignments');
    assignments.append(element('summary','','Member orders and chain watch'));
    watchList=element('select','');watchList.multiple=true;watchList.size=4;
    const enable=element('button','','Build chain · watch selected');
    enable.onclick=()=>sendAction('watch','Watch enemies','',[...watchList.selectedOptions].map(o=>o.value));
    const disable=element('button','','Stop enemy watch');disable.onclick=()=>sendAction('watch','Stop watching enemies');
    watchSection=element('details','assignments');watchSection.append(element('summary','','Enemy watch'),watchList,enable,disable);
    watcherSettings=element('div','orderGroup');primarySelect=element('select','');secondarySelect=element('select','');primaryDuration=durationSelect();secondaryDuration=durationSelect();const saveWatch=element('button','','Save watchers');saveWatch.onclick=()=>{if(primarySelect.value&&primarySelect.value===secondarySelect.value){notice.textContent='Choose two different members';return;}sendAction('member','Set chain watchers','',[primarySelect.value,secondarySelect.value],{durations:[Number(primaryDuration.value),Number(secondaryDuration.value)]});};const pLabel=element('label','','Primary');pLabel.append(primarySelect,primaryDuration);const sLabel=element('label','','Secondary');sLabel.append(secondarySelect,secondaryDuration);watcherSettings.append(element('h4','','Chain watchers'),pLabel,sLabel,saveWatch);assignments.append(watcherSettings);panel.insertBefore(watchSection,output);
    rosterTabs.append(opsBox);opsBox.hidden=true;panel.insertBefore(assignments,output);
  }
  let opsKey='', watchSection, guard, personalHeader, rosterTabs, headerRect, roomTabs, primarySelect, secondarySelect, watcherSettings, activeOrders, watcherSignature='', slotSignature='';
  function placePersonal(){
    if(!personalHeader)return;
    personalHeader.hidden=true;
    if(!order?.text||order.coverLogo===false)return;
    const selectors='#logo,.logo,[class*="logo___"],[class*="logoWrapper"],a[href="/index.php"],a[href="/"]';
    const candidates=[...document.querySelectorAll(selectors)].map(n=>({n,r:n.getBoundingClientRect()})).filter(({n,r})=>{
      if(r.width<45||r.width>260||r.height<20||r.height>135||r.top<0||r.top>120||r.bottom>innerHeight||r.left<0||r.right>innerWidth)return false;
      const style=getComputedStyle(n);if(style.visibility==='hidden'||style.display==='none')return false;
      return /logo/i.test(String(n.id)+' '+String(n.className))||/torn/i.test(n.getAttribute('aria-label')||n.getAttribute('title')||n.textContent||'')||!!n.querySelector('img[alt*="torn" i],[class*="logo"]');
    });
    candidates.sort((a,b)=>b.r.width*b.r.height-a.r.width*a.r.height);
    const r=candidates[0]?.r;if(!r)return;
    const severity=['danger','warning','safe','neutral'].includes(order.severity)?order.severity:'neutral';
    personalHeader.className='personalHeader logoOrder severity-'+severity+(order.pulse?' orderPulse':'');
    personalHeader.textContent=order.text;personalHeader.title=order.text;
    const font=Math.max(8,Math.min(20,r.height*.34,r.width/Math.max(5,Math.min(20,order.text.length)*.52)));
    personalHeader.style.cssText='position:fixed;left:'+r.left+'px;top:'+r.top+'px;width:'+r.width+'px;height:'+r.height+'px;font-size:'+font+'px';
    personalHeader.hidden=false;
  }
  let flowHost, roomHost, newsControl, watcherNode, flowRoot;
  function safeContent(){return document.querySelector('#mainContainer > .content-wrapper[role="main"]')||document.querySelector('.content-wrapper[role="main"]')||document.querySelector('#mainContainer > .content-wrapper')||document.querySelector('main[role="main"],main');}
  function desktopLayout(){return !!document.querySelector('#mainContainer > #sidebarroot')&&innerWidth>=760;}
  function mountRoom(){const main=safeContent();if(!main||!roomHost)return false;
    if(location.pathname==='/factions.php'){
      // Keep both injected hosts outside the native faction application's
      // positioned descendants, in the same normal-flow content column.
      const firstNative=[...main.children].find(n=>n!==roomHost&&n!==flowHost);
      if(roomHost.parentElement!==main||(firstNative&&roomHost.nextElementSibling!==firstNative)){
        if(firstNative)main.insertBefore(roomHost,firstNative);else main.append(roomHost);
      }
    }else if(roomHost.parentElement!==main){const heading=main.querySelector(':scope > .content-title');if(heading)heading.after(roomHost);else main.prepend(roomHost);}
    return true;}
  function positionFlow(){
    if(!flowHost||!roomHost)return;
    const war=isWarView(), showRoom=roomView();
    roomHost.hidden=!showRoom;
    owner.hidden=!order||(!order.allPages&&location.pathname!=='/factions.php'&&order.allPages===false);
    panel.hidden=!showRoom;
    if(showRoom)mountRoom();
    if(!war)flash.hidden=true;
    const hasContent=[flash,attackAlert,guard,watcherNode].some(n=>n&&!n.hidden)||!!extras?.children.length;
    if(!hasContent){flowHost.hidden=true;flowHost.style.setProperty('display','none','important');return;}
    const main=safeContent();
    if(location.pathname==='/factions.php'&&main&&roomHost.parentElement===main){if(flowHost.parentElement!==main||flowHost.nextElementSibling!==roomHost)main.insertBefore(flowHost,roomHost);flowHost.hidden=false;flowHost.style.setProperty('display','block','important');return;}
    if(desktopLayout()){if(main){if(main.firstElementChild!==flowHost)main.prepend(flowHost);flowHost.hidden=false;flowHost.style.setProperty('display','block','important');}else{flowHost.hidden=true;flowHost.style.setProperty('display','none','important');}return;}
    const row=visibleIconRow();
    let anchor=row;
    // Escape fixed-height header wrappers and insert in the normal page flow.
    if(anchor){for(let p=anchor.parentElement;p&&p!==document.body;p=p.parentElement){
      const css=getComputedStyle(p),r=p.getBoundingClientRect();
      if(r.height>360)break;
      if(/^(fixed|absolute|sticky)$/.test(css.position)||/hidden|clip/.test(css.overflowY)||/flex|grid/.test(css.display)||p.clientHeight<p.scrollHeight-2)anchor=p;
    }}
    if(anchor?.parentElement && anchor.parentElement.id!=='mainContainer' && anchor.parentElement!==document.body && !flowHost.contains(anchor) && !roomHost.contains(anchor) && !/^(fixed|absolute)$/.test(getComputedStyle(anchor.parentElement).position) && !/flex|grid/.test(getComputedStyle(anchor.parentElement).display)){
      if(anchor.nextElementSibling!==flowHost)anchor.after(flowHost);
    }else if(main && !flowHost.contains(main) && !/^(fixed|absolute)$/.test(getComputedStyle(main).position)){
      if(main.firstElementChild!==flowHost)main.prepend(flowHost);
    }
    flowHost.hidden=!flowHost.isConnected;
    flowHost.style.setProperty('display',flowHost.hidden?'none':'block','important');

  }

  function renderOps() {
    if(!extras || !opsBox || !flowRoot || !roomHost || !personalHeader)return;
    const personal=null;
    const lines=[...(ops.instructions || [])];
    
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
    const watchSig=JSON.stringify([slots,ops.watchUntil,ops.takeover,ops.watcherEnergy,ops.claim,ops.canClaim,ops.backupOpen,me?.name,sharedMembers.filter(m=>Object.values(slots).includes(m.name)).map(m=>[m.name,m.page,m.presence,m.seenAt,m.tornLastAt])]);
    const unavailable=Object.values(slots).filter(Boolean).some(name=>{const m=(ops.watcherEnergy||[]).find(v=>v.name===name);return !m?.online || m.idle || !Number.isFinite(m.energy) || m.energy<25;});
    watcher.classList.toggle('watchWarning',unavailable);
    watcher.hidden=!slots.primary&&!slots.secondary&&!ops.claim&&!ops.chain?.count;
    if(watcherSignature!==watchSig||!watcher.firstChild){watcherSignature=watchSig;const heading=element('div','watchTitle');const grid=element('div','watchGrid');for(const [role,name] of Object.entries(slots)){if(!name&&!ops.takeover?.[role])continue;const m=(ops.watcherEnergy||[]).find(v=>v.name===name);const card=element('div','watchMember');card.classList.toggle('watchUnavailable',!m?.online||m.idle||!Number.isFinite(m.energy)||m.energy<25);card.title=!m?.online?'Offline':m.idle?'Idle':!Number.isFinite(m.energy)?'Energy unknown':m.energy<25?'Insufficient energy':'Ready';card.append(element('span','watchName',(role==='primary'?'P':'S')+' · '+(name||'Vacant')),element('span','watchEnergy','⚡'+(m?.energy??'?')+'/'+(m?.maxEnergy??'?')));const liveMember=sharedMembers.find(v=>v.name===name);if(liveMember?.page)card.append(element('span','watchPage',liveMember.page));if(name){const stats=element('div','watchMetrics');stats.append(element('span','','Hits '+metricHits(m)),liveMetric('cooldown',m?.medicalUntil,'Med '),liveMetric('age',liveMember?.seenAt,'Relay '),liveMetric('age',liveMember?.tornLastAt,'Torn '));const health=hpBar('HP',m?.life,m?.maxLife,true,!!m?.at&&Date.now()-m.at>90000);health.classList.add('watchHealth');card.append(health,stats);}if(!m?.online)card.append(element('span','watchProblem','OFFLINE'));else if(m.idle)card.append(element('span','watchProblem','IDLE'));else if(!Number.isFinite(m.energy)||m.energy<25)card.append(element('span','watchProblem',Number.isFinite(m.energy)?'LOW E':'UNKNOWN E'));if(name&&ops.watchUntil?.[role]){const until=element('span','watchPage watchExpiry');until.dataset.until=String(ops.watchUntil[role]);card.append(until);};if(ops.takeover?.[role]){const take=element('button','claim',name?'Take over':'Claim '+role);take.onclick=()=>takeOver(role);card.append(take);}if(name&&ops.claim?.name===name)card.append(element('span','claimed','NEXT'));if(name&&name===me?.name){const b=element('button','claim',ops.claim?.name===name?'Release':'Next hit');b.disabled=ops.claim?.name!==name&&!ops.canClaim;b.onclick=()=>sendAction('claim',ops.claim?.name===name?'Release next hit':'Claim next hit');card.append(b);const resign=element('button','claim resign','Leave role');resign.onclick=async()=>{if(!window.confirm('Release your '+role+' watcher appointment?'))return;resign.disabled=true;const ok=await sendAction('releaseWatcher','Release watcher',role);if(!ok&&resign.isConnected)resign.disabled=false;};card.append(resign);}grid.append(card);}watcher.replaceChildren(heading,grid);
      const assigned=Object.values(slots).includes(me?.name);
      if(ops.claim?.backup||(!assigned&&ops.backupOpen&&!ops.claim)){
        const backup=element('div','watchBackup');
        backup.append(element('span','',ops.claim?.backup?'Backup · '+ops.claim.name:'Backup hit available'));
        if(ops.claim?.name===me?.name||(!assigned&&ops.canClaim&&!ops.claim)){
          const release=ops.claim?.name===me?.name;
          const b=element('button','claim',release?'Release':'Next hit');
          b.onclick=async()=>{b.disabled=true;const ok=await sendAction('claim',release?'Release next hit':'Claim next hit');if(!ok&&b.isConnected)b.disabled=false;};backup.append(b);
        }
        watcher.append(backup);
      }
    }
    const watchHeading=watcher.firstChild;watchHeading.replaceChildren(document.createTextNode('🔗 '+(ops.chain?.count||0)+' · '),element('span',ops.chain?.count&&ops.chain?.endsAt&&secs<60?'chainUrgent':'',ops.chain?.count?timer:'Inactive'),document.createTextNode(' · '+(ops.claim?ops.claim.name+' next':'Unclaimed')));refreshMetrics(watcher);refreshMetrics(presence);for(const row of presence.querySelectorAll('[data-offline-since]')){const sec=Math.max(0,Math.floor((Date.now()-Number(row.dataset.offlineSince))/1000));if(sec>=30)row.remove();else row.querySelector('.offlineCountdown').textContent='Offline for '+sec+'s · '+(30-sec)+'s left';}
    for(const node of watcher.querySelectorAll('[data-until]')){const end=Number(node.dataset.until),minutes=Math.max(0,Math.ceil((end-Date.now())/60000));const left=minutes<60?minutes+'m':Math.floor(minutes/60)+'h '+String(minutes%60).padStart(2,'0')+'m';node.textContent='Until '+new Date(end).toISOString().slice(11,16)+' TCT · '+left+' left';}
    placePersonal(personal);
    const fallbackOrder=null;
    if(fallbackOrder&&personalHeader?.hidden){let fallback=extras.querySelector('.personalFallback');if(!fallback){fallback=element('div','signal personalFallback');extras.prepend(fallback);}fallback.textContent=fallbackOrder.text;fallback.classList.toggle('personalOrder',fallbackOrder===personal);}else extras.querySelector('.personalFallback')?.remove();
    positionFight();positionFlow();
    if(roomTabs){let selected=roomTabs.querySelector('.selected')?.dataset.tab;if((selected==='Orders'&&!(me?.canOrder??me?.leader))||(selected==='Watch'&&(!me?.leader||!ops.warActive))){roomTabs.querySelector('[data-tab="Online"]')?.click();return;}assignments.hidden=!me?.leader||selected!=='Orders';opsBox.hidden=selected!=='Energy';leaders.hidden=!(me?.canOrder??me?.leader)||selected!=='Orders';for(const label of ['Orders','Watch']){const b=roomTabs.querySelector('[data-tab="'+label+'"]');if(b)b.hidden=label==='Orders'?!(me?.canOrder??me?.leader):!me?.leader||!ops.warActive;}}
    watchSection.hidden=!me?.leader || !ops.warActive || (roomTabs && roomTabs.querySelector('.selected')?.dataset.tab!=='Watch');
    if(guard){const id=new URLSearchParams(location.search).get('user2ID');const inside=order?.text?.toUpperCase()==='INSIDE HITS ONLY'||(ops.instructions||[]).some(x=>x.startsWith('INSIDE HITS ONLY'));guard.hidden=!(currentPage()==='Attack' && inside && ops.warActive && ops.enemyRosterFresh && id && !(ops.enemyIds||[]).includes(id));}
    positionFlow();
    if(!panel.open)return;
    if(me?.leader){

    const before=watchList.dataset.options;
    options(watchList,(ops.enemies || []).map(m=>[m.id,m.name+(m.online?' · online':'')]));
    if(before!==watchList.dataset.options)for(const o of watchList.options)o.selected=(ops.watchIds || []).includes(o.value);
    const list=[['','Unassigned'],...(ops.members||[]).map(n=>[n,n])];options(primarySelect,list);options(secondarySelect,list);const slotKey=JSON.stringify(ops.watchSlots||{});if(slotSignature!==slotKey){slotSignature=slotKey;primarySelect.value=ops.watchSlots?.primary||'';secondarySelect.value=ops.watchSlots?.secondary||'';}

    }
    const members=ops.resources || [], now=Date.now();
    const fresh=members.filter(m=>Number.isFinite(m.energy)&&now-m.at<=90000);
    const ready=fresh.filter(m=>m.online && /^(ok|okay)$/i.test(m.status));
    const sum=list=>list.reduce((n,m)=>n+m.energy,0);
    const label='👥 '+online.length+' · ⚡ '+sum(fresh.filter(m=>m.online))+'E online · '+sum(ready)+'E ready';
    if(roomTabs)roomTabs.dataset.energy=label;
    opsBox.firstChild.textContent=label;
    const sig=JSON.stringify([members,ready.length,me?.leader,Math.floor(now/5000)]);
    if(sig===opsKey)return;opsKey=sig;
    const readings=opsBox.lastChild;
    const delta=t=>elapsed(now-Math.max(0,t-now));
    const totals=element('div','energyTotals');for(const [name,value] of [['Online E',sum(fresh.filter(m=>m.online))],['Ready E',sum(ready)],['Offline E*',sum(members.filter(m=>!m.online&&Number.isFinite(m.energy)))]]){const cell=element('div','energyTotal');cell.append(element('small','',name),element('b','',String(value)));totals.append(cell);}
    const table=element('div',me?.leader?'energyTable':'energyTable memberEnergy');const header=element('div','energyRow energyHead');for(const name of (me?.leader?['Member','⚡ Energy','♥ HP','Booster']:['Member','⚡ Energy','♥ HP']))header.append(element('span','',name));table.append(header);
    for(const m of [...members].sort((a,b)=>Number(b.online)-Number(a.online)||(b.energy??-1)-(a.energy??-1))){
      const stale=!m.at||now-m.at>90000;const row=element('div','energyRow');const person=element('div','energyPerson');person.append(presenceDot(m.presence||(m.online?'online':'offline')),element('b','',m.name),element('small','',!m.at?'No reading':stale?'Last known · '+elapsed(m.at)+' ago':m.status||'Unknown'));row.tabIndex=0;row.setAttribute('role','button');row.onclick=()=>openActivity(m.id,m.name);row.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();openActivity(m.id,m.name);}};row.append(person,element('span','',Number.isFinite(m.energy)?m.energy+'/'+(m.maxEnergy??'?')+(stale?'*':''):'—'),hpBar('',m.life,m.maxLife,true,stale));if(me?.leader)row.append(element('span','',stale||m.boosterUntil==null?'—':m.boosterUntil<=now?'Ready':delta(m.boosterUntil)));table.append(row);
      if(!stale&&m.destination&&m.destination!=='Torn')table.append(element('div','energyTravel','↳ '+m.destination+(m.landAt?' · '+new Date(m.landAt).toLocaleTimeString():'')));
    }
    readings.replaceChildren(totals,table,element('small','energyFoot','* Last known energy; may have changed while disconnected.'));

  }
  function mount() {
    const host = document.createElement('div');
    host.style.cssText='display:block;position:relative;width:100%;max-width:100%;min-width:0;flex:0 0 auto;box-sizing:border-box;margin:8px 0;clear:both';
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
      .roomNav{display:flex;gap:3px;padding:6px;background:#171e22}.roomNav button{flex:1;min-width:0;padding:6px 2px;font-size:11px;border-color:#43535c}.roomNav button.selected{background:#45616a;color:#fff}.roomContent{padding:6px;min-height:54px}.roomContent .headcount,.roomContent .assignments{margin:0;border:0;background:transparent}.roomContent .headcount>summary,.roomContent .assignments>summary{display:none}.roomContent .roster,.roomContent .feed,.roomContent .controls{margin:3px}.watchers{border:1px solid #50616a;border-radius:5px;margin:4px 0;padding:6px!important}.watchTitle{font-weight:700}.watchMember{padding:3px 0}.roomContent .controls{display:flex;flex-direction:column;align-items:stretch;padding:10px;border:1px solid #43535c;border-radius:5px;background:#252f35;margin:0 0 9px}.roomContent .controls h4,.orderGroup h4,.activeOrders h4,.assignments h4{color:#d5e0e5;font-size:12px;letter-spacing:.035em;margin:0 0 7px}.roomContent .assignments{padding:10px;border:1px solid #43535c;border-radius:5px;background:#252f35}.assignments select,.assignments button{max-width:100%;margin:3px 0}.assignments>select{width:100%}.orderGroup,.activeOrders{border-top:1px solid #43535c;margin-top:12px;padding-top:10px}.orderGroup label{display:block;font-size:11px;color:#b8c8ce}.orderGroup select{display:block;width:100%}.orderLine{display:flex;align-items:center;justify-content:space-between;gap:5px;padding:6px 0;border-bottom:1px solid #39464d}.orderLine span{display:block;font-size:11px;color:#e8c780}.watchGrid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px;margin-top:6px}.watchMember{display:flex;flex-direction:column;gap:3px;background:#182329;border:1px solid #40535e;border-radius:4px;padding:6px!important;overflow-wrap:anywhere}.watchMember small{color:#a9bbc6;font-size:9px;letter-spacing:.06em}.watchMember .claim{margin:2px 0 0;width:100%;pointer-events:auto}.claimed{color:#91d18b;font-size:10px;font-weight:700}.hpgrid{display:grid;grid-template-columns:1fr 1fr;gap:8px}.hpbar{height:5px;background:#a74040;border-radius:3px;overflow:hidden}.hpfill{height:100%;background:#77c75a;transition:width .25s ease}.hpwrap{min-width:0;display:flex;flex-direction:column;gap:2px}.hpunknown{background:#4b555a;background-image:repeating-linear-gradient(135deg,transparent,transparent 4px,#647078 4px,#647078 6px)}.hpstale{opacity:.7}.watchHealth{width:100%}.energyRow .hpwrap{text-align:right}.energyRow .hplabel{font-size:10px;white-space:normal}.watchHealth .hplabel{font-size:10px}@media(prefers-reduced-motion:reduce){.hpfill{transition:none}}.hplabel{font-size:11px;overflow-wrap:anywhere}.claim{pointer-events:auto;margin-left:5px;font-size:11px;padding:3px}.watchers{font-size:11px}.personalHeader{z-index:2147483647;color:#ffe194;background:#252525;display:flex;align-items:center;justify-content:center;text-align:center;line-height:1;overflow:hidden;pointer-events:none}.tabrow{display:flex;gap:4px;padding:4px}.tabrow button{flex:1;font-size:12px;padding:4px}.people{grid-template-columns:1fr!important}.people li{padding:2px 5px!important}.member{background:transparent;border:0;color:inherit;padding:2px}.headcount,.assignments,.share{margin:7px}.assignments select,.assignments button{margin:3px;max-width:96%}
    `;
    style.textContent+=`\n.watchers{margin:2px 0;padding:3px 5px!important;border-radius:3px;font-size:11px}.watchTitle{font-size:11px;line-height:15px}.watchGrid{gap:4px;margin-top:2px}.watchMember{display:flex;flex-direction:row;flex-wrap:wrap;align-items:center;gap:3px 5px;padding:3px!important;min-width:0}.watchName{font-weight:650;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}.watchEnergy{white-space:nowrap;color:#d0dce0}.watchBackup{display:flex;align-items:center;justify-content:space-between;gap:6px;padding:3px 5px;margin-top:3px;border:1px solid #7e6843;border-radius:3px;color:#f1d199}.watchBackup .claim{margin:0;width:auto}.watchMember .claim{width:auto;margin:0;padding:2px 5px;line-height:14px;font-size:10px}.signal{padding:3px 6px;font-size:11px}.flash{position:static!important;padding:4px 6px;background:#5d4b28;color:#fff;text-shadow:none}.flash .command{font-size:12px;margin:1px 0}.flash small{font-size:9px}.fightAlert{position:static!important;padding:4px 6px}.banner{padding:5px 8px}.banner .command{font-size:15px}.banner small{font-size:9px}.issued{font-size:10px}.personalHeader{white-space:nowrap;background:transparent;text-overflow:ellipsis}`;
    style.textContent+=`
    .watchWarning{border-color:#e06868!important;animation:fwPulse 1.8s ease-in-out infinite}.watchUnavailable{border-color:#a95757}.watchProblem{font-size:9px;color:#ff9b9b;font-weight:700}@keyframes fwPulse{50%{box-shadow:inset 0 0 9px #c54a4a99}}@media(prefers-reduced-motion:reduce){.watchWarning{animation:none;box-shadow:inset 0 0 5px #c54a4a}}
    .energyTotals{display:grid;grid-template-columns:repeat(3,1fr);gap:4px;margin-bottom:6px}.energyTotal{padding:6px;background:#26363d;border-radius:4px;display:flex;flex-direction:column;text-align:center}.energyTotal small{font-size:10px;color:#b5c6cc}.energyTotal b{font-size:16px;color:#d5eadb}.energyRow{display:grid;grid-template-columns:minmax(0,1.3fr) minmax(0,1fr) minmax(0,.8fr) minmax(0,.9fr);gap:4px;align-items:center;border-bottom:1px solid #39464d;padding:6px 3px;font-size:11px;font-variant-numeric:tabular-nums}.energyRow>span{text-align:right;overflow-wrap:anywhere}.energyHead{font-size:10px;color:#aebfc6}.energyPerson{min-width:0;overflow-wrap:anywhere}.energyPerson small{display:block;font-size:10px;color:#a8b9bf}.energyTravel{font-size:10px;padding:2px 4px;color:#a8b9bf}
    `;
    style.textContent+='\n.activityBody{padding:9px 2px}.statTiles{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin:10px 0}.statTile{min-width:0;background:#29383e;border-radius:6px;padding:10px;display:flex;flex-direction:column;gap:6px}.statTile small,.gymName small,.armouryText small,.panelNote{color:#b5c6cc;font-size:11px;display:block}.statTile strong{font-size:clamp(17px,5vw,25px);overflow-wrap:anywhere;line-height:1.15}.positive{color:#86cf92}.negative{color:#f18a8a}.gold{color:#e5c777}.periodNav{display:flex;align-items:center;justify-content:space-between;gap:6px;margin:9px 0;text-align:center}.periodNav b{font-size:12px}.periodNav button{flex:none;padding:5px 8px}.gymStat,.gymFoot{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:12px 4px;border-bottom:1px solid #40535c}.gymName{min-width:0;display:flex;flex-direction:column;gap:5px}.gymStat strong{font-size:18px;white-space:nowrap}.gymFoot{margin:8px 0}.panelNote{margin:7px 0;line-height:1.4}.armouryCard{display:flex;align-items:center;gap:8px;padding:10px;margin:5px 0;border-radius:5px;background:#29343b}.itemSymbol{width:24px;flex:none;color:#e5c777;font-weight:700;text-align:center}.armouryText{flex:1;min-width:0;overflow-wrap:anywhere;display:flex;flex-direction:column;gap:4px}.emptyState{padding:14px 4px;color:#b5c6cc;text-align:center}.leaderboardRow{width:100%;display:flex;align-items:center;gap:10px;padding:9px 3px;border:0;border-bottom:1px solid #40535c;background:transparent;text-align:left}.rankNumber{width:30px;flex:none;font-size:17px;color:#b5c6cc}.rank1{color:#e5c777}.rank2{color:#c5ccd3}.rank3{color:#c08c68}.rankDetail{flex:1;min-width:0}.rankDetail .rankingRow{border:0;padding:0 0 6px}.rankingTrack{height:5px;border-radius:3px;background:#39464d;overflow:hidden}.rankingFill{height:100%;background:#7897a4}.rank1+.rankDetail .rankingFill{background:#c5a85b}.memberIdentity{flex:1;min-width:0;overflow-wrap:anywhere}.rankTag{display:inline-block;font-size:9px;color:#e5c777;margin-left:3px}.memberRight{display:grid;grid-template-columns:minmax(45px,1fr) minmax(42px,65px);align-items:center;gap:4px;width:55%;flex:none}.presenceMember .memberRight .onlineHealth{width:100%;max-width:none;min-width:0;margin:0}.presenceMember .memberRight .memberPage{max-width:none;width:100%;margin:0}.rankingRow{display:flex;align-items:center;justify-content:space-between;gap:6px;padding:5px;border-bottom:1px solid #40535c}.gain{color:#86cf92}.energyRow[role=button]{cursor:pointer}.titleLabel{display:inline;overflow-wrap:anywhere}.shortcuts{float:right;display:inline-flex;gap:4px;margin-left:5px}.shortcut{display:inline-block;text-decoration:none;color:#d7e9f0;background:#26363d;border:1px solid #536873;border-radius:3px;font-size:10px;padding:2px 5px;line-height:1.3}.offlineGrace{opacity:.48;position:relative;filter:grayscale(1)}.offlineCountdown{display:block;color:#ddd;font-size:10px;padding-left:20px}.logoOrder{box-sizing:border-box;padding:3px 5px;white-space:normal!important;overflow-wrap:anywhere;line-height:1.12;text-align:center;font-weight:800;border:1px solid currentColor;text-overflow:clip;pointer-events:none}.logoOrder.severity-danger{background:#692d32;color:#ffe0e0}.logoOrder.severity-warning{background:#66451f;color:#ffe1ad}.logoOrder.severity-safe{background:#284c37;color:#e0ffe7}.logoOrder.severity-neutral{background:#39454d;color:#edf3f6}.presenceMember .memberMetrics{display:flex!important;visibility:visible!important;opacity:1!important;font-size:11px;line-height:1.4;padding:3px 4px 5px 20px}.chainUrgent{color:#ff6868;font-weight:800}.memberMetrics,.watchMetrics{display:flex;gap:3px 9px;flex-wrap:wrap;font-size:10px;color:#b5c6cc}.memberMetrics{padding:1px 4px 4px 20px}.watchMetrics{width:100%}.resign{color:#efb1b1!important}.presenceDot{display:inline-block;margin-right:5px}.presenceDot.online{color:#86cf92}.presenceDot.idle{color:#efc269}.presenceDot.offline{color:#a2a8ae}.presenceMember:before{display:none}.presenceMember .member{display:flex;align-items:center;width:100%;gap:5px;text-align:left;min-width:0}.presenceMember .member>b{flex:0 1 auto;min-width:0;max-width:38%;overflow-wrap:anywhere}.presenceMember .onlineHealth{flex:1 1 88px;min-width:38px;max-width:145px;margin:0 3px;text-align:center}.onlineHealth .hplabel{font-size:9px;line-height:1.15;overflow-wrap:anywhere}.onlineHealth .hpbar{height:5px}.presenceMember .memberPage{flex:0 1 auto;min-width:0;max-width:34%;text-align:right}.memberPage{margin-left:auto;font-size:11px;color:#a9c2cd;overflow-wrap:anywhere}.watchPage{width:100%;font-size:10px;color:#a9c2cd;overflow-wrap:anywhere}.personalOrder{color:#a6dcff!important}.signal.personalOrder{background:#203b50}.activityDialog{position:fixed;z-index:2147483646;top:15%;left:5%;width:90%;max-height:70vh;overflow:auto;background:#202b31;border:1px solid #6c858f;border-radius:7px;box-shadow:0 8px 32px #0009;padding:8px;color:white}.activityNav{flex-wrap:wrap}.activityNav button{flex:1 1 24%;min-width:60px}.activityPreference{display:flex;justify-content:space-between;padding:8px}.activityHeading{display:flex;justify-content:space-between;align-items:center}.activityRow{display:flex;flex-direction:column;padding:6px;border-bottom:1px solid #40535c}.activityRow small,.energyFoot{font-size:10px;color:#b5c6cc}.memberEnergy .energyRow{grid-template-columns:minmax(0,1.4fr) minmax(0,1fr) minmax(0,1fr)}.connectionNote{padding:5px 8px;margin:0;color:#efcc79;font-size:11px}';
    style.textContent+='\n.banner{padding:7px 10px}.banner .command{font-size:17px}.banner .issued{font-size:11px;color:inherit}.severity-danger{background:#692d32;color:#ffe0e0;border-color:#e05c60}.severity-warning{background:#66451f;color:#ffe1ad;border-color:#e9a04a}.severity-safe{background:#284c37;color:#e0ffe7;border-color:#68bf83}.severity-neutral{background:#39454d;color:#edf3f6;border-color:#8da2ad}.orderPulse{animation:orderPulse 1.6s ease-in-out infinite}@keyframes orderPulse{50%{box-shadow:inset 0 0 15px #ffffff45}}@media(prefers-reduced-motion:reduce){.orderPulse{animation:none}}';
    panel = document.createElement('details');
    title = document.createElement('summary');titleLabel=element('span','titleLabel');const shortcuts=element('span','shortcuts');for(const [label,url] of [['Chain','https://www.torn.com/factions.php?step=your&type=1#/war/chain'],['Meds','https://www.torn.com/item.php#medical-items'],['Fly','https://www.torn.com/page.php?sid=travel']]){const link=element('a','shortcut',label);link.href=url;link.title=label==='Meds'?'Heal / self-hospitalize':label;link.addEventListener('click',e=>{e.stopPropagation();});shortcuts.append(link);}title.append(titleLabel,shortcuts);
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
    directive.onchange = () => {target.hidden=directive.value !== 'EVERYONE PILE ON'; fillTargets();};
    const custom=element('input','');custom.placeholder='Custom order (letters and numbers)';custom.maxLength=100;custom.hidden=true;directive.add(new Option('Custom order','Custom order'));const severity=element('select','');for(const v of ['neutral','danger','warning','safe'])severity.add(new Option(v,v));const pulse=element('input','');pulse.type='checkbox';const pulseLabel=element('label','','Pulse order ');pulseLabel.append(pulse);const coverLogo=element('input','');coverLogo.type='checkbox';coverLogo.checked=true;const logoLabel=element('label','','Cover Torn logo ');logoLabel.append(coverLogo);const allPages=element('input','');allPages.type='checkbox';allPages.checked=true;const pagesLabel=element('label','','Show banner on all pages ');pagesLabel.append(allPages);directive.onchange=()=>{target.hidden=directive.value!=='EVERYONE PILE ON';custom.hidden=directive.value!=='Custom order';severity.value=directive.value==='EVERYONE TURTLE'?'danger':directive.value==='INSIDE HITS ONLY'?'warning':directive.value==='BUILD CHAIN'?'safe':'neutral';pulse.checked=directive.value==='EVERYONE TURTLE';fillTargets();};directive.onchange();
    const send = document.createElement('button');
    send.textContent = 'Send order';
    notice = document.createElement('span');
    send.onclick=async()=>{send.disabled=true;try{await sendAction('global',directive.value,directive.value==='EVERYONE PILE ON'?target.value:'',undefined,{custom:custom.value.trim().replace(/[^\p{L}\p{N} ]/gu,'').replace(/ +/g,' '),severity:severity.value,pulse:pulse.checked,coverLogo:coverLogo.checked,allPages:allPages.checked});}finally{send.disabled=false;}};
    leaders.append(element('h4','','Global orders'),directive,target,custom,severity,pulseLabel,logoLabel,pagesLabel,send,notice);
    const news = document.createElement('button');
    news.className='news';
    fillTargets();
    panel.ontoggle = () => {if(panel.open) fillTargets(); render();};
    const onlineTab=element('details','');onlineTab.append(element('summary','','👥 Members & energy'));rosterTabs=element('div','rosterTabs');const tabs=element('div','tabrow');const peopleButton=element('button','','👥 Online');const energyButton=element('button','','⚡ Energy');peopleButton.onclick=()=>{presence.hidden=false;opsBox.hidden=true;};energyButton.onclick=()=>{if(me?.leader){presence.hidden=true;opsBox.hidden=false;opsBox.open=true;}};tabs.append(peopleButton,energyButton);rosterTabs.append(tabs,presence);onlineTab.append(rosterTabs);
    const globalTab=element('details','');globalTab.append(element('summary','','Global orders'),leaders);
    connectionNote=element('p','connectionNote',status);panel.append(title,connectionNote,onlineTab,globalTab,output,news);
    {
      const form = loginForm=document.createElement('form');form.hidden=!!key;
      const input = document.createElement('input');
      input.type = 'password';
      input.placeholder = 'Limited Torn API key';
      input.setAttribute('aria-label',input.placeholder);
      input.required = true;
      input.pattern = '[a-zA-Z0-9]{16}';
      const submit = document.createElement('button');
      submit.textContent = 'Sign in';
      
      form.append(input,submit);
      panel.append(form);
      form.onsubmit = event => {
        event.preventDefault();
        if (!validKey(input.value.trim())) return;
        key = input.value.trim();
        try{sessionStorage.setItem('fw.relay.key',key);}catch{}
        input.value = '';form.hidden=true;
        if (socket) {socket.onclose = null; socket.close();}
        authenticated = false;
        connect();
      };
    }
    attackAlert=element('button','fightAlert');attackAlert.hidden=true;attackAlert.onclick=()=>{if(selectedFight?.live)dismissedFights.set(selectedFight.id,Date.now());fightUntil=0;attackAlert.hidden=true;positionFlow();};
    extras=element('div','signals');
    buildOps();
    guard=element('aside','banner','CHAIN BONUS WARNING · Outside target. Return to the faction war and select an enemy.');guard.hidden=true;guard.setAttribute('role','alert');
    roomTabs=element('div','roomTabs');const pages=[['Online',presence],['Energy',opsBox],['Orders',leaders,assignments],['Watch',watchSection]];const bar=element('div','roomNav');const content=element('div','roomContent');let active='Online';function choose(name){active=name;for(const [label,...nodes] of pages){for(const n of nodes)n.hidden=label!==name;const b=bar.querySelector('[data-tab="'+label+'"]');if(b)b.classList.toggle('selected',label===name);}if(name==='Energy')opsBox.open=true;if(name==='Orders')assignments.open=true;if(name==='Watch')watchSection.open=true;render();}for(const [label,...nodes] of pages){const b=element('button','',label);b.dataset.tab=label;b.onclick=()=>choose(label);bar.append(b);for(const n of nodes)content.append(n);}roomTabs.append(bar,content);panel.insertBefore(roomTabs,news);onlineTab.remove();globalTab.remove();output.remove();
    personalHeader=element('div','personalHeader');personalHeader.hidden=true;const overlay=document.createElement('div');overlay.style.cssText='position:fixed;inset:0;z-index:2147483647;pointer-events:none';const overlayRoot=overlay.attachShadow({mode:'closed'});overlayRoot.append(style.cloneNode(true),personalHeader);document.documentElement.append(overlay);activityDialog=element('section','activityDialog');activityDialog.hidden=true;takeoverDialog=element('section','activityDialog');takeoverDialog.hidden=true;orderHistoryBox=element('section','activityDialog');orderHistoryBox.hidden=true;const historyButton=element('button','','Order history');historyButton.onclick=()=>{const close=element('button','','Close');close.onclick=()=>orderHistoryBox.hidden=true;orderHistoryBox.replaceChildren(element('h4','','Order history'),close,...orderHistory.map(o=>{const r=element('div','activityRow');r.append(element('b','',o.text),element('small','',o.by+' · '+new Date(o.at).toLocaleString()));return r;}));orderHistoryBox.hidden=false;};panel.append(historyButton);root.append(style,owner,panel,activityDialog,takeoverDialog,orderHistoryBox);roomHost=host;flowHost=document.createElement('div');flowHost.id='fw-inline-status';flowHost.style.cssText='display:block;position:static;width:100%;min-width:0;min-height:0;height:auto;flex:none;box-sizing:border-box;clear:both;overflow:visible';flowRoot=flowHost.attachShadow({mode:'closed'});flowRoot.append(style.cloneNode(true),flash,attackAlert,guard,extras);
    if(location.pathname==='/factions.php')layout(host,news);else {news.hidden=true;panel.open=false;mountRoom();}choose('Online');positionFlow();
    let scheduled=false;const observer=new MutationObserver(()=>{if(scheduled)return;scheduled=true;requestAnimationFrame(()=>{scheduled=false;positionFlow();});});observer.observe(document.body,{childList:true,subtree:true});window.addEventListener('hashchange',()=>{positionFlow();renderOps();});
    window.addEventListener('resize',()=>{headerRect=null;placePersonal(ops.personal);});
    let headerFrame=0;window.addEventListener('scroll',()=>{if(!headerFrame)headerFrame=requestAnimationFrame(()=>{headerFrame=0;placePersonal(ops.personal);});},true);
    setInterval(()=>{if(document.hidden)return;positionFight();renderOps();for(const time of [...root.querySelectorAll('time[data-stamp]'),...flowRoot.querySelectorAll('time[data-stamp]')]) {if(time.getClientRects().length) time.textContent=elapsed(Number(time.dataset.stamp))+' ago';}},1000);
    render();
  }
  function initialize(){try{mount();connect();}catch(err){console.error('[War Relay] Initialization failed',err);const warning=document.createElement('div');warning.textContent='War Relay failed to initialize. Check the console and reload.';warning.style.cssText='padding:8px;background:#633;color:white;font:12px system-ui';(safeContent()||document.body).prepend(warning);}}
  if (document.body) initialize(); else document.addEventListener('DOMContentLoaded',initialize,{once:true});
})();
