/* ===== افراچوب — منطق اصلی اپ (نسخه ۳) ===== */

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

    auth.getRedirectResult().catch((e) => {
      setStatus('خطا در ورود: ' + e.message, false);
    });

    auth.onAuthStateChanged(async (user) => {
      currentUser = user;
      dataSubscribed = false;
      if(!user){ myRole = null; myPosition = ''; renderApp(); return; }
      const ref = db.collection('users').doc(user.uid);
      const snap = await ref.get();
      if(!snap.exists){
        const role = (user.email === ADMIN_EMAIL) ? 'admin' : 'pending';
        await ref.set({ email:user.email, name:user.displayName||'', role, requestedAt: Date.now() });
      }
      ref.onSnapshot((doc) => {
        myRole = doc.exists ? doc.data().role : 'pending';
        myPosition = doc.exists ? (doc.data().position || '') : '';
        ensureDataSubscriptions();
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

function signIn(){
  const provider = new firebase.auth.GoogleAuthProvider();
  auth.signInWithRedirect(provider);
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
        <p>برای مشاهده و مدیریت وضعیت قراردادها، با حساب گوگل خود وارد شوید.</p>
        <button class="google-btn" onclick="signIn()">
          <svg width="18" height="18" viewBox="0 0 48 48"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.3 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3 0 5.8 1.1 7.9 3l5.7-5.7C34.5 5.6 29.5 3.5 24 3.5 12.7 3.5 3.5 12.7 3.5 24S12.7 44.5 24 44.5 44.5 35.3 44.5 24c0-1.2-.1-2.4-.9-3.5z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.6 15.9 18.9 13 24 13c3 0 5.8 1.1 7.9 3l5.7-5.7C34.5 6.6 29.5 4.5 24 4.5c-7.7 0-14.4 4.4-17.7 10.2z"/><path fill="#4CAF50" d="M24 44.5c5.4 0 10.3-2.1 14-5.5l-6.5-5.4c-2 1.4-4.6 2.4-7.5 2.4-5.3 0-9.7-3.3-11.3-8l-6.6 5.1C9.5 39.9 16.2 44.5 24 44.5z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.3-2.3 4.3-4.3 5.7l6.5 5.4C41.4 36 44.5 30.6 44.5 24c0-1.2-.1-2.4-.9-3.5z"/></svg>
          ورود با حساب گوگل
        </button>
      </div>`;
    return;
  }

  const badgeText = myPosition ? escapeHtml(myPosition) : roleFa(myRole);
  headerRight.innerHTML = `<div style="display:flex;align-items:center;">
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
  if(myRole === 'admin'){ renderAdmin(el); return; }
  if(myRole === 'supervisor'){ renderSupervisor(el); return; }

  el.innerHTML = '<div class="center-screen"><span class="sync-note"><span class="dot" id="statusDot"></span><span id="syncNote">در حال بارگذاری…</span></span></div>';
}

function roleFa(r){
  return { admin:'مدیر', supervisor:'سرپرست نصب', pending:'در انتظار تایید', blocked:'مسدود' }[r] || r;
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
  el.innerHTML = `
    <div class="tabs">
      <button class="${supervisorTab==='contracts'?'active':''}" onclick="switchSupervisorTab('contracts')">قراردادها</button>
      <button class="${supervisorTab==='warnings'?'active':''}" onclick="switchSupervisorTab('warnings')">هشدار سررسید</button>
    </div>
    <div id="supBody"></div>
    <div class="sync-note"><span class="dot" id="statusDot"></span><span id="syncNote">همگام — لحظه‌ای</span></div>
  `;
  const body = document.getElementById('supBody');
  if(supervisorTab === 'contracts'){
    body.innerHTML = `<div class="section-title" style="margin-top:14px;">قراردادها <span class="cnt">${contracts.length} مورد</span></div><div id="list"></div>`;
    renderList(false);
  } else {
    body.innerHTML = renderWarningsHtml();
  }
}
function switchSupervisorTab(t){ supervisorTab = t; renderApp(); }

/* ---------- Admin view ---------- */
function renderAdmin(el){
  const pendingCount = usersList.filter(u => u.role === 'pending').length;
  const nearingCount = contracts.filter(c => ['warn','late'].includes(dueStatus(c).cls)).length;
  el.innerHTML = `
    <div class="toolbar"><button class="btn-primary" onclick="openAddModal()">+ قرارداد جدید</button></div>
    <div class="toolbar"><button id="installBtn" class="btn-secondary" onclick="installApp()">نصب اپلیکیشن روی گوشی</button></div>
    <div class="tabs">
      <button class="${adminTab==='dashboard'?'active':''}" onclick="switchAdminTab('dashboard')">داشبورد گزارش</button>
      <button class="${adminTab==='users'?'active':''}" onclick="switchAdminTab('users')">کاربران ${pendingCount?('('+pendingCount+')'):''}</button>
      <button class="${adminTab==='warnings'?'active':''}" onclick="switchAdminTab('warnings')">هشدار سررسید ${nearingCount?('('+nearingCount+')'):''}</button>
    </div>
    <div id="adminBody"></div>
    <div class="sync-note"><span class="dot" id="statusDot"></span><span id="syncNote">همگام — لحظه‌ای</span></div>
  `;
  document.getElementById('installBtn').style.display = window.__deferredPrompt ? 'block' : 'none';
  if(adminTab === 'dashboard') renderAdminDashboard();
  else if(adminTab === 'users') renderAdminUsers();
  else document.getElementById('adminBody').innerHTML = renderWarningsHtml();
}
function switchAdminTab(t){ adminTab = t; renderApp(); }

function renderAdminDashboard(){
  const body = document.getElementById('adminBody');
  const late = contracts.filter(c => dueStatus(c).cls === 'late').length;
  const soon = contracts.filter(c => dueStatus(c).cls === 'warn').length;
  body.innerHTML = `
    <div class="section-title" style="margin-top:14px;">خلاصه وضعیت <span class="cnt">${contracts.length} قرارداد فعال</span></div>
    <div class="card-badges" style="margin-bottom:14px;">
      <span class="mini-badge" style="border-color:var(--red);color:var(--red);">عقب‌افتاده: ${late}</span>
      <span class="mini-badge" style="border-color:var(--amber);color:var(--amber);">نزدیک به سررسید: ${soon}</span>
    </div>
    <div id="list"></div>
  `;
  renderList(true);
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
function renderList(isAdmin){
  const list = document.getElementById('list');
  if(!list) return;
  if(contracts.length === 0){
    list.innerHTML = '<div class="empty">هنوز قراردادی ثبت نشده.' + (isAdmin ? ' با دکمه «قرارداد جدید» شروع کنید.' : '') + '</div>';
    return;
  }
  list.innerHTML = contracts.map(c => renderCard(c, isAdmin)).join('');
}

function renderCard(c, isAdmin){
  const status = c.status || {};
  const curIdx = getCurrentIndex(c);
  const pct = overallPercent(c);
  const isOpen = openCardId === c.id;
  const due = dueStatus(c);
  const sched = scheduleText(c);

  const badges = [];
  if(c.itemCode) badges.push('<span class="mini-badge">کد قلم: ' + escapeHtml(c.itemCode) + '</span>');

  const timelineHtml = STAGES.map((st,i) => {
    const s = status[i] || {};
    const done = isStageDone(status, i);
    const dotCls = done ? 'done' : (i === curIdx ? 'active' : '');
    const nameCls = done ? 'done' : '';
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
        ${s.doneAt ? `<div class="tl-time">${fmtTime(s.doneAt)}</div>` : ''}
        ${progBox}
      </div>`;
  }).join('');

  const history = c.history || [];
  const hOpen = isHistoryOpen(c.id, isAdmin);
  const histHtml = history.slice().reverse().slice(0,30).map(h =>
    `<div class="hist-item"><span>${escapeHtml(h.label)}</span><span class="hist-time">${fmtTime(h.time)}${h.by ? ' — '+escapeHtml(h.by.split('@')[0]) : ''}</span></div>`
  ).join('') || '<div class="hist-item"><span>—</span></div>';

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
    <div class="card">
      <div class="card-head" onclick="toggleCard('${c.id}')">
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
      <div class="body-panel ${isOpen ? 'open' : ''}">
        ${dueFieldHtml}
        ${revDueFieldHtml}
        ${itemCodeFieldHtml}
        ${descFieldHtml}
        <div class="timeline">${timelineHtml}</div>
        <div class="hist-title" style="cursor:pointer;" onclick="event.stopPropagation(); toggleHistory('${c.id}')">
          تاریخچه ${hOpen ? '▲' : '▼'}
        </div>
        ${hOpen ? histHtml : ''}
        ${isAdmin ? `<div class="del-row"><button onclick="event.stopPropagation(); deleteContract('${c.id}')">حذف قرارداد</button></div>` : ''}
      </div>
    </div>`;
}

function isHistoryOpen(id, isAdmin){
  if(!(id in historyOpen)) historyOpen[id] = !!isAdmin;
  return historyOpen[id];
}
function toggleHistory(id){ historyOpen[id] = !historyOpen[id]; renderApp(); }

function fmtTime(iso){
  const d = new Date(iso);
  return d.toLocaleString('fa-IR', {month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit'});
}
function toggleCard(id){ openCardId = openCardId === id ? null : id; renderApp(); }

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
