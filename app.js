/* ===== افراچوب — منطق اصلی اپ (نسخه ۹) ===== */

const STAGES = [
  { name: 'اندازه‌گیری', type: 'check' },
  { name: 'تایید طراحی', type: 'check' },
  { name: 'آنالیز', type: 'check' },
  { name: 'ساخت و برش', type: 'progress' },
  { name: 'ارسال بار به محل ساختمان', type: 'check' },
  { name: 'در حال نصب', type: 'progress', requiresPanel: true },
  { name: 'در انتظار تحویل‌دهی به مالک', type: 'check' },
  { name: 'خاتمه قرارداد', type: 'check' }
];
const WARN_DAYS = 7;

// V9 — Smart Alerts / Dashboard thresholds (متمرکز، قابل تغییر در آینده توسط مدیر)
const ALERT_THRESHOLDS = {
  NEAR_DUE_DAYS: 3,
  STALE_UPDATE_DAYS: 3
};

let auth = null, db = null;
let currentUser = null;
let myRole = null;
let myPosition = '';
let contracts = [];
let usersList = [];
let openCardId = null;
let adminTab = 'dashboard';   // 'dashboard' | 'users' | 'warnings'
let supervisorTab = 'contracts'; // 'contracts' | 'warnings'
let dataSubscribed = false;
let historyOpen = {};         // id -> bool
let approveTargetUid = null;
let authErrorMsg = '';

// V9 — state جدید
let searchQuery = '';
let filters = { status: 'all', stage: 'all', due: 'all', owner: 'all' };
let currentListCtx = { isAdmin: false, predicate: null };
let detailContractId = null;
let alertsPanelOpen = false;
let quickUpdateOpen = false;
let quickData = { contractId: null, stageIdx: null, checkDone: false };

function setStatus(text, ok){
  const n = document.getElementById('syncNote'), d = document.getElementById('statusDot');
  if(n) n.textContent = text;
  if(d) d.className = 'dot' + (ok ? '' : ' off');
}
function escapeHtml(s){ const d = document.createElement('div'); d.textContent = s||''; return d.innerHTML; }
function historyEntry(label){ return { label, time: new Date().toISOString(), by: (currentUser && currentUser.email) || '' }; }

/* ---------- Jalali <-> Gregorian ---------- */
function div_(a,b){ return Math.floor(a/b); }
function jalaliToGregorian(jy, jm, jd){
  jy = parseInt(jy,10)+1595;
  let days = -355668 + (365*jy) + (div_(jy,33)*8) + div_(((jy%33)+3),4) + parseInt(jd,10) +
             ((jm<7)?(jm-1)*31:((jm-7)*30)+186);
  let gy = 400*div_(days,146097); days %= 146097;
  if(days > 36524){ gy += 100*div_(--days,36524); days %= 36524; if(days >= 365) days++; }
  gy += 4*div_(days,1461); days %= 1461;
  if(days > 365){ gy += div_((days-1),365); days = (days-1)%365; }
  let gd = days+1;
  const leap = (gy%4===0 && gy%100!==0) || (gy%400===0);
  const sal = [0,31,leap?29:28,31,30,31,30,31,31,30,31,30,31];
  let gm; for(gm=1; gm<=12 && gd>sal[gm]; gm++) gd -= sal[gm];
  return [gy,gm,gd];
}
function parseJalaliStr(str){
  const p = (str||'').trim().split('/').map(s=>parseInt(s,10));
  if(p.length!==3 || p.some(isNaN)) return null;
  return p;
}
function jalaliStrToDate(str){
  const p = parseJalaliStr(str);
  if(!p) return null;
  const [gy,gm,gd] = jalaliToGregorian(p[0],p[1],p[2]);
  const dt = new Date(gy, gm-1, gd);
  dt.setHours(0,0,0,0);
  return dt;
}
function todayMid(){ const d = new Date(); d.setHours(0,0,0,0); return d; }
function daysBetween(a,b){ return Math.round((b-a)/86400000); }

/* ---------- Stage helpers ---------- */
function getCurrentIndex(c){
  const status = c.status || {};
  for(let i=0;i<STAGES.length;i++){
    if(!isStageDone(status, i)) return i;
  }
  return STAGES.length - 1;
}
function isStageDone(status, i){
  const s = status[i] || {};
  const st = STAGES[i];
  if(st.type === 'check') return !!s.done;
  if(st.requiresPanel) return (s.percent||0) >= 100 && !!s.panelInstalled;
  return (s.percent||0) >= 100;
}
function overallPercent(c){
  const status = c.status || {};
  let sum = 0;
  STAGES.forEach((st,i) => {
    const s = status[i] || {};
    sum += st.type === 'check' ? (s.done?100:0) : (s.percent||0);
  });
  return Math.round(sum/STAGES.length);
}
function isCompleted(c){ return overallPercent(c) === 100; }
function dueStatus(c){
  const activeDateStr = c.revisedDueDate || c.dueDate;
  if(!activeDateStr) return { label: 'سررسید ثبت نشده', cls:'none', daysLeft:null };
  const due = jalaliStrToDate(activeDateStr);
  if(!due) return { label: 'تاریخ نامعتبر', cls:'none', daysLeft:null };
  const dl = daysBetween(todayMid(), due);
  const prefix = c.revisedDueDate ? '(جبرانی) ' : '';
  if(dl < 0) return { label: prefix + Math.abs(dl) + ' روز از سررسید گذشته', cls:'late', daysLeft: dl };
  if(dl <= WARN_DAYS) return { label: prefix + dl + ' روز تا سررسید', cls:'warn', daysLeft: dl };
  return { label: prefix + dl + ' روز تا سررسید', cls:'ok', daysLeft: dl };
}
function scheduleText(c){
  if(!c.dueDate || !c.createdAt) return '';
  const due = jalaliStrToDate(c.revisedDueDate || c.dueDate);
  if(!due) return '';
  const start = new Date(c.createdAt);
  const totalDays = daysBetween(start, due);
  if(totalDays <= 0) return '';
  const elapsed = daysBetween(start, todayMid());
  const expected = Math.max(0, Math.min(100, Math.round((elapsed/totalDays)*100)));
  const actual = overallPercent(c);
  const diff = actual - expected;
  if(Math.abs(diff) < 5) return 'مطابق برنامه';
  return diff > 0 ? ('جلوتر از برنامه (+' + diff + '٪)') : ('عقب‌تر از برنامه (' + diff + '٪)');
}

/* ---------- V9: last update / KPIs / alerts (همه از داده واقعی contracts) ---------- */
function lastUpdateTime(c){
  const h = c.history || [];
  let latest = '';
  h.forEach(e => { if(e.time && e.time > latest) latest = e.time; });
  if(latest) return latest;
  return c.createdAt ? new Date(c.createdAt).toISOString() : null;
}
function daysSinceUpdate(c){
  const t = lastUpdateTime(c);
  if(!t) return null;
  return daysBetween(new Date(t), new Date());
}
function relativeDayLabel(iso){
  const d = new Date(iso);
  const now = new Date();
  const dOnly = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const nOnly = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diff = Math.round((nOnly - dOnly) / 86400000);
  if(diff === 0) return 'امروز';
  if(diff === 1) return 'دیروز';
  return d.toLocaleDateString('fa-IR');
}
function isNearDue(c){
  const st = dueStatus(c);
  return st.daysLeft != null && st.daysLeft >= 0 && st.daysLeft <= ALERT_THRESHOLDS.NEAR_DUE_DAYS;
}
function isStale(c){
  const d = daysSinceUpdate(c);
  return d != null && d >= ALERT_THRESHOLDS.STALE_UPDATE_DAYS;
}
function computeKPIs(list){
  const total = list.length;
  const completed = list.filter(isCompleted).length;
  const active = total - completed;
  const activeList = list.filter(c => !isCompleted(c));
  const late = activeList.filter(c => dueStatus(c).cls === 'late').length;
  const nearDue = activeList.filter(isNearDue).length;
  const stale = activeList.filter(isStale).length;
  const avgProgress = activeList.length ? Math.round(activeList.reduce((s,c)=>s+overallPercent(c),0) / activeList.length) : 0;
  return { total, active, completed, late, nearDue, stale, avgProgress };
}
function needsActionList(list){
  return list.filter(c => !isCompleted(c)).map(c => {
    const due = dueStatus(c);
    const stale = isStale(c);
    const late = due.cls === 'late';
    const near = isNearDue(c);
    if(!late && !near && !stale) return null;
    const severity = late ? 3 : (near ? 2 : 1);
    return { c, due, staleDays: daysSinceUpdate(c), stale, late, near, severity };
  }).filter(Boolean).sort((a,b) => b.severity - a.severity || (a.due.daysLeft ?? 999) - (b.due.daysLeft ?? 999));
}
function generateAlerts(list){
  const alerts = [];
  list.forEach(c => {
    if(isCompleted(c)) return;
    const due = dueStatus(c);
    if(due.cls === 'late'){
      alerts.push({ type:'A', id:c.id, text: c.name + ' — ' + due.label, time: lastUpdateTime(c) });
    } else if(isNearDue(c)){
      alerts.push({ type:'B', id:c.id, text: c.name + ' — ' + due.label, time: lastUpdateTime(c) });
    }
    if(isStale(c)){
      alerts.push({ type:'C', id:c.id, text: c.name + ' — ' + daysSinceUpdate(c) + ' روز بدون بروزرسانی', time: lastUpdateTime(c) });
    }
    const h = c.history || [];
    if(h.length){
      const last = h[h.length-1];
      if(last.time && (Date.now() - new Date(last.time).getTime()) <= 86400000){
        alerts.push({ type:'D', id:c.id, text: c.name + ' — ' + last.label, time: last.time });
      }
    }
  });
  return alerts.sort((a,b) => new Date(b.time||0) - new Date(a.time||0));
}
function alertTypeFa(t){
  return { A:'عقب‌افتاده', B:'نزدیک سررسید', C:'بدون بروزرسانی', D:'تغییر اخیر' }[t] || t;
}
function lastEditor(c){
  const h = c.history || [];
  for(let i = h.length - 1; i >= 0; i--){ if(h[i].by) return h[i].by; }
  return '';
}
function allEditors(list){
  const set = new Set();
  list.forEach(c => (c.history||[]).forEach(h => { if(h.by) set.add(h.by); }));
  return Array.from(set).sort();
}

/* ---------- V9: Search & Filter (فقط بر اساس فیلدهای واقعی Schema) ---------- */
function matchesFilters(c){
  if(searchQuery){
    const q = searchQuery.trim().toLowerCase();
    const hay = [c.name, c.itemCode, c.description].map(x => (x||'').toLowerCase()).join(' ');
    if(!hay.includes(q)) return false;
  }
  if(filters.status === 'active' && isCompleted(c)) return false;
  if(filters.status === 'closed' && !isCompleted(c)) return false;
  if(filters.status === 'late' && dueStatus(c).cls !== 'late') return false;
  if(filters.stage !== 'all'){
    if(getCurrentIndex(c) !== parseInt(filters.stage,10)) return false;
  }
  if(filters.due !== 'all'){
    const cls = dueStatus(c).cls;
    if(filters.due === 'late' && cls !== 'late') return false;
    if(filters.due === 'near' && !isNearDue(c)) return false;
    if(filters.due === 'normal' && (cls === 'late' || isNearDue(c))) return false;
  }
  if(filters.owner !== 'all' && lastEditor(c) !== filters.owner) return false;
  return true;
}
function renderFilterBarHtml(){
  const editors = allEditors(contracts);
  const stageOptions = STAGES.map((s,i) => `<option value="${i}" ${filters.stage==String(i)?'selected':''}>${s.name}</option>`).join('');
  const editorOptions = editors.map(e => `<option value="${escapeHtml(e)}" ${filters.owner===e?'selected':''}>${escapeHtml(e.split('@')[0])}</option>`).join('');
  return `
    <div class="filter-bar">
      <input class="filter-search" placeholder="جستجو — شماره قرارداد، کد قلم، توضیحات…" value="${escapeHtml(searchQuery)}" oninput="onSearchInput(this.value)">
      <div class="filter-row">
        <select onchange="onFilterChange('status', this.value)">
          <option value="all" ${filters.status==='all'?'selected':''}>همه وضعیت‌ها</option>
          <option value="active" ${filters.status==='active'?'selected':''}>فعال</option>
          <option value="closed" ${filters.status==='closed'?'selected':''}>خاتمه یافته</option>
          <option value="late" ${filters.status==='late'?'selected':''}>عقب‌افتاده</option>
        </select>
        <select onchange="onFilterChange('stage', this.value)">
          <option value="all" ${filters.stage==='all'?'selected':''}>همه مراحل</option>
          ${stageOptions}
        </select>
      </div>
      <div class="filter-row" style="margin-top:6px;">
        <select onchange="onFilterChange('due', this.value)">
          <option value="all" ${filters.due==='all'?'selected':''}>همه وضعیت‌های زمانی</option>
          <option value="late" ${filters.due==='late'?'selected':''}>عقب‌افتاده</option>
          <option value="near" ${filters.due==='near'?'selected':''}>نزدیک سررسید</option>
          <option value="normal" ${filters.due==='normal'?'selected':''}>عادی</option>
        </select>
        <select onchange="onFilterChange('owner', this.value)" ${editors.length?'':'disabled'}>
          <option value="all">همه مسئولان (آخرین ویرایشگر)</option>
          ${editorOptions}
        </select>
      </div>
    </div>`;
}
function onSearchInput(v){ searchQuery = v; refreshList(); }
function onFilterChange(key, v){ filters[key] = v; refreshList(); }
function refreshList(){ renderList(currentListCtx.isAdmin, currentListCtx.predicate); }

/* ---------- Auth ---------- */
function initAuthAndData(){
  try{
    if(!firebaseConfig || firebaseConfig.apiKey === 'PASTE_API_KEY_HERE'){
      document.getElementById('app').innerHTML = '<div class="setup-warning"><b>راه‌اندازی کامل نشده:</b> کلیدهای Firebase در firebase-config.js جایگزین نشده.</div>';
      setStatus('راه‌اندازی نشده', false);
      return;
    }
    firebase.initializeApp(firebaseConfig);
    auth = firebase.auth();
    db = firebase.firestore();

    auth.onAuthStateChanged(async (user) => {
      currentUser = user;
      dataSubscribed = false;
      if(!user){ myRole = null; myPosition = ''; renderApp(); return; }
      const ref = db.collection('users').doc(user.uid);
      let snap;
      try{
        snap = await ref.get();
      }catch(e){
        authErrorMsg = 'خطا در خواندن اطلاعات کاربر: ' + ((e&&e.code)?e.code+' — ':'') + (e&&e.message?e.message:String(e));
        renderApp();
        return;
      }
      if(!snap.exists){
        try{
          const role = (user.email === ADMIN_EMAIL) ? 'admin' : 'pending';
          await ref.set({ email:user.email, name:user.displayName||'', role, requestedAt: Date.now() });
        }catch(e){
          authErrorMsg = 'خطا در ساخت حساب کاربری: ' + ((e&&e.code)?e.code+' — ':'') + (e&&e.message?e.message:String(e));
          renderApp();
          return;
        }
      }
      ref.onSnapshot((doc) => {
        myRole = doc.exists ? doc.data().role : 'pending';
        myPosition = doc.exists ? (doc.data().position || '') : '';
        ensureDataSubscriptions();
        renderApp();
      }, (e) => {
        authErrorMsg = 'خطا در همگام‌سازی حساب: ' + ((e&&e.code)?e.code+' — ':'') + (e&&e.message?e.message:String(e));
        renderApp();
      });
    });
  }catch(e){
    setStatus('خطا در راه‌اندازی: ' + e.message, false);
  }
}

function ensureDataSubscriptions(){
  if(dataSubscribed) return;
  if(myRole !== 'admin' && myRole !== 'supervisor') return;
  dataSubscribed = true;
  db.collection('contracts').orderBy('createdAt','desc').onSnapshot((snap) => {
    contracts = snap.docs.map(d => ({ id:d.id, ...d.data() }));
    setStatus('همگام — لحظه‌ای', true);
    renderApp();
  }, (err) => setStatus('خطا: ' + err.message, false));

  if(myRole === 'admin'){
    db.collection('users').orderBy('requestedAt','desc').onSnapshot((snap) => {
      usersList = snap.docs.map(d => ({ id:d.id, ...d.data() }));
      renderApp();
    }, (err) => setStatus('خطا در کاربران: ' + err.message, false));
  }
}

function mapAuthError(e){
  const code = e && e.code;
  const map = {
    'auth/email-already-in-use': 'این ایمیل قبلاً ثبت شده — به‌جای «ساخت حساب جدید» از «ورود» استفاده کنید.',
    'auth/invalid-email': 'فرمت ایمیل درست نیست.',
    'auth/weak-password': 'رمز عبور خیلی ساده است، حداقل ۶ کاراکتر بنویسید.',
    'auth/wrong-password': 'رمز عبور اشتباه است.',
    'auth/user-not-found': 'حسابی با این ایمیل پیدا نشد — از «ساخت حساب جدید» استفاده کنید.',
    'auth/invalid-credential': 'ایمیل یا رمز عبور اشتباه است.',
    'auth/too-many-requests': 'تعداد تلاش‌ها زیاد بوده، کمی صبر کنید و دوباره امتحان کنید.',
    'auth/operation-not-allowed': 'ورود با ایمیل/رمز در Firebase فعال نشده — باید در Authentication → Sign-in method فعالش کنید.'
  };
  return map[code] || ((code?code+' — ':'') + (e && e.message ? e.message : String(e)));
}
function signIn(){
  authErrorMsg = '';
  const email = document.getElementById('authEmail').value.trim();
  const pass = document.getElementById('authPass').value;
  if(!email || !pass){ authErrorMsg = 'ایمیل و رمز عبور را وارد کنید.'; renderApp(); return; }
  auth.signInWithEmailAndPassword(email, pass).catch((e) => {
    authErrorMsg = mapAuthError(e);
    renderApp();
  });
}
function signUp(){
  authErrorMsg = '';
  const email = document.getElementById('authEmail').value.trim();
  const pass = document.getElementById('authPass').value;
  if(!email || !pass){ authErrorMsg = 'ایمیل و رمز عبور را وارد کنید.'; renderApp(); return; }
  if(pass.length < 6){ authErrorMsg = 'رمز عبور باید حداقل ۶ کاراکتر باشد.'; renderApp(); return; }
  auth.createUserWithEmailAndPassword(email, pass).catch((e) => {
    authErrorMsg = mapAuthError(e);
    renderApp();
  });
}
function signOutUser(){ auth.signOut(); }

/* ---------- Root render ---------- */
function renderApp(){
  const el = document.getElementById('app');
  const headerRight = document.getElementById('headerRight');

  if(!currentUser){
    headerRight.innerHTML = '';
    el.innerHTML = `
      <div class="center-screen">
        <img src="./icon-192.png" alt="افراچوب">
        <h2>ورود به افراچوب</h2>
        <p>برای مشاهده و مدیریت وضعیت قراردادها، با ایمیل و رمز عبور خود وارد شوید.</p>
        <input class="auth-input" type="email" id="authEmail" placeholder="ایمیل" autocomplete="username">
        <input class="auth-input" type="password" id="authPass" placeholder="رمز عبور" autocomplete="current-password">
        <button class="google-btn" style="justify-content:center; width:100%; max-width:320px;" onclick="signIn()">ورود</button>
        <button class="signout-btn" onclick="signUp()">ساخت حساب جدید</button>
        ${authErrorMsg ? `<p style="color:var(--red); font-size:12px; max-width:320px;">${escapeHtml(authErrorMsg)}</p>` : ''}
      </div>`;
    return;
  }

  const badgeText = myPosition ? escapeHtml(myPosition) : roleFa(myRole);
  const canSeeAlerts = myRole === 'admin' || myRole === 'supervisor';
  const alertCount = canSeeAlerts ? generateAlerts(contracts).length : 0;
  const bellHtml = canSeeAlerts ? `
    <button class="bell-btn" onclick="toggleAlertsPanel()">🔔${alertCount ? `<span class="bell-dot">${alertCount>99?'99+':alertCount}</span>` : ''}</button>` : '';
  headerRight.innerHTML = `<div style="display:flex;align-items:center;">
      ${bellHtml}
      <span class="role-badge">${badgeText}</span>
      <button class="signout-btn" onclick="signOutUser()">خروج</button>
    </div>`;

  if(myRole === 'pending'){
    el.innerHTML = `
      <div class="center-screen">
        <img src="./icon-192.png" alt="افراچوب">
        <h2>در انتظار تایید</h2>
        <p>حساب شما (${escapeHtml(currentUser.email)}) ثبت شد. تا وقتی مدیر دسترسی شما را تایید نکند، امکان مشاهده یا ویرایش اطلاعات وجود ندارد.</p>
        <span class="status-chip pending">در انتظار تایید مدیر</span>
      </div>`;
    return;
  }
  if(myRole === 'blocked'){
    el.innerHTML = `
      <div class="center-screen">
        <img src="./icon-192.png" alt="افراچوب">
        <h2>دسترسی لغو شده</h2>
        <p>دسترسی حساب ${escapeHtml(currentUser.email)} توسط مدیر لغو شده است.</p>
        <span class="status-chip blocked">مسدود شده</span>
      </div>`;
    return;
  }
  if(myRole === 'admin'){ renderAdmin(el); refreshOpenOverlays(); return; }
  if(myRole === 'supervisor'){ renderSupervisor(el); refreshOpenOverlays(); return; }

  el.innerHTML = `<div class="center-screen">
    <span class="sync-note"><span class="dot" id="statusDot"></span><span id="syncNote">در حال بارگذاری…</span></span>
    ${authErrorMsg ? `<p style="color:var(--red); font-family:'JetBrains Mono',monospace; font-size:11px; direction:ltr; max-width:320px;">${escapeHtml(authErrorMsg)}</p>` : ''}
    <button class="signout-btn" onclick="signOutUser()">خروج و تلاش دوباره</button>
  </div>`;
}

function roleFa(r){
  return { admin:'مدیر', supervisor:'سرپرست نصب', pending:'در انتظار تایید', blocked:'مسدود' }[r] || r;
}

/* ---------- V9: overlay refresh (نگه‌داشتن Modal های باز به‌روز، هنگام تغییر Real-time داده) ---------- */
function refreshOpenOverlays(){
  if(detailContractId && document.getElementById('detailModalBg').classList.contains('open')){
    renderDetailModalContent();
  }
  if(alertsPanelOpen){
    renderAlertsModalContent();
  }
}

/* ---------- V9: Smart Alerts panel ---------- */
function toggleAlertsPanel(){
  alertsPanelOpen = !alertsPanelOpen;
  const bg = document.getElementById('alertsModalBg');
  if(alertsPanelOpen){ renderAlertsModalContent(); bg.classList.add('open'); }
  else { bg.classList.remove('open'); }
}
function closeAlertsModal(){ alertsPanelOpen = false; document.getElementById('alertsModalBg').classList.remove('open'); }
function renderAlertsModalContent(){
  const box = document.getElementById('alertsModalInner');
  if(!box) return;
  const alerts = generateAlerts(contracts);
  box.innerHTML = `
    <h3>هشدارهای هوشمند <span style="color:var(--ink-faint); font-family:'JetBrains Mono',monospace; font-size:11px;">(${alerts.length} مورد)</span></h3>
    ${alerts.length ? alerts.map(a => `
      <div class="alert-item" onclick="closeAlertsModal(); openContractDetail('${a.id}')">
        <span class="alert-type ${a.type}">${alertTypeFa(a.type)}</span>
        <span class="alert-text">${escapeHtml(a.text)}</span>
        <span class="alert-time">${a.time ? relativeDayLabel(a.time) : ''}</span>
      </div>`).join('') : '<div class="empty">فعلاً هشداری وجود ندارد.</div>'}
    <div class="row" style="margin-top:10px;"><button class="cancel-btn" style="flex:1;" onclick="closeAlertsModal()">بستن</button></div>
  `;
}

/* ---------- Shared: warnings list ---------- */
function renderWarningsHtml(){
  const nearing = contracts
    .map(c => ({ c, st: dueStatus(c) }))
    .filter(x => x.st.cls === 'warn' || x.st.cls === 'late')
    .sort((a,b) => (a.st.daysLeft ?? 999) - (b.st.daysLeft ?? 999));
  if(!nearing.length){
    return '<div class="empty" style="margin-top:14px;">فعلاً هیچ قراردادی به سررسید نزدیک یا عقب‌افتاده نیست.</div>';
  }
  return '<div class="section-title" style="margin-top:14px;">هشدار سررسید <span class="cnt">' + nearing.length + ' مورد</span></div>' +
    nearing.map(x => `
      <div class="warn-item ${x.st.cls==='warn'?'soon':''}">
        <div><div class="warn-name">${escapeHtml(x.c.name)}</div><div class="warn-sub">مرحله فعلی: ${STAGES[getCurrentIndex(x.c)].name}</div></div>
        <span class="warn-tag ${x.st.cls==='late'?'red':'amber'}">${x.st.label}</span>
      </div>`).join('');
}

/* ---------- Supervisor view ---------- */
function renderSupervisor(el){
  const closedCount = contracts.filter(isCompleted).length;
  el.innerHTML = `
    <div class="tabs">
      <button class="${supervisorTab==='contracts'?'active':''}" onclick="switchSupervisorTab('contracts')">قراردادها</button>
      <button class="${supervisorTab==='warnings'?'active':''}" onclick="switchSupervisorTab('warnings')">هشدار سررسید</button>
      <button class="${supervisorTab==='closed'?'active':''}" onclick="switchSupervisorTab('closed')">خاتمه‌ها ${closedCount?('('+closedCount+')'):''}</button>
    </div>
    <div id="supBody"></div>
    <div class="sync-note"><span class="dot" id="statusDot"></span><span id="syncNote">همگام — لحظه‌ای</span></div>
  `;
  const body = document.getElementById('supBody');
  if(supervisorTab === 'contracts'){
    const openCount = contracts.filter(c=>!isCompleted(c)).length;
    body.innerHTML = `
      <div class="quick-fab-row"><button class="quick-fab" onclick="openQuickUpdate()">⚡ بروزرسانی سریع</button></div>
      <div class="section-title" style="margin-top:14px;">قراردادها <span class="cnt">${openCount} مورد</span></div>
      ${renderFilterBarHtml()}
      <div id="list"></div>`;
    renderList(false, c => !isCompleted(c));
  } else if(supervisorTab === 'warnings'){
    body.innerHTML = renderWarningsHtml();
  } else {
    body.innerHTML = `<div class="section-title" style="margin-top:14px;">خاتمه‌ها <span class="cnt">${closedCount} مورد</span></div>${renderFilterBarHtml()}<div id="list"></div>`;
    renderList(false, isCompleted);
  }
}
function switchSupervisorTab(t){ supervisorTab = t; renderApp(); }

/* ---------- Admin view ---------- */
function renderAdmin(el){
  const pendingCount = usersList.filter(u => u.role === 'pending').length;
  const nearingCount = contracts.filter(c => ['warn','late'].includes(dueStatus(c).cls)).length;
  const closedCount = contracts.filter(isCompleted).length;
  el.innerHTML = `
    <div class="toolbar"><button class="btn-primary" onclick="openAddModal()">+ قرارداد جدید</button></div>
    <div class="toolbar"><button id="installBtn" class="btn-secondary" onclick="installApp()">نصب اپلیکیشن روی گوشی</button></div>
    <div class="tabs">
      <button class="${adminTab==='dashboard'?'active':''}" onclick="switchAdminTab('dashboard')">داشبورد گزارش</button>
      <button class="${adminTab==='users'?'active':''}" onclick="switchAdminTab('users')">کاربران ${pendingCount?('('+pendingCount+')'):''}</button>
    </div>
    <div class="tabs">
      <button class="${adminTab==='warnings'?'active':''}" onclick="switchAdminTab('warnings')">هشدار سررسید ${nearingCount?('('+nearingCount+')'):''}</button>
      <button class="${adminTab==='closed'?'active':''}" onclick="switchAdminTab('closed')">خاتمه‌ها ${closedCount?('('+closedCount+')'):''}</button>
    </div>
    <div id="adminBody"></div>
    <div class="sync-note"><span class="dot" id="statusDot"></span><span id="syncNote">همگام — لحظه‌ای</span></div>
  `;
  document.getElementById('installBtn').style.display = window.__deferredPrompt ? 'block' : 'none';
  if(adminTab === 'dashboard') renderAdminDashboard();
  else if(adminTab === 'users') renderAdminUsers();
  else if(adminTab === 'closed') renderAdminClosed();
  else document.getElementById('adminBody').innerHTML = renderWarningsHtml();
}
function switchAdminTab(t){ adminTab = t; renderApp(); }

function renderAdminDashboard(){
  const body = document.getElementById('adminBody');
  const k = computeKPIs(contracts);
  const actions = needsActionList(contracts);
  body.innerHTML = `
    <div class="quick-fab-row"><button class="quick-fab" onclick="openQuickUpdate()">⚡ بروزرسانی سریع</button></div>

    <div class="section-title" style="margin-top:14px;">داشبورد مدیریتی</div>
    <div class="kpi-grid">
      <div class="kpi-card c-blue"><div class="kpi-val">${k.total}</div><div class="kpi-label">کل قراردادها</div></div>
      <div class="kpi-card c-blue"><div class="kpi-val">${k.active}</div><div class="kpi-label">قراردادهای فعال</div></div>
      <div class="kpi-card c-green"><div class="kpi-val">${k.completed}</div><div class="kpi-label">خاتمه یافته</div></div>
      <div class="kpi-card c-red"><div class="kpi-val">${k.late}</div><div class="kpi-label">عقب‌افتاده</div></div>
      <div class="kpi-card c-amber"><div class="kpi-val">${k.nearDue}</div><div class="kpi-label">نزدیک سررسید (≤${ALERT_THRESHOLDS.NEAR_DUE_DAYS} روز)</div></div>
      <div class="kpi-card c-amber"><div class="kpi-val">${k.stale}</div><div class="kpi-label">بدون بروزرسانی (≥${ALERT_THRESHOLDS.STALE_UPDATE_DAYS} روز)</div></div>
      <div class="kpi-card c-blue"><div class="kpi-val">${k.avgProgress}٪</div><div class="kpi-label">میانگین پیشرفت (فعال)</div></div>
    </div>

    <div class="section-title">نیازمند اقدام فوری <span class="cnt">${actions.length} مورد</span></div>
    ${actions.length ? actions.map(a => `
      <div class="action-item ${a.late ? '' : (a.near ? 'amber' : 'stale')}">
        <div class="action-top">
          <div>
            <div class="action-name">${escapeHtml(a.c.name)}</div>
            <div class="action-meta">مرحله: ${STAGES[getCurrentIndex(a.c)].name} — پیشرفت: ${overallPercent(a.c)}٪</div>
          </div>
          <span class="due-tag ${a.due.cls}" style="white-space:nowrap;">${a.due.label}</span>
        </div>
        <div class="action-tags">
          <span class="mini-badge">آخرین بروزرسانی: ${a.staleDays!=null ? (a.staleDays<=0?'امروز':a.staleDays+' روز پیش') : 'نامشخص'}</span>
        </div>
        <button class="action-view-btn" onclick="openContractDetail('${a.c.id}')">مشاهده قرارداد</button>
      </div>`).join('') : '<div class="empty" style="margin-bottom:14px;">فعلاً هیچ قراردادی نیازمند اقدام فوری نیست.</div>'}

    <div class="section-title">قراردادهای فعال <span class="cnt">${k.active} مورد</span></div>
    ${renderFilterBarHtml()}
    <div id="list"></div>
  `;
  renderList(true, c => !isCompleted(c));
}

function renderAdminClosed(){
  const body = document.getElementById('adminBody');
  const closed = contracts.filter(isCompleted);
  body.innerHTML = `
    <div class="section-title" style="margin-top:14px;">خاتمه‌ها <span class="cnt">${closed.length} قرارداد</span></div>
    ${renderFilterBarHtml()}
    <div id="list"></div>
  `;
  renderList(true, isCompleted);
}

function renderAdminUsers(){
  const body = document.getElementById('adminBody');
  if(usersList.length === 0){
    body.innerHTML = '<div class="empty" style="margin-top:14px;">هنوز کسی وارد نشده.</div>';
    return;
  }
  body.innerHTML = '<div style="margin-top:14px;">' + usersList.map(u => {
    const isSelf = currentUser && u.id === currentUser.uid;
    let actions = '';
    if(u.role === 'pending'){
      actions = `<button class="btn-approve" onclick="openApproveModal('${u.id}','${escapeHtml(u.name||'')}')">تایید و تعیین سمت</button>
                 <button class="btn-block" onclick="setUserRole('${u.id}','blocked')">رد</button>`;
    } else if(u.role === 'supervisor'){
      actions = `<button class="btn-revoke" onclick="setUserRole('${u.id}','pending')">لغو دسترسی</button>
                 <button class="btn-block" onclick="setUserRole('${u.id}','blocked')">مسدود کن</button>`;
    } else if(u.role === 'blocked'){
      actions = `<button class="btn-approve" onclick="openApproveModal('${u.id}','${escapeHtml(u.name||'')}')">فعال‌سازی مجدد</button>
                 <button class="btn-delete" onclick="deleteUser('${u.id}')">حذف کامل</button>`;
    } else if(u.role === 'admin' && !isSelf){
      actions = `<button class="btn-revoke" onclick="setUserRole('${u.id}','pending')">حذف دسترسی مدیر</button>`;
    }
    const nameLine = u.name ? escapeHtml(u.name) + (u.position ? ' — ' + escapeHtml(u.position) : '') : '';
    return `
      <div class="user-row">
        <div class="user-info">
          <div class="user-email">${escapeHtml(u.email)}${isSelf?' (شما)':''}</div>
          ${nameLine ? `<div class="user-role" style="color:var(--ink-soft);">${nameLine}</div>` : ''}
          <div class="user-role ${u.role}">${roleFa(u.role)}</div>
        </div>
        <div class="user-actions">${actions}</div>
      </div>`;
  }).join('') + '</div>';
}

async function setUserRole(uid, role){
  if(!db) return;
  await db.collection('users').doc(uid).update({ role });
}
async function deleteUser(uid){
  if(!db) return;
  if(!confirm('این کاربر کاملاً حذف شود؟')) return;
  await db.collection('users').doc(uid).delete();
}

/* ---------- Approve modal ---------- */
function openApproveModal(uid, currentName){
  approveTargetUid = uid;
  document.getElementById('approveName').value = currentName || '';
  document.getElementById('approvePosition').value = '';
  document.getElementById('approveModalBg').classList.add('open');
}
async function confirmApprove(){
  if(!approveTargetUid || !db) return;
  const name = document.getElementById('approveName').value.trim();
  const position = document.getElementById('approvePosition').value.trim();
  await db.collection('users').doc(approveTargetUid).update({
    role: 'supervisor', name, position, approvedAt: Date.now()
  });
  closeModal('approveModalBg');
  approveTargetUid = null;
}

/* ---------- Contract list & card ---------- */
function renderList(isAdmin, predicate){
  currentListCtx = { isAdmin, predicate };
  const list = document.getElementById('list');
  if(!list) return;
  let items = predicate ? contracts.filter(predicate) : contracts;
  items = items.filter(matchesFilters);
  if(items.length === 0){
    list.innerHTML = '<div class="empty">موردی برای نمایش نیست.</div>';
    return;
  }
  list.innerHTML = items.map(c => renderCard(c, isAdmin)).join('');
}

/* V9: کارت خلاصه — فشرده، بدون شلوغی. با تپ، «صفحه جزئیات قرارداد» (Modal) باز می‌شود. */
function renderCard(c, isAdmin){
  const curIdx = getCurrentIndex(c);
  const pct = overallPercent(c);
  const due = dueStatus(c);
  const sched = scheduleText(c);

  const badges = [];
  if(c.itemCode) badges.push('<span class="mini-badge">کد قلم: ' + escapeHtml(c.itemCode) + '</span>');

  return `
    <div class="card">
      <div class="card-head" onclick="openContractDetail('${c.id}')">
        <div class="card-title">
          <span class="card-name">${escapeHtml(c.name)}</span>
          <span class="card-sub">مرحله فعلی: ${STAGES[curIdx].name}</span>
          <div class="card-badges">${badges.join('')}</div>
        </div>
        <span class="stage-pill">${pct}٪</span>
      </div>
      <div class="progress-strip"><div style="width:${pct}%"></div></div>
      <div class="due-row">
        <span class="due-tag ${due.cls}">${due.label}</span>
        ${sched ? `<span class="schedule-tag">${sched}</span>` : ''}
      </div>
    </div>`;
}

/* V9: بدنه‌ی مشترکِ جزئیات قرارداد (Timeline هشت مرحله‌ای + فیلدها + تاریخچه) — فقط در Detail Modal رندر می‌شود. */
function renderContractBody(c, isAdmin){
  const status = c.status || {};
  const curIdx = getCurrentIndex(c);

  const timelineHtml = STAGES.map((st,i) => {
    const s = status[i] || {};
    const done = isStageDone(status, i);
    const dotCls = done ? 'done' : (i === curIdx ? 'active' : '');
    const nameCls = done ? 'done' : '';
    const stateFa = done ? 'انجام شد' : (i === curIdx ? 'در حال انجام' : 'در انتظار');
    let control = '';
    if(st.type === 'check'){
      control = `<button class="chk-btn ${done?'done':''}" onclick="event.stopPropagation(); toggleCheck('${c.id}', ${i})">${done ? '✓ انجام شد' : 'ثبت انجام'}</button>`;
    }
    let progBox = '';
    if(st.type === 'progress'){
      const pv = s.percent || 0;
      const pd = s.predictedDate || '';
      const panelInstalled = !!s.panelInstalled;
      const maxAllowed = st.requiresPanel ? (panelInstalled ? 100 : 80) : 100;
      const panelBtnHtml = st.requiresPanel ? `
          <button class="chk-btn ${panelInstalled?'done':''}" style="width:100%;margin-bottom:10px;" onclick="event.stopPropagation(); togglePanelInstalled('${c.id}', ${i})">
            ${panelInstalled ? '✓ نصب صفحه کابینت انجام شد' : 'نصب صفحه کابینت'}
          </button>
          ${!panelInstalled ? '<div class="admin-only-note">تا نصب نشدن این مرحله، پیشرفت حداکثر ۸۰٪ ثبت می‌شود.</div>' : ''}
        ` : '';
      progBox = `
        <div class="prog-box">
          ${panelBtnHtml}
          <div class="prog-row">
            <input type="range" min="0" max="${maxAllowed}" value="${Math.min(pv,maxAllowed)}" id="range_${c.id}_${i}" oninput="document.getElementById('val_${c.id}_${i}').textContent = this.value + '%'">
            <span class="prog-val" id="val_${c.id}_${i}">${Math.min(pv,maxAllowed)}%</span>
          </div>
          <div class="prog-strip-mini"><div style="width:${Math.min(pv,maxAllowed)}%"></div></div>
          <div class="prog-date">
            <label>پیش‌بینی پایان (شمسی):</label>
            <input type="text" id="date_${c.id}_${i}" placeholder="1405/06/04" value="${escapeHtml(pd)}">
          </div>
          <button class="prog-save" onclick="event.stopPropagation(); saveProgress('${c.id}', ${i})">ثبت پیشرفت</button>
        </div>`;
    }
    return `
      <div class="tl-item">
        <div class="tl-dot ${dotCls}"></div>
        <div class="tl-row"><span class="tl-name ${nameCls}">${st.name}</span>${control}</div>
        <div class="tl-time">${stateFa}${s.doneAt ? ' — ' + fmtTime(s.doneAt) : ''}</div>
        ${progBox}
      </div>`;
  }).join('');

  const history = c.history || [];
  const hOpen = isHistoryOpen(c.id, isAdmin);
  const histHtml = renderHistoryTimeline(history);

  const dueFieldHtml = isAdmin ? `
    <div class="field-row">
      <label>سررسید قرارداد:</label>
      <input type="text" id="due_${c.id}" placeholder="1405/06/04" value="${escapeHtml(c.dueDate||'')}">
      <button class="field-save" onclick="saveDueDate('${c.id}')">ثبت</button>
    </div>` : `
    <div class="field-row">
      <label>سررسید قرارداد:</label>
      <span style="font-family:'JetBrains Mono',monospace; color:var(--ink-soft);">${escapeHtml(c.dueDate || 'ثبت نشده')}</span>
    </div>`;

  const revDueFieldHtml = `
    <div class="field-row">
      <label>سررسید جبرانی:</label>
      <input type="text" id="revdue_${c.id}" placeholder="1405/06/20" value="${escapeHtml(c.revisedDueDate||'')}">
      <button class="field-save" onclick="saveRevisedDueDate('${c.id}')">ثبت</button>
    </div>`;

  const itemCodeFieldHtml = isAdmin ? `
    <div class="field-row text">
      <label>کد قلم:</label>
      <input type="text" id="item_${c.id}" placeholder="مثلاً K-104" value="${escapeHtml(c.itemCode||'')}">
      <button class="field-save" onclick="saveItemCode('${c.id}')">ثبت</button>
    </div>` : '';

  const descFieldHtml = `
    <div class="field-row text">
      <label>توضیحات:</label>
      <input type="text" id="desc_${c.id}" placeholder="یادداشت..." value="${escapeHtml(c.description||'')}">
      <button class="field-save" onclick="saveDescription('${c.id}')">ثبت</button>
    </div>`;

  return `
    ${dueFieldHtml}
    ${revDueFieldHtml}
    ${itemCodeFieldHtml}
    ${descFieldHtml}
    <div class="timeline">${timelineHtml}</div>
    <div class="hist-title" style="cursor:pointer; display:flex; justify-content:space-between; align-items:center;">
      <span onclick="event.stopPropagation(); toggleHistory('${c.id}')">تاریخچه ${hOpen ? '▲' : '▼'}</span>
      ${isAdmin ? `<button onclick="event.stopPropagation(); clearHistory('${c.id}')" style="border:none;background:none;color:var(--red);font-size:10.5px;cursor:pointer;font-family:'Vazirmatn';text-decoration:underline;">پاک‌کردن تاریخچه</button>` : ''}
    </div>
    ${hOpen ? histHtml : ''}
    ${isAdmin ? `<div class="del-row"><button onclick="event.stopPropagation(); deleteContract('${c.id}')">حذف قرارداد</button></div>` : ''}
  `;
}

/* V9: تاریخچه به‌صورت Timeline، گروه‌بندی‌شده بر اساس روز (امروز/دیروز/تاریخ) — ساختار داده‌ی history عوض نشده. */
function renderHistoryTimeline(history){
  const items = history.slice().reverse().slice(0,50);
  if(!items.length) return '<div class="hist-item"><span>—</span></div>';
  let lastGroup = null, html = '';
  items.forEach(h => {
    const grp = h.time ? relativeDayLabel(h.time) : '';
    if(grp !== lastGroup){ html += `<div class="hist-day-sep">${grp}</div>`; lastGroup = grp; }
    const timeOnly = h.time ? new Date(h.time).toLocaleTimeString('fa-IR', {hour:'2-digit', minute:'2-digit'}) : '';
    html += `
      <div class="hist-tl-item">
        <div class="hist-tl-dot"></div>
        <div class="hist-tl-label">${escapeHtml(h.label)}</div>
        <div class="hist-tl-meta">${timeOnly}${h.by ? ' — ' + escapeHtml(h.by.split('@')[0]) : ''}</div>
      </div>`;
  });
  return html;
}

function isHistoryOpen(id, isAdmin){
  if(!(id in historyOpen)) historyOpen[id] = !!isAdmin;
  return historyOpen[id];
}
function toggleHistory(id){ historyOpen[id] = !historyOpen[id]; if(detailContractId===id) renderDetailModalContent(); }

function fmtTime(iso){
  const d = new Date(iso);
  return d.toLocaleString('fa-IR', {month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit'});
}

/* V9: «صفحه جزئیات قرارداد» — Modal حرفه‌ای، به‌جای آکاردئون قبلی */
function openContractDetail(id){
  detailContractId = id;
  document.getElementById('detailModalBg').classList.add('open');
  renderDetailModalContent();
}
function closeDetailModal(){
  detailContractId = null;
  document.getElementById('detailModalBg').classList.remove('open');
}
function renderDetailModalContent(){
  const box = document.getElementById('detailModalInner');
  if(!box) return;
  const c = contracts.find(x => x.id === detailContractId);
  if(!c){ closeDetailModal(); return; }
  const isAdmin = myRole === 'admin';
  const curIdx = getCurrentIndex(c);
  const pct = overallPercent(c);
  const due = dueStatus(c);
  const sched = scheduleText(c);
  box.innerHTML = `
    <div class="detail-header">
      <div>
        <div class="detail-title">${escapeHtml(c.name)}</div>
        <div class="detail-sub">مرحله فعلی: ${STAGES[curIdx].name} — پیشرفت: ${pct}٪</div>
      </div>
      <button class="detail-close" onclick="closeDetailModal()">بستن ✕</button>
    </div>
    <div class="progress-strip"><div style="width:${pct}%"></div></div>
    <div class="due-row" style="padding:10px 0 4px;">
      <span class="due-tag ${due.cls}">${due.label}</span>
      ${sched ? `<span class="schedule-tag">${sched}</span>` : ''}
    </div>
    ${renderContractBody(c, isAdmin)}
  `;
}

async function toggleCheck(id, idx){
  if(!db) return;
  const c = contracts.find(x => x.id === id);
  if(!c) return;
  const status = c.status || {};
  const cur = status[idx] || {};
  const nowDone = !cur.done;
  status[idx] = { done: nowDone, doneAt: nowDone ? new Date().toISOString() : null };
  const history = (c.history || []).concat([historyEntry(STAGES[idx].name + ' — ' + (nowDone?'انجام شد':'لغو شد'))]);
  await db.collection('contracts').doc(id).update({ status, history });
}

async function togglePanelInstalled(id, idx){
  if(!db) return;
  const c = contracts.find(x => x.id === id);
  if(!c) return;
  const status = c.status || {};
  const cur = status[idx] || {};
  const now = !cur.panelInstalled;
  let percent = cur.percent || 0;
  if(!now && percent > 80) percent = 80;
  status[idx] = { ...cur, panelInstalled: now, percent, doneAt: (percent>=100 && now) ? new Date().toISOString() : null };
  const history = (c.history || []).concat([historyEntry(STAGES[idx].name + ' — نصب صفحه کابینت ' + (now?'انجام شد':'لغو شد'))]);
  await db.collection('contracts').doc(id).update({ status, history });
}

async function saveProgress(id, idx){
  if(!db) return;
  const c = contracts.find(x => x.id === id);
  if(!c) return;
  const st = STAGES[idx];
  const cur = (c.status||{})[idx] || {};
  const panelInstalled = !!cur.panelInstalled;
  const maxAllowed = st.requiresPanel ? (panelInstalled ? 100 : 80) : 100;
  let percent = parseInt(document.getElementById(`range_${id}_${idx}`).value, 10);
  if(percent > maxAllowed) percent = maxAllowed;
  const predictedDate = document.getElementById(`date_${id}_${idx}`).value.trim();
  const status = c.status || {};
  status[idx] = { ...cur, percent, predictedDate, updatedAt: new Date().toISOString(),
                   doneAt: (percent>=100 && (!st.requiresPanel || panelInstalled)) ? new Date().toISOString() : null };
  const history = (c.history || []).concat([historyEntry(STAGES[idx].name + ' — پیشرفت ' + percent + '٪' + (predictedDate?' — پیش‌بینی: '+predictedDate:''))]);
  await db.collection('contracts').doc(id).update({ status, history });
}

async function saveDueDate(id){
  if(!db) return;
  const val = document.getElementById(`due_${id}`).value.trim();
  if(val && !parseJalaliStr(val)){ alert('فرمت تاریخ درست نیست. مثال: 1405/06/04'); return; }
  const c = contracts.find(x => x.id === id);
  const history = (c.history||[]).concat([historyEntry('سررسید ثبت شد: '+val)]);
  await db.collection('contracts').doc(id).update({ dueDate: val, history });
}
async function saveRevisedDueDate(id){
  if(!db) return;
  const val = document.getElementById(`revdue_${id}`).value.trim();
  if(val && !parseJalaliStr(val)){ alert('فرمت تاریخ درست نیست. مثال: 1405/06/20'); return; }
  const c = contracts.find(x => x.id === id);
  const history = (c.history||[]).concat([historyEntry('سررسید جبرانی ثبت شد: '+val)]);
  await db.collection('contracts').doc(id).update({ revisedDueDate: val, history });
}
async function saveItemCode(id){
  if(!db) return;
  const val = document.getElementById(`item_${id}`).value.trim();
  const c = contracts.find(x => x.id === id);
  const history = (c.history||[]).concat([historyEntry('کد قلم ثبت شد: '+val)]);
  await db.collection('contracts').doc(id).update({ itemCode: val, history });
}
async function saveDescription(id){
  if(!db) return;
  const val = document.getElementById(`desc_${id}`).value.trim();
  const c = contracts.find(x => x.id === id);
  const history = (c.history||[]).concat([historyEntry('توضیحات ثبت شد')]);
  await db.collection('contracts').doc(id).update({ description: val, history });
}
async function deleteContract(id){
  if(!db) return;
  if(!confirm('این قرارداد حذف شود؟')) return;
  await db.collection('contracts').doc(id).delete();
}
async function clearHistory(id){
  if(!db) return;
  if(!confirm('کل تاریخچه‌ی این قرارداد پاک شود؟ این کار قابل بازگشت نیست.')) return;
  await db.collection('contracts').doc(id).update({ history: [historyEntry('تاریخچه توسط مدیر پاک شد')] });
}

function openAddModal(){
  document.getElementById('newName').value = '';
  document.getElementById('newItemCode').value = '';
  document.getElementById('addModalBg').classList.add('open');
}
function closeModal(id){ document.getElementById(id).classList.remove('open'); }
async function addContract(){
  if(!db) return;
  const name = document.getElementById('newName').value.trim();
  const itemCode = document.getElementById('newItemCode').value.trim();
  if(!name) return;
  await db.collection('contracts').add({
    name, itemCode: itemCode || '',
    status: {},
    history: [historyEntry('قرارداد ثبت شد')],
    createdAt: Date.now()
  });
  closeModal('addModalBg');
}

/* ---------- V9: Quick Update — بروزرسانی سریع در یک صفحه فشرده ---------- */
function openQuickUpdate(){
  const openList = contracts.filter(c => !isCompleted(c));
  if(!openList.length){ alert('هیچ قرارداد فعالی برای بروزرسانی وجود ندارد.'); return; }
  const first = openList[0];
  const firstIdx = getCurrentIndex(first);
  quickData = { contractId: first.id, stageIdx: firstIdx, checkDone: !!((first.status||{})[firstIdx]||{}).done };
  quickUpdateOpen = true;
  document.getElementById('quickModalBg').classList.add('open');
  renderQuickModal();
}
function closeQuickUpdate(){
  quickUpdateOpen = false;
  document.getElementById('quickModalBg').classList.remove('open');
}
function renderQuickModal(){
  const box = document.getElementById('quickModalInner');
  if(!box) return;
  const openList = contracts.filter(c => !isCompleted(c));
  const contractOptions = openList.map(c => `<option value="${c.id}" ${quickData.contractId===c.id?'selected':''}>${escapeHtml(c.name)}</option>`).join('');
  box.innerHTML = `
    <h3>⚡ بروزرسانی سریع</h3>
    <div class="field-row text" style="margin-bottom:8px;">
      <label style="min-width:70px;">قرارداد:</label>
      <select id="quickContractSel" style="flex:1; font-family:'Vazirmatn'; font-size:13px; padding:9px; border:1px solid var(--line); border-radius:8px; background:var(--panel-2); color:var(--ink);" onchange="quickSelectContract(this.value)">
        ${contractOptions}
      </select>
    </div>
    <div class="field-row text" style="margin-bottom:8px;">
      <label style="min-width:70px;">مرحله:</label>
      <select id="quickStageSel" style="flex:1; font-family:'Vazirmatn'; font-size:13px; padding:9px; border:1px solid var(--line); border-radius:8px; background:var(--panel-2); color:var(--ink);" onchange="quickSelectStage(this.value)">
        ${STAGES.map((s,i) => `<option value="${i}" ${quickData.stageIdx===i?'selected':''}>${s.name}</option>`).join('')}
      </select>
    </div>
    <div id="quickDynamic"></div>
    <div class="row" style="margin-top:12px;">
      <button class="save-btn" onclick="submitQuickUpdate()">ثبت</button>
      <button class="cancel-btn" onclick="closeQuickUpdate()">انصراف</button>
    </div>
  `;
  renderQuickDynamic();
}
function quickSelectContract(id){
  const c = contracts.find(x => x.id === id);
  quickData.contractId = id;
  quickData.stageIdx = c ? getCurrentIndex(c) : 0;
  quickData.checkDone = !!((c && (c.status||{})[quickData.stageIdx]) || {}).done;
  document.getElementById('quickStageSel').value = String(quickData.stageIdx);
  renderQuickDynamic();
}
function quickSelectStage(v){
  quickData.stageIdx = parseInt(v,10);
  const c = contracts.find(x => x.id === quickData.contractId);
  quickData.checkDone = !!((c && (c.status||{})[quickData.stageIdx]) || {}).done;
  renderQuickDynamic();
}
function quickToggleCheck(){
  quickData.checkDone = !quickData.checkDone;
  renderQuickDynamic();
}
function renderQuickDynamic(){
  const box = document.getElementById('quickDynamic');
  if(!box) return;
  const c = contracts.find(x => x.id === quickData.contractId);
  if(!c){ box.innerHTML = ''; return; }
  const st = STAGES[quickData.stageIdx];
  const cur = (c.status||{})[quickData.stageIdx] || {};
  if(st.type === 'check'){
    const willBeDone = !!quickData.checkDone;
    box.innerHTML = `
      <div class="field-row">
        <label style="min-width:70px;">وضعیت:</label>
        <button class="chk-btn ${willBeDone?'done':''}" onclick="quickToggleCheck()">${willBeDone ? '✓ انجام شد' : 'ثبت به‌عنوان انجام‌شده'}</button>
      </div>
      <div class="field-row text">
        <label style="min-width:70px;">توضیح:</label>
        <input type="text" id="quickNote" placeholder="یادداشت کوتاه (اختیاری)">
      </div>`;
  } else {
    const panelInstalled = !!cur.panelInstalled;
    const maxAllowed = st.requiresPanel ? (panelInstalled ? 100 : 80) : 100;
    const val = Math.min(cur.percent || 0, maxAllowed);
    box.innerHTML = `
      <div class="prog-box">
        <div class="prog-row">
          <input type="range" min="0" max="${maxAllowed}" value="${val}" id="quickPercent" oninput="document.getElementById('quickPercentVal').textContent=this.value+'%'">
          <span class="prog-val" id="quickPercentVal">${val}%</span>
        </div>
        ${st.requiresPanel && !panelInstalled ? '<div class="admin-only-note">تا نصب نشدن صفحه کابینت، پیشرفت حداکثر ۸۰٪ ثبت می‌شود.</div>' : ''}
      </div>
      <div class="field-row text">
        <label style="min-width:70px;">توضیح:</label>
        <input type="text" id="quickNote" placeholder="یادداشت کوتاه (اختیاری)">
      </div>`;
  }
}
async function submitQuickUpdate(){
  if(!db) return;
  const c = contracts.find(x => x.id === quickData.contractId);
  if(!c) return;
  const idx = quickData.stageIdx;
  const st = STAGES[idx];
  const noteEl = document.getElementById('quickNote');
  const note = noteEl ? noteEl.value.trim() : '';
  const status = c.status || {};
  const cur = status[idx] || {};
  let label;
  if(st.type === 'check'){
    const nowDone = quickData.checkDone;
    status[idx] = { done: nowDone, doneAt: nowDone ? new Date().toISOString() : null };
    label = 'بروزرسانی سریع — ' + st.name + ' — ' + (nowDone ? 'انجام شد' : 'لغو شد');
  } else {
    const panelInstalled = !!cur.panelInstalled;
    const maxAllowed = st.requiresPanel ? (panelInstalled ? 100 : 80) : 100;
    let percent = parseInt((document.getElementById('quickPercent')||{}).value, 10);
    if(isNaN(percent)) percent = cur.percent || 0;
    if(percent > maxAllowed) percent = maxAllowed;
    status[idx] = { ...cur, percent, updatedAt: new Date().toISOString(),
                     doneAt: (percent>=100 && (!st.requiresPanel || panelInstalled)) ? new Date().toISOString() : null };
    label = 'بروزرسانی سریع — ' + st.name + ' — پیشرفت ' + percent + '٪';
  }
  if(note) label += ' — ' + note;
  const history = (c.history || []).concat([historyEntry(label)]);
  await db.collection('contracts').doc(c.id).update({ status, history });
  closeQuickUpdate();
}

/* ---------- PWA install ---------- */
window.__deferredPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  window.__deferredPrompt = e;
  const btn = document.getElementById('installBtn');
  if(btn) btn.style.display = 'block';
});
function installApp(){
  if(!window.__deferredPrompt) return;
  window.__deferredPrompt.prompt();
  window.__deferredPrompt = null;
  const btn = document.getElementById('installBtn');
  if(btn) btn.style.display = 'none';
}
if('serviceWorker' in navigator){
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./service-worker.js').catch(() => {});
  });
}

initAuthAndData();
