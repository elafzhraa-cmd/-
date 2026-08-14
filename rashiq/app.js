(() => {
  'use strict';

  const DATA = window.RASHIQ_DATA || {};
  const BAGHDAD = DATA.baghdad || { lat: 33.3152, lng: 44.3661, zoom: 12, radiusKm: 38 };
  const SEED_GYMS = Array.isArray(DATA.seeds) ? DATA.seeds : [];
  const CACHE_KEY = 'rashiq_osm_cache_v2';
  const FAVORITES_KEY = 'rashiq_favorites_v2';
  const COMPARE_KEY = 'rashiq_compare_v2';
  const MAP_STYLE_KEY = 'rashiq_map_style_v2';
  const CACHE_TTL = 6 * 60 * 60 * 1000;
  const MAX_COMPARE = 3;

  const $ = id => document.getElementById(id);
  const els = {
    search: $('searchInput'), clearSearch: $('clearSearch'), refresh: $('refreshBtn'), locate: $('locateBtn'), floatingLocate: $('floatingLocate'),
    install: $('installBtn'), filters: $('filters'), gymList: $('gymList'), empty: $('emptyState'), reset: $('resetFilters'), gymCount: $('gymCount'),
    status: $('dataStatus'), coverage: $('coverageLabel'), hint: $('mapHint'), sidebar: $('sidebar'), sheetToggle: $('sheetToggle'),
    sortRecommended: $('sortRecommended'), sortNearest: $('sortNearest'), sortName: $('sortName'),
    detailsModal: $('detailsModal'), detailsContent: $('detailsContent'), compareModal: $('compareModal'), compareContent: $('compareContent'),
    compareBtn: $('compareBtn'), compareCount: $('compareCount'), aboutModal: $('aboutModal'), toast: $('toast'),
    cleanMapBtn: $('cleanMapBtn'), detailMapBtn: $('detailMapBtn'), fitBaghdadBtn: $('fitBaghdadBtn'), searchAreaBtn: $('searchAreaBtn'),
    viewportFilter: $('viewportFilter'), clearViewport: $('clearViewport')
  };

  const state = {
    all: SEED_GYMS.map(g => ({ ...g })), visible: [], filter: 'all', sort: 'recommended', search: '',
    favorites: new Set(readJSON(FAVORITES_KEY, [])), compare: new Set(readJSON(COMPARE_KEY, [])),
    userLocation: null, selectedId: null, map: null, clusterLayer: null, markers: new Map(), userMarker: null,
    deferredInstall: null, liveLoaded: false, viewportOnly: false, mapStyle: localStorage.getItem(MAP_STYLE_KEY) || 'clean',
    baseLayers: {}, activeBaseLayer: null, mapMovedByUser: false, loading: false
  };

  function readJSON(key, fallback) { try { const v = JSON.parse(localStorage.getItem(key)); return v ?? fallback; } catch { return fallback; } }
  function writeJSON(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} }
  function esc(value = '') { return String(value).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])); }
  function normalizeText(s = '') { return String(s).toLowerCase().normalize('NFKD').replace(/[\u064B-\u065F\u0670]/g,'').replace(/[أإآ]/g,'ا').replace(/ى/g,'ي').replace(/ة/g,'ه').replace(/[^a-z0-9\u0600-\u06ff]+/g,' ').trim(); }
  function kmBetween(a, b) { const R=6371,d2r=Math.PI/180,dLat=(b.lat-a.lat)*d2r,dLng=(b.lng-a.lng)*d2r; const x=Math.sin(dLat/2)**2+Math.cos(a.lat*d2r)*Math.cos(b.lat*d2r)*Math.sin(dLng/2)**2; return 2*R*Math.atan2(Math.sqrt(x),Math.sqrt(1-x)); }
  function distanceLabel(km) { if (!Number.isFinite(km)) return ''; return km < 1 ? `${Math.max(50, Math.round(km*1000/50)*50)} م` : `${km.toFixed(km < 10 ? 1 : 0)} كم`; }
  function typeLabel(type) { return ({classic:'أوزان ولياقة',functional:'Functional / HIIT',sports:'مركز رياضي',studio:'ستوديو تدريب'})[type] || 'لياقة'; }
  function sourceLabel(g) { return g.verified ? 'مراجع يدويًا' : 'OpenStreetMap'; }
  function formatReviewed(g) { return g.reviewedAt ? new Date(`${g.reviewedAt}T12:00:00`).toLocaleDateString('ar-IQ',{year:'numeric',month:'short',day:'numeric'}) : 'بيانات حيّة غير مراجعة يدويًا'; }

  function inferArea(lat, lng) {
    const areas = [
      ['المنصور',33.315,44.351],['اليرموك',33.304,44.346],['الحارثية',33.329,44.340],['الجادرية',33.274,44.389],
      ['الكرادة',33.302,44.423],['زيونة',33.329,44.454],['شارع فلسطين',33.347,44.421],['الأعظمية',33.371,44.371],
      ['العامرية',33.292,44.287],['الدورة',33.246,44.396],['الغدير',33.303,44.471],['بغداد الجديدة',33.312,44.489],
      ['السيدية',33.258,44.339],['الجامعة',33.321,44.304],['الشعب',33.405,44.453],['الكاظمية',33.379,44.337]
    ];
    let best = null;
    for (const [name,aLat,aLng] of areas) { const d=kmBetween({lat,lng},{lat:aLat,lng:aLng}); if(!best||d<best.d) best={name,d}; }
    return best && best.d < 4.8 ? best.name : 'بغداد';
  }

  function classify(tags, name) {
    const s = normalizeText(`${name} ${Object.values(tags || {}).join(' ')}`);
    if (/crossfit|cross fit|functional|f45|hiit|كروس|وظيفي/.test(s)) return 'functional';
    if (/padel|sport centre|sports centre|sports center|مركز رياضي|بادل/.test(s)) return 'sports';
    if (/studio|personal training|fit20|pilates|yoga|ستوديو|يوغا|بيلاتس/.test(s)) return 'studio';
    return 'classic';
  }
  function isWomenOnly(tags, name) { const s=normalizeText(`${name} ${Object.values(tags||{}).join(' ')}`); return /women|woman|ladies|female|نسائي|نساء|سيدات|للسيدات/.test(s); }
  function parsePhone(tags={}) { return tags.phone || tags['contact:phone'] || tags.mobile || tags['contact:mobile'] || ''; }
  function parseAddress(tags={}) { const parts=[tags['addr:street'],tags['addr:suburb'],tags['addr:district'],tags['addr:city']].filter(Boolean); return parts.length ? [...new Set(parts)].join('، ') : ''; }
  function externalUrl(value, type='web') {
    if (!value) return '';
    let v = String(value).trim();
    if (type === 'instagram' && !/^https?:\/\//i.test(v)) v = `https://instagram.com/${v.replace(/^@/,'')}`;
    if (!/^https?:\/\//i.test(v)) v = `https://${v}`;
    try { const u = new URL(v); return ['http:','https:'].includes(u.protocol) ? u.href : ''; } catch { return ''; }
  }

  function normalizeOSM(el) {
    const tags=el.tags||{},lat=el.lat??el.center?.lat,lng=el.lon??el.center?.lon;
    if(!Number.isFinite(lat)||!Number.isFinite(lng)) return null;
    const rawName=tags['name:ar']||tags.name||tags['name:en'];
    if(!rawName || !normalizeText(rawName)) return null;
    const opening=tags.opening_hours||'';
    return {
      id:`osm-${el.type}-${el.id}`, osmId:`${el.type}/${el.id}`, name:tags.name||rawName, nameAr:tags['name:ar']||'', lat,lng,
      area:tags['addr:suburb']||tags['addr:district']||inferArea(lat,lng), address:parseAddress(tags)||inferArea(lat,lng),
      phone:parsePhone(tags), type:classify(tags,rawName), women:isWomenOnly(tags,rawName), alwaysOpen:/24\s*\/\s*7/i.test(opening),
      hours:opening||'غير مذكور على الخريطة', rating:null,reviews:null,verified:false,reviewedAt:null,source:'OpenStreetMap',
      website:tags.website||tags['contact:website']||'', instagram:tags.instagram||tags['contact:instagram']||'',
      amenities:[tags.sauna==='yes'?'ساونا':'',tags.shower==='yes'?'دوش':'',tags['wheelchair']==='yes'?'دخول مهيأ':''].filter(Boolean),
      tags:Object.values(tags).filter(v=>typeof v==='string').slice(0,24)
    };
  }

  function genericName(s) { return normalizeText(s).replace(/\b(gym|fitness|club|hall|center|centre|جيم|فتنس|نادي|قاعة|مركز)\b/g,'').trim(); }
  function similarName(a,b) {
    const A=genericName(a),B=genericName(b); if(!A||!B) return false; if(A===B||A.includes(B)||B.includes(A)) return true;
    const ta=new Set(A.split(' ')),tb=new Set(B.split(' ')); let hit=0; for(const t of ta) if(tb.has(t)) hit++; return hit/Math.max(ta.size,tb.size)>=0.67;
  }
  function mergeData(osmGyms) {
    const merged=SEED_GYMS.map(x=>({...x}));
    for(const g of osmGyms) {
      let duplicateIndex=-1;
      for(let i=0;i<merged.length;i++) { const d=kmBetween(g,merged[i]); if(d<0.22 && similarName(g.nameAr||g.name, merged[i].nameAr||merged[i].name)){duplicateIndex=i;break;} }
      if(duplicateIndex>=0) {
        const s=merged[duplicateIndex];
        merged[duplicateIndex]={...g,...s,phone:s.phone||g.phone,hours:s.hours||g.hours,address:s.address||g.address,area:s.area||g.area,website:s.website||g.website,instagram:s.instagram||g.instagram,amenities:[...new Set([...(s.amenities||[]),...(g.amenities||[])])],osmId:g.osmId,osmLinked:true};
      } else merged.push(g);
    }
    return merged.filter(g=>Number.isFinite(g.lat)&&Number.isFinite(g.lng)&&kmBetween(BAGHDAD,g)<=BAGHDAD.radiusKm+2);
  }

  function setStatus(kind,text) { els.status.classList.toggle('loading',kind==='loading'); els.status.classList.toggle('offline',kind==='offline'); els.status.innerHTML=`<i></i> ${esc(text)}`; }
  function updateNetworkStatus() { if(!navigator.onLine) setStatus('offline','أوفلاين · آخر بيانات محفوظة'); else if(state.liveLoaded) setStatus('ok','قاعدة مراجعة + OSM حي'); }

  function buildBaseLayers() {
    state.baseLayers.clean=L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',{maxZoom:20,subdomains:'abcd',attribution:'&copy; OpenStreetMap contributors &copy; CARTO'});
    state.baseLayers.detail=L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'&copy; OpenStreetMap contributors'});
  }
  function setBaseMap(style) {
    if(!state.map || !state.baseLayers[style]) return;
    if(state.activeBaseLayer) state.map.removeLayer(state.activeBaseLayer);
    state.activeBaseLayer=state.baseLayers[style]; state.activeBaseLayer.addTo(state.map); state.mapStyle=style; localStorage.setItem(MAP_STYLE_KEY,style);
    els.cleanMapBtn.classList.toggle('active',style==='clean'); els.detailMapBtn.classList.toggle('active',style==='detail');
  }
  function clusterIcon(cluster) {
    const n=cluster.getChildCount(),cls=n>=50?'xl':n>=15?'large':'';
    return L.divIcon({html:`<div class="cluster-core ${cls}">${n}</div>`,className:'rash-cluster',iconSize:L.point(n>=50?54:n>=15?48:42,n>=50?54:n>=15?48:42)});
  }
  function initMap() {
    if(!window.L) { els.hint.textContent='تعذر تحميل محرك الخريطة'; setStatus('offline','تعذر تحميل الخريطة'); return false; }
    state.map=L.map('map',{zoomControl:false,preferCanvas:true,minZoom:10,maxZoom:19}).setView([BAGHDAD.lat,BAGHDAD.lng],BAGHDAD.zoom);
    L.control.zoom({position:'bottomleft'}).addTo(state.map); buildBaseLayers(); setBaseMap(state.mapStyle in state.baseLayers?state.mapStyle:'clean');
    state.clusterLayer = typeof L.markerClusterGroup==='function'
      ? L.markerClusterGroup({showCoverageOnHover:false,spiderfyOnMaxZoom:true,removeOutsideVisibleBounds:true,chunkedLoading:true,maxClusterRadius:52,iconCreateFunction:clusterIcon})
      : L.layerGroup();
    state.clusterLayer.addTo(state.map);
    state.map.on('dragend zoomend',()=>{ state.mapMovedByUser=true; if(!state.viewportOnly) els.searchAreaBtn.classList.add('show'); if(state.viewportOnly) render(); });
    state.map.on('moveend',()=>{const c=state.map.getCenter();els.hint.textContent=`${inferArea(c.lat,c.lng)} · تكبير ${state.map.getZoom()}`;});
    return true;
  }

  function markerIcon(g, selected=false) { return L.divIcon({className:'',html:`<div class="gym-pin ${g.verified?'verified':'osm'} ${selected?'active':''}"><div class="gym-pin-core"></div></div>`,iconSize:[selected?40:34,44],iconAnchor:[selected?20:17,40],popupAnchor:[0,-35]}); }
  function popupHTML(g) { return `<div class="popup"><h4>${esc(g.nameAr||g.name)}</h4><p>${esc(g.area)} · ${esc(typeLabel(g.type))}</p><div class="popup-meta"><span>${g.verified?'مراجع':'OSM'}</span>${g.women?'<span>للنساء</span>':''}${g.alwaysOpen?'<span>24/7</span>':''}</div><button class="popup-btn" data-popup-id="${esc(g.id)}">شوف التفاصيل</button></div>`; }
  function syncMarkers(list) {
    if(!state.map || !state.clusterLayer) return;
    state.clusterLayer.clearLayers(); state.markers.clear();
    const markers=[];
    for(const g of list) {
      const m=L.marker([g.lat,g.lng],{icon:markerIcon(g,state.selectedId===g.id),keyboard:true,title:g.nameAr||g.name})
        .bindPopup(popupHTML(g),{closeButton:false,offset:[0,-4]})
        .on('click',()=>selectGym(g.id,false));
      m.on('popupopen',e=>{const btn=e.popup.getElement()?.querySelector('[data-popup-id]');if(btn)btn.onclick=()=>openDetails(g.id);});
      state.markers.set(g.id,m); markers.push(m);
    }
    if(typeof state.clusterLayer.addLayers==='function') state.clusterLayer.addLayers(markers); else markers.forEach(m=>state.clusterLayer.addLayer(m));
  }

  function scoreGym(g) {
    let s=0; if(g.verified)s+=55; if(g.rating)s+=Math.max(0,g.rating-2.5)*9; if(g.reviews)s+=Math.min(16,Math.log10(g.reviews+1)*6);
    if(g.phone)s+=5; if(g.website||g.instagram)s+=3; if(g.hours&&!/غير مذكور|تحقق/.test(g.hours))s+=4; if(g.approximate)s-=5; return s;
  }
  function matchesSearch(g,q) {
    if(!q) return true; const tokens=normalizeText(q).split(' ').filter(Boolean); const hay=normalizeText([g.name,g.nameAr,g.area,g.address,typeLabel(g.type),...(g.tags||[]),...(g.amenities||[])].join(' ')); return tokens.every(t=>hay.includes(t));
  }
  function currentVisible() {
    const bounds=state.viewportOnly&&state.map?state.map.getBounds():null;
    let list=state.all.filter(g=>{
      if(state.filter==='verified'&&!g.verified)return false; if(state.filter==='classic'&&g.type!=='classic')return false; if(state.filter==='functional'&&g.type!=='functional')return false;
      if(state.filter==='women'&&!g.women)return false; if(state.filter==='247'&&!g.alwaysOpen)return false; if(state.filter==='saved'&&!state.favorites.has(g.id))return false;
      if(!matchesSearch(g,state.search))return false; if(bounds&&!bounds.contains([g.lat,g.lng]))return false; return true;
    });
    for(const g of list) g._distance=state.userLocation?kmBetween(state.userLocation,g):null;
    if(state.sort==='nearest'&&state.userLocation) list.sort((a,b)=>(a._distance??999)-(b._distance??999));
    else if(state.sort==='name') list.sort((a,b)=>(a.nameAr||a.name).localeCompare(b.nameAr||b.name,'ar'));
    else list.sort((a,b)=>scoreGym(b)-scoreGym(a)||(a.nameAr||a.name).localeCompare(b.nameAr||b.name,'ar'));
    return list;
  }

  function cardHTML(g) {
    const saved=state.favorites.has(g.id), compared=state.compare.has(g.id), title=g.nameAr||g.name, subtitle=g.nameAr&&g.nameAr!==g.name?g.name:typeLabel(g.type);
    return `<article class="gym-card ${state.selectedId===g.id?'selected':''}" data-id="${esc(g.id)}" tabindex="0">
      <div class="card-top"><div class="card-title"><h3>${esc(title)}</h3><p>${esc(subtitle)}</p></div><div class="card-buttons">
      <button class="compare-mini ${compared?'active':''}" data-compare="${esc(g.id)}" aria-label="${compared?'إزالة من المقارنة':'إضافة للمقارنة'}"><svg viewBox="0 0 24 24"><path d="M5 4v16m14-16v16M9 8h6m-6 8h6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></button>
      <button class="save-btn ${saved?'saved':''}" data-save="${esc(g.id)}" aria-label="${saved?'إزالة من المحفوظة':'حفظ الجيم'}"><svg viewBox="0 0 24 24"><path d="M6 3h12v18l-6-4-6 4V3Z" fill="${saved?'currentColor':'none'}" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg></button></div></div>
      <div class="card-meta"><span class="badge">${esc(g.area)}</span><span class="badge">${esc(typeLabel(g.type))}</span>${g.women?'<span class="badge women">للنساء</span>':''}${g.alwaysOpen?'<span class="badge">24/7</span>':''}${g.verified?'<span class="badge verified">مراجع</span>':'<span class="badge osm">OSM</span>'}</div>
      <div class="card-actions"><div>${g.rating?`<span class="rating"><i>★</i> ${g.rating.toFixed(1)}${g.reviews?` <small>(${g.reviews})</small>`:''}</span>`:'<span class="rating">بدون تقييم موثوق</span>'}</div><div class="distance">${g._distance!=null?esc(distanceLabel(g._distance)):(g.phone?'اتصال متاح':'')}</div><button data-directions="${esc(g.id)}">الاتجاهات</button></div></article>`;
  }
  function updateCompareBadge() { const n=state.compare.size; els.compareCount.textContent=n?String(n):''; els.compareBtn.setAttribute('aria-label',`فتح المقارنة${n?`، ${n} جيم`:''}`); writeJSON(COMPARE_KEY,[...state.compare]); }
  function render({fitMap=false}={}) {
    state.visible=currentVisible(); els.gymCount.textContent=`${state.visible.length} جيم`; els.gymList.innerHTML=state.visible.map(cardHTML).join(''); els.empty.hidden=state.visible.length!==0;
    els.viewportFilter.hidden=!state.viewportOnly; syncMarkers(state.visible); updateCompareBadge();
    if(fitMap&&state.visible.length&&state.map){const bounds=L.latLngBounds(state.visible.map(g=>[g.lat,g.lng]));state.map.fitBounds(bounds.pad(.12),{maxZoom:14,animate:true});}
  }

  function selectGym(id, pan=true) {
    state.selectedId=id; const g=state.all.find(x=>x.id===id); render(); if(!g||!pan||!state.map)return;
    const marker=state.markers.get(id); const show=()=>{state.map.flyTo([g.lat,g.lng],Math.max(state.map.getZoom(),15),{duration:.65});setTimeout(()=>marker?.openPopup(),450);};
    if(state.clusterLayer&&typeof state.clusterLayer.zoomToShowLayer==='function'&&marker) state.clusterLayer.zoomToShowLayer(marker,show); else show();
  }
  function toggleFavorite(id) { if(state.favorites.has(id))state.favorites.delete(id);else state.favorites.add(id);writeJSON(FAVORITES_KEY,[...state.favorites]);render();toast(state.favorites.has(id)?'انحفظ الجيم':'انشال من المحفوظة'); }
  function toggleCompare(id) {
    if(state.compare.has(id)){state.compare.delete(id);render();toast('انشال من المقارنة');return;}
    if(state.compare.size>=MAX_COMPARE){toast('تكدر تقارن 3 جيمات كحد أقصى');openCompare();return;}
    state.compare.add(id);render();toast(`انضاف للمقارنة · ${state.compare.size}/${MAX_COMPARE}`);
  }
  function openDirections(id) { const g=state.all.find(x=>x.id===id);if(!g)return;window.open(`https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(`${g.lat},${g.lng}`)}`,'_blank','noopener,noreferrer'); }

  function detailHTML(g) {
    const saved=state.favorites.has(g.id),compared=state.compare.has(g.id),web=externalUrl(g.website),ig=externalUrl(g.instagram,'instagram');
    return `<div class="detail-kicker">${esc(sourceLabel(g))}</div><h2 class="detail-title" id="detailsTitle">${esc(g.nameAr||g.name)}</h2>${g.nameAr&&g.nameAr!==g.name?`<p class="detail-address">${esc(g.name)}</p>`:''}
      <div class="detail-badges"><span>${esc(typeLabel(g.type))}</span><span>${esc(g.area)}</span>${g.women?'<span class="women">للنساء</span>':''}${g.alwaysOpen?'<span>24/7</span>':''}${g.verified?'<span class="verified">✓ مراجع</span>':'<span class="osm">OSM · غير مراجع يدويًا</span>'}</div>
      <div class="detail-info"><div class="info-box"><span>العنوان</span><b>${esc(g.address||g.area)}</b></div><div class="info-box"><span>الدوام</span><b>${esc(g.hours||'غير مذكور')}</b></div><div class="info-box"><span>الهاتف</span><b>${g.phone?`<a href="tel:${esc(g.phone)}">${esc(g.phone)}</a>`:'غير متوفر'}</b></div><div class="info-box"><span>المسافة</span><b>${state.userLocation?esc(distanceLabel(kmBetween(state.userLocation,g))):'فعّل موقعك لحسابها'}</b></div></div>
      ${(g.amenities||[]).length?`<div class="info-box"><span>مرافق مذكورة</span><b>${esc(g.amenities.join(' · '))}</b></div>`:''}${g.rating?`<div class="info-box"><span>التقييم الموجود بالدليل</span><b>★ ${g.rating.toFixed(1)}${g.reviews?` · ${g.reviews} مراجعة`:''}</b></div>`:''}
      <div class="detail-note">${g.approximate?'موضع الدبوس تقريبي. ':''}${g.verified?`آخر مراجعة يدوية: ${esc(formatReviewed(g))}. `:'هذا الموقع مستورد من OpenStreetMap ولم نتحقق منه يدويًا. '}أوقات العمل والأسعار ممكن تتغير؛ تأكد من الجيم قبل الزيارة.</div>
      <div class="detail-actions"><button class="primary" data-detail-directions="${esc(g.id)}">افتح الاتجاهات</button>${g.phone?`<a href="tel:${esc(g.phone)}">اتصل</a>`:''}${web?`<a href="${esc(web)}" target="_blank" rel="noopener noreferrer">الموقع</a>`:''}${ig?`<a href="${esc(ig)}" target="_blank" rel="noopener noreferrer">Instagram</a>`:''}<button class="${saved?'active':''}" data-detail-save="${esc(g.id)}">${saved?'محفوظ ✓':'حفظ'}</button><button class="${compared?'active':''}" data-detail-compare="${esc(g.id)}">${compared?'ضمن المقارنة ✓':'قارن'}</button><button data-detail-share="${esc(g.id)}">مشاركة</button></div>`;
  }
  function openDetails(id,{pan=true}={}) { const g=state.all.find(x=>x.id===id);if(!g)return;if(pan)selectGym(id,true);els.detailsContent.innerHTML=detailHTML(g);els.detailsModal.classList.add('open');els.detailsModal.setAttribute('aria-hidden','false'); }
  function refreshDetails(id) { const g=state.all.find(x=>x.id===id);if(g&&els.detailsModal.classList.contains('open'))els.detailsContent.innerHTML=detailHTML(g); }
  function closeDetails() { els.detailsModal.classList.remove('open');els.detailsModal.setAttribute('aria-hidden','true'); }

  function compareHTML() {
    const gyms=[...state.compare].map(id=>state.all.find(g=>g.id===id)).filter(Boolean);
    if(!gyms.length)return `<div class="compare-head"><h2 id="compareTitle">قارن الجيمات</h2><p>اختار زر المقارنة من أي بطاقة. تكدر تضيف لحد 3 جيمات.</p></div><div class="compare-empty">بعدك ما ضفت أي جيم للمقارنة.</div>`;
    return `<div class="compare-head"><h2 id="compareTitle">مقارنة ${gyms.length} جيم</h2><p>المقارنة تعتمد على البيانات المتوفرة حاليًا؛ الفراغ يعني أن المعلومة غير متوفرة، مو أنها غير موجودة.</p></div><div class="compare-grid">${gyms.map(g=>`<article class="compare-card"><button class="compare-remove" data-remove-compare="${esc(g.id)}" aria-label="إزالة">×</button><h3>${esc(g.nameAr||g.name)}</h3><div class="compare-row"><span>المنطقة</span><b>${esc(g.area)}</b></div><div class="compare-row"><span>النوع</span><b>${esc(typeLabel(g.type))}</b></div><div class="compare-row"><span>المصدر</span><b>${esc(sourceLabel(g))}</b></div><div class="compare-row"><span>التقييم</span><b>${g.rating?`★ ${g.rating.toFixed(1)}`:'غير متوفر'}</b></div><div class="compare-row"><span>الدوام</span><b>${esc(g.hours||'غير متوفر')}</b></div><div class="compare-row"><span>المسافة</span><b>${state.userLocation?esc(distanceLabel(kmBetween(state.userLocation,g))):'فعّل موقعك'}</b></div><div class="compare-row"><span>التواصل</span><b>${g.phone?'هاتف متوفر':'غير متوفر'}</b></div><button class="go" data-compare-go="${esc(g.id)}">شوف على الخريطة</button></article>`).join('')}</div>`;
  }
  function openCompare(){els.compareContent.innerHTML=compareHTML();els.compareModal.classList.add('open');els.compareModal.setAttribute('aria-hidden','false');}
  function closeCompare(){els.compareModal.classList.remove('open');els.compareModal.setAttribute('aria-hidden','true');}
  function openAbout(){els.aboutModal.classList.add('open');els.aboutModal.setAttribute('aria-hidden','false');}
  function closeAbout(){els.aboutModal.classList.remove('open');els.aboutModal.setAttribute('aria-hidden','true');}
  async function shareGym(id){const g=state.all.find(x=>x.id===id);if(!g)return;const url=`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${g.lat},${g.lng}`)}`,data={title:g.nameAr||g.name,text:`${g.nameAr||g.name} — ${g.area}`,url};try{if(navigator.share)await navigator.share(data);else if(navigator.clipboard){await navigator.clipboard.writeText(`${data.text}\n${url}`);toast('تم نسخ رابط الجيم');}else window.open(url,'_blank','noopener,noreferrer');}catch(e){if(e?.name!=='AbortError')toast('تعذرت المشاركة');}}

  function showUserMarker(lat,lng){if(!state.map)return;if(state.userMarker)state.map.removeLayer(state.userMarker);const icon=L.divIcon({className:'',html:'<div class="user-dot"></div>',iconSize:[28,28],iconAnchor:[14,14]});state.userMarker=L.marker([lat,lng],{icon,zIndexOffset:1000}).addTo(state.map).bindPopup('موقعك التقريبي');}
  function locateUser({sort=true}={}){
    if(!navigator.geolocation){toast('المتصفح ما يدعم تحديد الموقع');return;}els.hint.textContent='جاي نحدد موقعك…';
    navigator.geolocation.getCurrentPosition(pos=>{const{latitude:lat,longitude:lng,accuracy}=pos.coords;state.userLocation={lat,lng,accuracy};showUserMarker(lat,lng);if(sort)state.sort='nearest';updateSortButtons();render();state.map?.flyTo([lat,lng],14,{duration:.8});const d=kmBetween(BAGHDAD,{lat,lng});els.hint.textContent=d>55?'موقعك الحالي بعيد عن مركز بغداد':`موقعك محدد · دقة ${Math.round(accuracy)} م`;toast('رتبنا الجيمات حسب قربها منك');},err=>{els.hint.textContent='اسحب الخريطة واستكشف بغداد';toast(err.code===1?'فعّل إذن الموقع حتى نحسب الأقرب':'تعذر تحديد موقعك الآن');},{enableHighAccuracy:true,timeout:10000,maximumAge:180000});
  }
  function updateSortButtons(){els.sortRecommended.classList.toggle('active',state.sort==='recommended');els.sortNearest.classList.toggle('active',state.sort==='nearest');els.sortName.classList.toggle('active',state.sort==='name');}
  function setFilter(filter){state.filter=filter;document.querySelectorAll('.filter').forEach(b=>b.classList.toggle('active',b.dataset.filter===filter));render({fitMap:false});}
  function resetAllFilters(){state.search='';els.search.value='';els.clearSearch.hidden=true;state.viewportOnly=false;els.searchAreaBtn.classList.remove('active','show');setFilter('all');}
  function toast(message){els.toast.textContent=message;els.toast.classList.add('show');clearTimeout(toast._t);toast._t=setTimeout(()=>els.toast.classList.remove('show'),2600);}

  function overpassQuery(){return`[out:json][timeout:25];(nwr["leisure"="fitness_centre"](around:35000,${BAGHDAD.lat},${BAGHDAD.lng});nwr["leisure"="sports_centre"]["sport"~"fitness|bodybuilding|weightlifting|crossfit",i](around:35000,${BAGHDAD.lat},${BAGHDAD.lng});nwr["sport"~"fitness|bodybuilding|weightlifting|crossfit",i](around:35000,${BAGHDAD.lat},${BAGHDAD.lng});nwr["amenity"="gym"](around:35000,${BAGHDAD.lat},${BAGHDAD.lng}););out center tags;`;}
  async function fetchWithTimeout(url,options={},ms=16000){const controller=new AbortController(),t=setTimeout(()=>controller.abort(),ms);try{return await fetch(url,{...options,signal:controller.signal,cache:'no-store'});}finally{clearTimeout(t);}}
  async function loadLiveData({force=false}={}){
    if(state.loading)return;state.loading=true;const cached=readJSON(CACHE_KEY,null);
    if(!force&&cached?.data?.length){state.all=mergeData(cached.data);state.liveLoaded=true;render();const age=Date.now()-cached.ts;els.coverage.textContent=`آخر تحميل ${new Date(cached.ts).toLocaleTimeString('ar-IQ',{hour:'2-digit',minute:'2-digit'})}`;if(age<CACHE_TTL){setStatus('ok','قاعدة مراجعة + OSM حي');state.loading=false;return;}}
    if(!navigator.onLine){setStatus('offline','أوفلاين · آخر بيانات محفوظة');state.loading=false;return;}
    setStatus('loading','جاري تحديث جيمات بغداد…');els.refresh.classList.add('loading');
    const endpoints=['https://overpass-api.de/api/interpreter','https://overpass.kumi.systems/api/interpreter','https://overpass.nchc.org.tw/api/interpreter'];let lastErr=null;
    for(const endpoint of endpoints){try{const body=new URLSearchParams({data:overpassQuery()}),res=await fetchWithTimeout(endpoint,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded;charset=UTF-8'},body},18000);if(!res.ok)throw new Error(`HTTP ${res.status}`);const json=await res.json(),gyms=(json.elements||[]).map(normalizeOSM).filter(Boolean).filter(g=>kmBetween(BAGHDAD,g)<=BAGHDAD.radiusKm);if(!gyms.length)throw new Error('empty response');writeJSON(CACHE_KEY,{ts:Date.now(),data:gyms});state.all=mergeData(gyms);state.liveLoaded=true;render();setStatus('ok','قاعدة مراجعة + OSM حي');els.coverage.textContent=`${gyms.length} OSM + ${SEED_GYMS.length} مراجع`;els.refresh.classList.remove('loading');state.loading=false;return;}catch(e){lastErr=e;}}
    setStatus('offline','القاعدة المحلية · تعذر التحديث');els.coverage.textContent=cached?.data?.length?'نعرض آخر نسخة محفوظة':'نعرض القاعدة المراجعة فقط';els.refresh.classList.remove('loading');if(!cached?.data?.length)state.all=SEED_GYMS.map(g=>({...g}));render();state.loading=false;console.warn('RASH.IQ Overpass fetch failed',lastErr);
  }

  function setViewportMode(on){state.viewportOnly=on;els.searchAreaBtn.classList.toggle('active',on);els.searchAreaBtn.textContent=on?'عرض المنطقة مفعّل':'اعرض الجيمات بهالمنطقة';els.searchAreaBtn.classList.toggle('show',on);render();}
  function fitBaghdad(){state.viewportOnly=false;els.searchAreaBtn.classList.remove('active','show');state.map?.setView([BAGHDAD.lat,BAGHDAD.lng],BAGHDAD.zoom,{animate:true});render();}

  function bindEvents(){
    els.search.addEventListener('input',e=>{state.search=e.target.value;els.clearSearch.hidden=!state.search;render();});
    els.clearSearch.addEventListener('click',()=>{state.search='';els.search.value='';els.clearSearch.hidden=true;render();els.search.focus();});
    els.filters.addEventListener('click',e=>{const b=e.target.closest('[data-filter]');if(b)setFilter(b.dataset.filter);});
    els.reset.addEventListener('click',resetAllFilters);els.refresh.addEventListener('click',()=>loadLiveData({force:true}));els.locate.addEventListener('click',()=>locateUser());els.floatingLocate.addEventListener('click',()=>locateUser());
    els.sortRecommended.addEventListener('click',()=>{state.sort='recommended';updateSortButtons();render();});els.sortNearest.addEventListener('click',()=>{if(!state.userLocation){locateUser();return;}state.sort='nearest';updateSortButtons();render();});els.sortName.addEventListener('click',()=>{state.sort='name';updateSortButtons();render();});els.sheetToggle.addEventListener('click',()=>{els.sidebar.classList.toggle('collapsed');setTimeout(()=>state.map?.invalidateSize(),260);});
    els.cleanMapBtn.addEventListener('click',()=>setBaseMap('clean'));els.detailMapBtn.addEventListener('click',()=>setBaseMap('detail'));els.fitBaghdadBtn.addEventListener('click',fitBaghdad);els.searchAreaBtn.addEventListener('click',()=>setViewportMode(!state.viewportOnly));els.clearViewport.addEventListener('click',()=>setViewportMode(false));
    els.compareBtn.addEventListener('click',openCompare);
    els.gymList.addEventListener('click',e=>{const save=e.target.closest('[data-save]');if(save){e.stopPropagation();toggleFavorite(save.dataset.save);return;}const compare=e.target.closest('[data-compare]');if(compare){e.stopPropagation();toggleCompare(compare.dataset.compare);return;}const directions=e.target.closest('[data-directions]');if(directions){e.stopPropagation();openDirections(directions.dataset.directions);return;}const card=e.target.closest('.gym-card');if(card)openDetails(card.dataset.id);});
    els.gymList.addEventListener('keydown',e=>{if((e.key==='Enter'||e.key===' ')&&e.target.classList.contains('gym-card')){e.preventDefault();openDetails(e.target.dataset.id);}});
    document.addEventListener('click',e=>{
      if(e.target.closest('[data-close-modal]'))closeDetails();if(e.target.closest('[data-close-compare]'))closeCompare();if(e.target.closest('[data-close-about]'))closeAbout();
      const d=e.target.closest('[data-detail-directions]');if(d)openDirections(d.dataset.detailDirections);
      const s=e.target.closest('[data-detail-save]');if(s){toggleFavorite(s.dataset.detailSave);refreshDetails(s.dataset.detailSave);}
      const c=e.target.closest('[data-detail-compare]');if(c){toggleCompare(c.dataset.detailCompare);refreshDetails(c.dataset.detailCompare);}
      const sh=e.target.closest('[data-detail-share]');if(sh)shareGym(sh.dataset.detailShare);
      const rm=e.target.closest('[data-remove-compare]');if(rm){state.compare.delete(rm.dataset.removeCompare);render();openCompare();}
      const go=e.target.closest('[data-compare-go]');if(go){closeCompare();openDetails(go.dataset.compareGo);}
    });
    document.addEventListener('keydown',e=>{if(e.key==='Escape'){closeDetails();closeCompare();closeAbout();}});
    document.querySelectorAll('.nav-item').forEach(btn=>btn.addEventListener('click',()=>{document.querySelectorAll('.nav-item').forEach(x=>x.classList.toggle('active',x===btn));const nav=btn.dataset.nav;if(nav==='map'){els.sidebar.classList.add('collapsed');setTimeout(()=>state.map?.invalidateSize(),260);}if(nav==='nearby'){els.sidebar.classList.remove('collapsed');locateUser();}if(nav==='saved'){els.sidebar.classList.remove('collapsed');setFilter('saved');}if(nav==='compare')openCompare();if(nav==='about')openAbout();}));
    window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();state.deferredInstall=e;els.install.hidden=false;});
    els.install.addEventListener('click',async()=>{if(state.deferredInstall){state.deferredInstall.prompt();await state.deferredInstall.userChoice;state.deferredInstall=null;els.install.hidden=true;return;}toast('على iPhone: Safari ← مشاركة ← إضافة إلى الشاشة الرئيسية');});
    window.addEventListener('appinstalled',()=>{els.install.hidden=true;toast('RASH.IQ انثبت على جهازك');});window.addEventListener('online',()=>{updateNetworkStatus();loadLiveData();});window.addEventListener('offline',updateNetworkStatus);
  }
  function prepareInstallHint(){const ios=/iphone|ipad|ipod/i.test(navigator.userAgent),standalone=window.matchMedia?.('(display-mode: standalone)').matches||navigator.standalone;if(ios&&!standalone)els.install.hidden=false;}
  function registerSW(){if('serviceWorker'in navigator&&(location.protocol==='https:'||location.hostname==='localhost'))navigator.serviceWorker.register('./sw.js').catch(()=>{});}
  function cleanPersistedSets(){const ids=new Set(state.all.map(g=>g.id));state.compare=new Set([...state.compare].filter(id=>ids.has(id)||String(id).startsWith('osm-')));updateCompareBadge();}
  function init(){const mapOK=initMap();bindEvents();cleanPersistedSets();render();registerSW();prepareInstallHint();updateNetworkStatus();if(mapOK)setTimeout(()=>state.map.invalidateSize(),120);loadLiveData();}
  init();
})();
