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
const WARN_DAYS = 7; // آستانه‌ی هشدار سررسید در پنل سرپرست — دست‌نخورده (V8)
const ADMIN_NEAR_DUE_DAYS = 3;  // آستانه‌ی جدید فقط برای داشبورد/هشدارهای مدیر (V9)

let auth = null, db = null;
let presenceInterval = null;
let currentUser = null;
let myRole = null;
let myPosition = '';
let contracts = [];
let usersList = [];
let openCardId = null;
let adminTab = 'dashboard';   // 'dashboard' | 'contracts' | 'users' | 'log' | 'plans'
let supervisorTab = 'contracts'; // 'contracts' | 'warnings' | 'closed' — V8، دست‌نخورده
let dataSubscribed = false;
let historyOpen = {};         // id -> bool
let approveTargetUid = null;
let authErrorMsg = '';
let adminSearchQuery = '';
let adminFilterStage = 'all';
let adminFilterStatus = 'all';
let supervisorSearchQuery = '';
let viewerOpenId = null;
let viewerSearchQuery = '';
let viewerSection = null;     // null | 'critical' | 'panelwait' | 'waitingdelivery' | 'all' | 'contact'
let viewerHistoryOpen = {};   // id -> bool — برای مدیر پروژه همیشه پیش‌فرض بسته
let pmNotes = [];             // پیام‌های عمومی «ارتباط با کنترل پروژه» / «ارتباط با مدیر» — لیست ادغام‌شده‌ی نهایی
let pmNotesA = [];            // نتیجه‌ی listener اول (برای مدیر پروژه: پیام‌های خودش)
let pmNotesB = [];            // نتیجه‌ی listener دوم (برای مدیر پروژه: پاسخ‌های مدیر)
let pmoCommentsSearch = '';   // جستجو در بخش «کامنت‌های مدیر پروژه» (پنل مدیر/سرپرست)
const PMO_DISPLAY_NAME = 'مدیر پروژه مهندس سمنانی'; // به‌جای ایمیل مدیر پروژه، همه‌جا همین نام نشان داده می‌شود
let activityLog = [];
let adminDashSection = null;  // null | 'critical' | 'waitingdelivery' | 'panelwait' — دکمه‌های داشبورد مدیر
let adminDashSearch = '';
let adminPlanContractId = '';
let adminPlanData = null;
let exportScope = 'all';   // 'all' | 'active' | 'closed' | 'waiting'
let exportDateFrom = '';
let exportDateTo = '';
let logDateFrom = '';
let logDateTo = '';
let splashHidden = false;
/* ---------- V10: پنل «سرپرست افراچوب» — کاملاً جدا از متغیرهای بالا ---------- */
let afrTab = 'dashboard';     // 'dashboard' | 'contracts' | 'warnings' | 'closed' | 'pmoComments'
let afrSearchQuery = '';
let afrDashSection = null;    // null | 'critical' | 'waitingdelivery' | 'panelwait'
let afrDashSearch = '';
let afrFilterStage = 'all';
let afrFilterStatus = 'all';

function toggleTheme(){
  const isLight = document.documentElement.getAttribute('data-theme') === 'light';
  if(isLight){
    document.documentElement.removeAttribute('data-theme');
    try{ localStorage.setItem('afrachoob-theme', 'dark'); }catch(e){}
  } else {
    document.documentElement.setAttribute('data-theme', 'light');
    try{ localStorage.setItem('afrachoob-theme', 'light'); }catch(e){}
  }
  const btn = document.getElementById('themeToggleBtn');
  if(btn) btn.textContent = document.documentElement.getAttribute('data-theme') === 'light' ? '☀️' : '🌙';
}
function hideSplash(){
  if(splashHidden) return;
  splashHidden = true;
  const s = document.getElementById('splashScreen');
  if(!s) return;
  s.classList.add('hide');
  setTimeout(() => { if(s && s.parentNode) s.parentNode.removeChild(s); }, 450);
}

function setStatus(text, ok){
  const n = document.getElementById('syncNote'), d = document.getElementById('statusDot');
  if(n) n.textContent = text;
  if(d) d.className = 'dot' + (ok ? '' : ' off');
}
function escapeHtml(s){ const d = document.createElement('div'); d.textContent = s||''; return d.innerHTML; }
function historyEntry(label){ return { label, time: new Date().toISOString(), by: (currentUser && currentUser.email) || '' }; }
function logActivity(action, contractId, contractName, details){
  if(!db || !currentUser) return;
  db.collection('activityLog').add({
    action, contractId: contractId || null, contractName: contractName || null,
    details: details || '', by: currentUser.email || '', byUid: currentUser.uid, byRole: myRole || '',
    time: Date.now()
  }).catch(() => { /* لاگ فقط جنبه‌ی گزارشیه؛ خطای احتمالی نباید کار اصلی رو مختل کنه */ });
}
// هرجا نام نویسنده‌ی یک کامنت/لاگ نمایش داده می‌شه: اگر مدیر پروژه بوده، به‌جای ایمیلش این عنوان نشان داده می‌شود
function authorLabel(entry){
  if(entry && entry.byRole === 'viewer') return PMO_DISPLAY_NAME;
  return escapeHtml(((entry && entry.by) || '').split('@')[0]);
}

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
const STAGE_WEIGHTS = [4.75, 4.75, 4.75, 38, 4.75, 38, 0, 5];
// وزن‌ها: اندازه‌گیری۵٪، تایید طراحی۵٪، آنالیز۵٪، ساخت‌وبرش۴۰٪، ارسال بار۵٪، نصب۴۰٪ (جمعاً ۱۰۰ در مقیاس ۹۵٪)
// تحویل‌دهی به مالک وزنی ندارد (صرفاً تاییدیه)، ۵٪ باقی‌مانده فقط با «خاتمه قرارداد» تکمیل می‌شود.
function overallPercent(c){
  const status = c.status || {};
  let sum = 0;
  STAGES.forEach((st,i) => {
    const s = status[i] || {};
    const frac = st.type === 'check' ? (s.done ? 1 : 0) : ((s.percent||0)/100);
    sum += STAGE_WEIGHTS[i] * frac;
  });
  return Math.round(sum);
}
function isCompleted(c){ return overallPercent(c) === 100; }
// برای نمایش «مرحله فعلی»: اگر همه‌چیز جز «خاتمه قرارداد» تمام شده، همان «در انتظار تحویل‌دهی به مالک» نشان داده شود
function getDisplayStageIndex(c){
  const idx = getCurrentIndex(c);
  if(idx === STAGES.length-1 && !isCompleted(c)) return STAGES.length-2;
  return idx;
}

/* ---------- Admin-only (V9): جدا از منطق سرپرست، به هیچ تابع V8 دست نمی‌زند ---------- */
const NOT_UPDATED_DAYS = 4; // بیش از این تعداد روز بدون آپدیت = «بروزرسانی نشده»
function daysSinceUpdate(c){
  const hist = c.history || [];
  const t = hist.length ? new Date(hist[hist.length-1].time) : new Date(c.createdAt || Date.now());
  return daysBetween(t, new Date());
}
// «بروزرسانی نشده»: قراردادهایی که هنوز پیشرفتشان صفر است، یا بیش از NOT_UPDATED_DAYS روز از آخرین آپدیتشان گذشته
function isNotUpdated(c){
  return overallPercent(c) === 0 || daysSinceUpdate(c) > NOT_UPDATED_DAYS;
}
function adminTimeStatus(c){
  const activeDateStr = c.revisedDueDate || c.dueDate;
  if(!activeDateStr) return { cls:'none', label:'بدون سررسید', daysLeft:null };
  const d = jalaliStrToDate(activeDateStr);
  if(!d) return { cls:'none', label:'تاریخ نامعتبر', daysLeft:null };
  const dl = daysBetween(todayMid(), d);
  if(dl < 0) return { cls:'late', label: Math.abs(dl) + ' روز تأخیر', daysLeft: dl };
  if(dl <= ADMIN_NEAR_DUE_DAYS) return { cls:'near', label: dl + ' روز تا سررسید', daysLeft: dl };
  return { cls:'ontime', label: dl + ' روز تا سررسید', daysLeft: dl };
}
function isWarnEligible(c){
  return !isCompleted(c) && getDisplayStageIndex(c) !== STAGES.length-2;
}
function adminAlerts(){
  const list = [];
  contracts.filter(c => !isCompleted(c)).forEach(c => {
    // هشدار سررسید: یکسان با renderWarningsHtml — قراردادهای «در انتظار تحویل‌دهی به مالک» اینجا نمی‌آیند (V10)
    if(isWarnEligible(c)){
      const st = dueStatus(c);
      if(st.cls === 'late') list.push({ type:'late', c, label:'عقب‌افتاده — ' + st.label });
      else if(st.cls === 'warn') list.push({ type:'near', c, label:'نزدیک سررسید — ' + st.label });
    }
    if(isNotUpdated(c)){
      const label = overallPercent(c) === 0 ? 'هنوز شروع نشده (۰٪)' : (daysSinceUpdate(c) + ' روز بروزرسانی نشده');
      list.push({ type:'stale', c, label });
    }
  });
  const order = { late:0, stale:1, near:2 };
  list.sort((a,b) => order[a.type]-order[b.type]);
  return list;
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

/* ---------- Viewer (مدیر پروژه) — منطق بحرانی/گزارش، جدا از منطق هشدار مدیر ----------
   طبق خواسته: قراردادی که فقط منتظر «تحویل‌دهی به مالک» است (کارش تمام شده، فقط تاییدیه‌ی
   آخر مانده) هرگز بحرانی نیست، حتی اگر از سررسید گذشته باشد. */
function viewerCriticalStatus(c){
  if(isCompleted(c)) return { critical:false, cls:'ok', label:'خاتمه‌یافته' };
  const displayIdx = getDisplayStageIndex(c);
  if(displayIdx === STAGES.length-2){
    return { critical:false, cls:'ok', label:'در انتظار تحویل‌دهی به مالک' };
  }
  const ts = adminTimeStatus(c);
  if(ts.cls === 'late') return { critical:true, cls:'late', label:'بحرانی — ' + ts.label };
  if(ts.cls === 'near') return { critical:false, cls:'warn', label:ts.label };
  return { critical:false, cls: (ts.cls==='none'?'none':'ok'), label:ts.label };
}
// گزارش: همه‌چیز آماده شده ولی «نصب صفحه کابینت» انجام نشده (پیشرفت مرحله‌ی نصب روی سقف ۸۰٪ گیر کرده)
function isPanelWaiting(c){
  if(isCompleted(c)) return false;
  const s = (c.status||{})[5] || {}; // مرحله‌ی «در حال نصب»
  return (s.percent||0) >= 80 && !s.panelInstalled;
}

/* ---------- کامنت‌ها — مدیر پروژه فقط می‌بیند و کامنت می‌گذارد، مدیر و سرپرست هم می‌بینند و می‌توانند اقدام کنند ---------- */
async function addComment(id, inputElId){
  if(!db || !currentUser) return;
  if(myRole === 'afrachoobSupervisor' || myRole === 'supervisor') return; // V11: سرپرست نصب و سرپرست افراچوب اجازه‌ی کامنت‌گذاری ندارند
  const input = document.getElementById(inputElId);
  const text = input ? input.value.trim() : '';
  if(!text) return;
  const c = contracts.find(x => x.id === id);
  if(!c) return;
  try{
    await db.collection('contracts').doc(id).update({
      comments: firebase.firestore.FieldValue.arrayUnion({ text, by: currentUser.email || '', byRole: myRole || '', time: Date.now() })
    });
    if(input) input.value = '';
    logActivity('ثبت کامنت', id, c.name, text);
  }catch(err){
    alert('خطا در ثبت کامنت: ' + (err && err.message ? err.message : String(err)));
  }
}
async function deleteComment(id, time){
  if(!db || !currentUser) return;
  const c = contracts.find(x => x.id === id);
  if(!c) return;
  const cm = (c.comments||[]).find(x => x.time === time);
  if(!cm) return;
  if(!(cm.by === currentUser.email || myRole === 'admin')) return;
  if(!confirm('این کامنت حذف شود؟')) return;
  try{
    await db.collection('contracts').doc(id).update({
      comments: firebase.firestore.FieldValue.arrayRemove(cm)
    });
  }catch(err){
    alert('خطا در حذف کامنت: ' + (err && err.message ? err.message : String(err)));
  }
}
function renderCommentsHtml(c, idSuffix){
  const comments = (c.comments || []).slice().sort((a,b) => (b.time||0)-(a.time||0));
  const inputId = 'cmt_' + c.id + '_' + idSuffix;
  const list = comments.length ? comments.map(cm => {
    const canDelete = currentUser && (cm.by === currentUser.email || myRole === 'admin');
    return `
      <div class="comment-item">
        <div class="comment-top">
          <span class="comment-by">${authorLabel(cm)}</span>
          <span class="comment-time-wrap"><span class="comment-time">${fmtTime(new Date(cm.time).toISOString())}</span>${canDelete?`<button class="comment-del" title="حذف کامنت" onclick="event.stopPropagation(); deleteComment('${c.id}', ${cm.time})">✕</button>`:''}</span>
        </div>
        <div class="comment-text">${escapeHtml(cm.text)}</div>
      </div>`;
  }).join('') : '<div class="empty" style="padding:14px;">هنوز کامنتی ثبت نشده.</div>';
  return `
    <div class="comments-box" onclick="event.stopPropagation();">
      <div class="hist-title">💬 کامنت‌ها ${comments.length?('('+comments.length+')'):''}</div>
      ${list}
      <div class="comment-add-row">
        <input type="text" id="${inputId}" class="auth-input" style="max-width:none; flex:1;" placeholder="کامنت خود را بنویسید...">
        <button class="field-save" onclick="addComment('${c.id}', '${inputId}')">ثبت</button>
      </div>
    </div>`;
}

/* ---------- کامنت‌های مدیر پروژه — بخش مشترک برای پنل مدیر و سرپرست (نه خود مدیر پروژه) ----------
   همه‌ی کامنت‌هایی که روی هر قرارداد توسط «مدیر پروژه» گذاشته شده رو یک‌جا (با نام قرارداد) نشون می‌ده،
   و شمارنده‌ی «جدید» رو بر اساس آخرین باری که این بخش باز شده حساب می‌کنه (نوتیف داخل‌اپی). */
function getAllPmoComments(){
  const list = [];
  contracts.forEach(c => {
    (c.comments||[]).forEach(cm => {
      if(cm.byRole === 'viewer') list.push({ contractId: c.id, contractName: c.name, ...cm });
    });
  });
  list.sort((a,b) => (b.time||0)-(a.time||0));
  return list;
}
function pmoSeenKey(){ return 'afrachoob-pmo-seen-' + (currentUser ? currentUser.uid : 'x'); }
function getPmoLastSeen(){ try{ return parseInt(localStorage.getItem(pmoSeenKey())||'0',10); }catch(e){ return 0; } }
function markPmoCommentsSeen(){
  try{ localStorage.setItem(pmoSeenKey(), String(Date.now())); }catch(e){}
}
function pmoUnseenCount(){
  const lastSeen = getPmoLastSeen();
  return getAllPmoComments().filter(cm => (cm.time||0) > lastSeen).length;
}
function onPmoCommentsSearch(v){ pmoCommentsSearch = v; renderPmoCommentsList(); }
function renderPmoCommentsHtml(){
  markPmoCommentsSeen();
  return `
    <div class="section-title" style="margin-top:14px;">💬 کامنت‌های مدیر پروژه <span class="cnt" id="pmoCmtCount"></span></div>
    <input type="text" id="pmoCmtSearch" placeholder="جستجو بر اساس نام قرارداد یا متن کامنت..." value="${escapeHtml(pmoCommentsSearch)}" class="auth-input" style="max-width:none;width:100%;margin-bottom:10px;" oninput="onPmoCommentsSearch(this.value)">
    <div id="pmoCmtList"></div>`;
}
function renderPmoCommentsList(){
  const el = document.getElementById('pmoCmtList');
  if(!el) return;
  let items = getAllPmoComments();
  const q = pmoCommentsSearch.trim().toLowerCase();
  if(q) items = items.filter(cm => (cm.contractName||'').toLowerCase().includes(q) || (cm.text||'').toLowerCase().includes(q));
  const cntEl = document.getElementById('pmoCmtCount');
  if(cntEl) cntEl.textContent = items.length + ' مورد';
  if(!items.length){ el.innerHTML = '<div class="empty">هنوز کامنتی از مدیر پروژه ثبت نشده.</div>'; return; }
  el.innerHTML = items.map(cm => `
      <div class="warn-item" style="cursor:pointer;" onclick="openContractDetail('${cm.contractId}', ${myRole==='admin'})">
        <div>
          <div class="warn-name">${escapeHtml(cm.contractName||'')}</div>
          <div class="warn-sub">${escapeHtml(cm.text)}</div>
        </div>
        <span class="warn-tag" style="color:var(--ink-faint); background:var(--panel-2);">${fmtTime(new Date(cm.time).toISOString())}</span>
      </div>`).join('');
}

/* ---------- ارتباط با کنترل پروژه / ارتباط با مدیر — پیام عمومی، مستقل از قرارداد خاص، دوطرفه با وضعیت «دیده شد» ---------- */
function mergePmNotesAB(){
  const map = {};
  pmNotesA.concat(pmNotesB).forEach(n => { map[n.id] = n; });
  pmNotes = Object.values(map);
}
async function sendPmNote(toUid){
  if(!db || !currentUser) return;
  const inputId = toUid ? ('pmReply_' + toUid) : 'pmNoteInput';
  const input = document.getElementById(inputId);
  const text = input ? input.value.trim() : '';
  if(!text) return;
  try{
    const doc = { text, by: currentUser.email||'', byRole: myRole||'', byUid: currentUser.uid, time: Date.now(), seen: false };
    if(toUid) doc.toUid = toUid;
    await db.collection('pmNotes').add(doc);
    if(input) input.value = '';
  }catch(err){
    alert('خطا در ارسال پیام: ' + (err && err.message ? err.message : String(err)));
  }
}
async function deletePmNote(id){
  if(!db) return;
  if(!confirm('این پیام حذف شود؟')) return;
  try{ await db.collection('pmNotes').doc(id).delete(); }catch(err){ alert('خطا در حذف: ' + (err && err.message ? err.message : String(err))); }
}
// وقتی طرف مقابل پیام رو باز/می‌بینه، این تابع اون پیام‌های ندیده رو seen می‌کنه (بی‌صدا، بدون رندر مجدد دستی)
async function markPmNotesSeen(filterFn){
  if(!db) return;
  const unseen = pmNotes.filter(n => !n.seen && filterFn(n));
  if(!unseen.length) return;
  try{
    const batch = db.batch();
    unseen.forEach(n => batch.update(db.collection('pmNotes').doc(n.id), { seen: true }));
    await batch.commit();
  }catch(e){ /* غیر حیاتیه — اگه ناموفق بود، دفعه‌ی بعد دوباره تلاش می‌شه */ }
}
function pmMessagesUnseenCountForAdmin(){ return pmNotes.filter(n => n.byRole === 'viewer' && !n.seen).length; }
function pmMessagesUnseenCountForViewer(){ return currentUser ? pmNotes.filter(n => n.byRole === 'admin' && n.toUid === currentUser.uid && !n.seen).length : 0; }
function renderPmMessageHtml(n){
  const seenTag = n.seen ? '<span class="pm-seen">✓ دیده شد</span>' : '';
  const canDelete = currentUser && (n.byUid === currentUser.uid || myRole === 'admin');
  const who = n.byRole === 'admin' ? 'مدیر (کنترل پروژه)' : PMO_DISPLAY_NAME;
  return `
    <div class="comment-item">
      <div class="comment-top">
        <span class="comment-by">${who}</span>
        <span class="comment-time-wrap"><span class="comment-time">${fmtTime(new Date(n.time).toISOString())}</span>${canDelete?`<button class="comment-del" title="حذف پیام" onclick="deletePmNote('${n.id}')">✕</button>`:''}</span>
      </div>
      <div class="comment-text">${escapeHtml(n.text)}</div>
      ${seenTag}
    </div>`;
}
function renderPmNotesFlatHtml(){
  const items = pmNotes.slice().sort((a,b) => (a.time||0)-(b.time||0));
  if(!items.length) return '<div class="empty" style="padding:14px;">هنوز پیامی ثبت نشده.</div>';
  return items.map(renderPmMessageHtml).join('');
}
// پنل مدیر: پیام‌ها را بر اساس مدیر پروژه‌ی فرستنده/گیرنده گروه‌بندی می‌کند (برای پشتیبانی از چند مدیر پروژه در آینده)
function pmConversations(){
  const map = {};
  pmNotes.forEach(n => {
    const otherUid = n.byRole === 'viewer' ? n.byUid : n.toUid;
    if(!otherUid) return;
    if(!map[otherUid]) map[otherUid] = [];
    map[otherUid].push(n);
  });
  return Object.keys(map).map(uid => ({ uid, messages: map[uid].sort((a,b) => (a.time||0)-(b.time||0)) }));
}
function renderPmConversationsHtml(){
  const convos = pmConversations();
  if(!convos.length) return '<div class="empty">هنوز پیامی از مدیر پروژه دریافت نشده.</div>';
  return convos.map(cv => `
    <div class="pm-thread">
      <div class="pm-thread-title">${PMO_DISPLAY_NAME}</div>
      ${cv.messages.map(renderPmMessageHtml).join('')}
      <div class="comment-add-row">
        <input type="text" id="pmReply_${cv.uid}" class="auth-input" style="max-width:none; flex:1;" placeholder="پاسخ...">
        <button class="field-save" onclick="sendPmNote('${cv.uid}')">ارسال</button>
      </div>
    </div>`).join('');
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

    // نگه‌داشتن نشست ورود روی خود دستگاه — کاربر با بستن/بازکردن اپ دوباره بیرون نمی‌افتد
    auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL).catch(() => {});

    // فعال‌سازی حالت آفلاین: تغییرات وقتی اینترنت نیست هم ذخیره می‌شوند و
    // به‌محض وصل‌شدن اینترنت خودکار با سرور همگام می‌شوند (هم مدیر، هم سرپرست).
    try{
      db.enablePersistence({ synchronizeTabs: true }).catch(() => {});
    }catch(e){}

    window.addEventListener('online', () => setStatus('همگام — لحظه‌ای', true));
    window.addEventListener('offline', () => setStatus('آفلاین — تغییرات ذخیره و بعداً همگام می‌شود', false));
    if(!navigator.onLine) setStatus('آفلاین — تغییرات ذخیره و بعداً همگام می‌شود', false);

    auth.onAuthStateChanged(async (user) => {
      currentUser = user;
      dataSubscribed = false;
      stopPresenceHeartbeat();
      if(!user){ myRole = null; myPosition = ''; renderApp(); return; }
      const ref = db.collection('users').doc(user.uid);
      startPresenceHeartbeat(ref);
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

/* ---------- Presence (آخرین حضور) ----------
   Firestore خودش مثل Realtime Database قابلیت onDisconnect نداره، بنابراین وضعیت
   حضور با یک "ضربان" (heartbeat) دوره‌ای پیاده شده: هر کاربر هر ۲۰ ثانیه که اپ
   براش باز و فعاله، فیلد lastSeen رو روی خودش (فقط خودش) آپدیت می‌کنه.
   در پنل مدیر، اگه lastSeen یک کاربر کمتر از ۴۵ ثانیه پیش باشه «آنلاین» نشون داده
   می‌شه، وگرنه «آخرین بازدید ... پیش». این باعث اختلال یا خروج کسی از پنلش نمی‌شه. */
const PRESENCE_INTERVAL_MS = 20000;
const PRESENCE_ONLINE_THRESHOLD_MS = 45000;
function startPresenceHeartbeat(userRef){
  const beat = () => { userRef.update({ lastSeen: Date.now() }).catch(() => {}); };
  beat();
  presenceInterval = setInterval(() => {
    if(document.visibilityState === 'visible') beat();
  }, PRESENCE_INTERVAL_MS);
  document.addEventListener('visibilitychange', () => {
    if(document.visibilityState === 'visible' && currentUser) beat();
  });
}
function stopPresenceHeartbeat(){
  if(presenceInterval){ clearInterval(presenceInterval); presenceInterval = null; }
}
function isUserOnline(u){
  return !!(u && u.lastSeen && (Date.now() - u.lastSeen) < PRESENCE_ONLINE_THRESHOLD_MS);
}
function fmtLastSeen(ts){
  if(!ts) return 'هنوز آنلاین نشده';
  const diffMin = Math.round((Date.now() - ts) / 60000);
  if(diffMin < 1) return 'همین الان';
  if(diffMin < 60) return 'آخرین بازدید: ' + diffMin + ' دقیقه پیش';
  const diffH = Math.round(diffMin / 60);
  if(diffH < 24) return 'آخرین بازدید: ' + diffH + ' ساعت پیش';
  return 'آخرین بازدید: ' + Math.round(diffH / 24) + ' روز پیش';
}

function ensureDataSubscriptions(){
  if(dataSubscribed) return;
  if(myRole !== 'admin' && myRole !== 'supervisor' && myRole !== 'viewer' && myRole !== 'afrachoobSupervisor') return;
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

    db.collection('activityLog').orderBy('time','desc').limit(300).onSnapshot((snap) => {
      activityLog = snap.docs.map(d => ({ id:d.id, ...d.data() }));
      if(adminTab === 'log') renderApp();
    }, () => { /* اگه قوانین Firestore هنوز آپدیت نشده باشه، فقط لاگ کار نمی‌کنه؛ بقیه‌ی اپ دست‌نخورده می‌مونه */ });

    db.collection('pmNotes').orderBy('time','desc').limit(200).onSnapshot((snap) => {
      pmNotes = snap.docs.map(d => ({ id:d.id, ...d.data() }));
      renderApp();
    }, () => { /* اگه قوانین هنوز آپدیت نشده، فقط این بخش کار نمی‌کنه */ });
  }
  if(myRole === 'viewer'){
    db.collection('pmNotes').where('byUid','==', currentUser.uid).onSnapshot((snap) => {
      pmNotesA = snap.docs.map(d => ({ id:d.id, ...d.data() }));
      mergePmNotesAB();
      renderApp();
    }, () => {});
    db.collection('pmNotes').where('toUid','==', currentUser.uid).onSnapshot((snap) => {
      pmNotesB = snap.docs.map(d => ({ id:d.id, ...d.data() }));
      mergePmNotesAB();
      renderApp();
    }, () => {});
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
  hideSplash();
  refreshContractModal();

  if(!currentUser){
    headerRight.innerHTML = '';
    el.innerHTML = `
      <div class="center-screen">
        <img src="./icon-192.png" alt="افراچوب">
        <h2>ورود به افراچوب</h2>
        <p>برای مشاهده و مدیریت وضعیت قراردادها، با ایمیل و رمز عبور خود وارد شوید.</p>
        <input class="auth-input" type="email" id="authEmail" placeholder="ایمیل" autocomplete="username">
        <input class="auth-input" type="password" id="authPass" placeholder="رمز عبور" autocomplete="current-password">
        <div class="auth-btn-row">
          <button class="google-btn" onclick="signIn()">ورود</button>
          <button class="google-btn auth-btn-secondary" onclick="signUp()">ساخت حساب جدید</button>
        </div>
        <p class="vpn-note">لطفا جهت ورود VPN خود را روشن کنید</p>
        <p class="auth-help-note">اگر تا الان وارد برنامه نشدین لطفا ایمیل رو وارد کنید و رمز دلخواه ۶ رقمی بگذارید و روی دکمه ایجاد حساب جدید بزنید، در غیر این صورت ایمیل و رمز رو بزنید و دکمه ورود رو بفشارید.</p>
        ${authErrorMsg ? `<p style="color:var(--red); font-size:12px; max-width:320px;">${escapeHtml(authErrorMsg)}</p>` : ''}
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
  if(myRole === 'viewer'){ renderViewer(el); return; }
  if(myRole === 'afrachoobSupervisor'){ renderAfrachoobSupervisor(el); return; }

  el.innerHTML = `<div class="center-screen">
    <span class="sync-note"><span class="dot" id="statusDot"></span><span id="syncNote">در حال بارگذاری…</span></span>
    ${authErrorMsg ? `<p style="color:var(--red); font-family:'JetBrains Mono',monospace; font-size:11px; direction:ltr; max-width:320px;">${escapeHtml(authErrorMsg)}</p>` : ''}
    <button class="signout-btn" onclick="signOutUser()">خروج و تلاش دوباره</button>
  </div>`;
}

function roleFa(r){
  return { admin:'مدیر', supervisor:'سرپرست نصب', viewer:'مدیر پروژه', afrachoobSupervisor:'سرپرست افراچوب', pending:'در انتظار تایید', blocked:'مسدود' }[r] || r;
}

/* ---------- Shared: warnings list ---------- */
function renderWarningsHtml(){
  const nearing = contracts
    .filter(isWarnEligible)
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
  const pmoUnseen = pmoUnseenCount();
  el.innerHTML = `
    <div class="toolbar"><button id="installBtn" class="btn-secondary" onclick="installApp()">نصب اپلیکیشن روی گوشی</button></div>
    <div class="tabs">
      <button class="${supervisorTab==='contracts'?'active':''}" onclick="switchSupervisorTab('contracts')">قراردادها</button>
      <button class="${supervisorTab==='warnings'?'active':''}" onclick="switchSupervisorTab('warnings')">هشدار سررسید</button>
      <button class="${supervisorTab==='closed'?'active':''}" onclick="switchSupervisorTab('closed')">خاتمه‌ها ${closedCount?('('+closedCount+')'):''}</button>
    </div>
    <div class="tabs" style="margin-top:8px;">
      <button class="${supervisorTab==='pmoComments'?'active':''}" onclick="switchSupervisorTab('pmoComments')">💬 کامنت‌های مدیر پروژه ${pmoUnseen?('('+pmoUnseen+')'):''}</button>
    </div>
    <div id="supBody"></div>
    <div class="sync-note"><span class="dot" id="statusDot"></span><span id="syncNote">همگام — لحظه‌ای</span></div>
  `;
  const installBtn = document.getElementById('installBtn');
  if(installBtn) installBtn.style.display = window.__deferredPrompt ? 'block' : 'none';
  const body = document.getElementById('supBody');
  if(supervisorTab === 'contracts'){
    body.innerHTML = `
      <div class="section-title" style="margin-top:14px;">قراردادها <span class="cnt" id="supCount"></span></div>
      <input type="text" id="supSearch" placeholder="جستجو بر اساس نام یا کد قلم..." value="${escapeHtml(supervisorSearchQuery)}" class="auth-input" style="max-width:none;width:100%;margin-bottom:10px;" oninput="onSupervisorSearch(this.value)">
      <div id="list"></div>`;
    renderSupervisorList();
  } else if(supervisorTab === 'warnings'){
    body.innerHTML = renderWarningsHtml();
  } else if(supervisorTab === 'pmoComments'){
    body.innerHTML = renderPmoCommentsHtml();
    renderPmoCommentsList();
  } else {
    body.innerHTML = `<div class="section-title" style="margin-top:14px;">خاتمه‌ها <span class="cnt">${closedCount} مورد</span></div><div id="list"></div>`;
    renderList(false, isCompleted);
  }
}
function switchSupervisorTab(t){ supervisorTab = t; renderApp(); }
function onSupervisorSearch(v){ supervisorSearchQuery = v; renderSupervisorList(); }
function renderSupervisorList(){
  const q = supervisorSearchQuery.trim().toLowerCase();
  const predicate = c => !isCompleted(c) && (!q || (c.name||'').toLowerCase().includes(q) || (c.itemCode||'').toLowerCase().includes(q));
  const cntEl = document.getElementById('supCount');
  if(cntEl) cntEl.textContent = contracts.filter(predicate).length + ' مورد';
  renderList(false, predicate);
}

/* ---------- Afrachoob Supervisor (سرپرست افراچوب) — V10 ----------
   دقیقاً مثل پنل «سرپرست نصب» (همون دسترسی ویرایش کامل روی قراردادها) به‌علاوه‌ی یک تب «داشبورد»
   با چارت و سه دکمه‌ی بحرانی/در انتظار تحویل‌دهی/منتظر نصب صفحه — با همون منطق مدیر پروژه و مدیر.
   کامنت‌گذاری روی قرارداد و تاریخچه برای این نقش غیرفعال است. */
function renderAfrachoobSupervisor(el){
  const closedCount = contracts.filter(isCompleted).length;
  const pmoUnseen = pmoUnseenCount();
  el.innerHTML = `
    <div class="toolbar"><button id="installBtn" class="btn-secondary" onclick="installApp()">نصب اپلیکیشن روی گوشی</button></div>
    <div class="tabs">
      <button class="${afrTab==='dashboard'?'active':''}" onclick="switchAfrTab('dashboard')">داشبورد</button>
      <button class="${afrTab==='contracts'?'active':''}" onclick="switchAfrTab('contracts')">قراردادها</button>
      <button class="${afrTab==='closed'?'active':''}" onclick="switchAfrTab('closed')">خاتمه‌ها ${closedCount?('('+closedCount+')'):''}</button>
    </div>
    <div class="tabs" style="margin-top:8px;">
      <button class="${afrTab==='warnings'?'active':''}" onclick="switchAfrTab('warnings')">هشدار سررسید</button>
      <button class="${afrTab==='pmoComments'?'active':''}" onclick="switchAfrTab('pmoComments')">💬 کامنت‌های مدیر پروژه ${pmoUnseen?('('+pmoUnseen+')'):''}</button>
    </div>
    <div id="afrBody"></div>
    <div class="sync-note"><span class="dot" id="statusDot"></span><span id="syncNote">همگام — لحظه‌ای</span></div>
  `;
  const installBtn = document.getElementById('installBtn');
  if(installBtn) installBtn.style.display = window.__deferredPrompt ? 'block' : 'none';
  const body = document.getElementById('afrBody');
  if(afrTab === 'dashboard'){
    renderAfrDashboard(body);
  } else if(afrTab === 'contracts'){
    body.innerHTML = `
      <div class="section-title" style="margin-top:14px;">قراردادها <span class="cnt" id="afrCount"></span></div>
      <input type="text" id="afrSearch" placeholder="جستجو بر اساس نام یا کد قلم..." value="${escapeHtml(afrSearchQuery)}" class="auth-input" style="max-width:none;width:100%;margin-bottom:10px;" oninput="onAfrSearch(this.value)">
      <div style="display:flex; gap:8px; margin-bottom:14px;">
        <select id="afrStageFilter" class="admin-select" onchange="onAfrStageFilter(this.value)">
          <option value="all">همه مراحل</option>
          ${STAGES.map((s,i) => `<option value="${i}" ${afrFilterStage===String(i)?'selected':''}>${s.name}</option>`).join('')}
        </select>
        <select id="afrStatusFilter" class="admin-select" onchange="onAfrStatusFilter(this.value)">
          <option value="all">همه وضعیت‌ها</option>
          <option value="late" ${afrFilterStatus==='late'?'selected':''}>عقب‌افتاده</option>
          <option value="near" ${afrFilterStatus==='near'?'selected':''}>نزدیک سررسید</option>
          <option value="stale" ${afrFilterStatus==='stale'?'selected':''}>بروزرسانی نشده</option>
          <option value="closed" ${afrFilterStatus==='closed'?'selected':''}>خاتمه‌یافته</option>
        </select>
      </div>
      <div id="list"></div>`;
    renderAfrList();
  } else if(afrTab === 'warnings'){
    body.innerHTML = renderWarningsHtml();
  } else if(afrTab === 'pmoComments'){
    body.innerHTML = renderPmoCommentsHtml();
    renderPmoCommentsList();
  } else {
    body.innerHTML = `<div class="section-title" style="margin-top:14px;">خاتمه‌ها <span class="cnt">${closedCount} مورد</span></div><div id="list"></div>`;
    renderList(false, isCompleted);
  }
}
function switchAfrTab(t){ afrTab = t; renderApp(); }
function onAfrSearch(v){ afrSearchQuery = v; renderAfrList(); }
function onAfrStageFilter(v){ afrFilterStage = v; renderAfrList(); }
function onAfrStatusFilter(v){ afrFilterStatus = v; renderAfrList(); }
function renderAfrList(){
  const q = afrSearchQuery.trim().toLowerCase();
  const predicate = c => {
    if(q && !((c.name||'').toLowerCase().includes(q) || (c.itemCode||'').toLowerCase().includes(q))) return false;
    if(afrFilterStage !== 'all' && getDisplayStageIndex(c) !== parseInt(afrFilterStage,10)) return false;
    if(afrFilterStatus === 'closed') return isCompleted(c);
    if(afrFilterStatus !== 'all'){
      if(isCompleted(c)) return false;
      return afrFilterStatus === 'stale' ? isNotUpdated(c) : adminTimeStatus(c).cls === afrFilterStatus;
    }
    return true;
  };
  const cntEl = document.getElementById('afrCount');
  if(cntEl) cntEl.textContent = contracts.filter(predicate).length + ' مورد';
  renderList(false, predicate);
}

function renderAfrDashboard(body){
  const vs = computeViewerStats();
  body.innerHTML = `
    <div class="kpi-grid" style="margin-top:14px;">
      <div class="kpi-card" style="cursor:pointer;" onclick="switchAfrDashSection('all')"><div class="kpi-num">${contracts.length}</div><div class="kpi-label">کل قراردادها</div></div>
      <div class="kpi-card" style="cursor:pointer;" onclick="switchAfrDashSection('active')"><div class="kpi-num">${vs.active.length}</div><div class="kpi-label">خاتمه نیافته</div></div>
      <div class="kpi-card" style="cursor:pointer;" onclick="switchAfrDashSection('closed')"><div class="kpi-num">${vs.completed.length}</div><div class="kpi-label">خاتمه‌یافته</div></div>
      <div class="kpi-card kpi-red" style="cursor:pointer;" onclick="switchAfrDashSection('critical')"><div class="kpi-num">${vs.criticalList.length}</div><div class="kpi-label">بحرانی</div></div>
      <div class="kpi-card kpi-blue" style="cursor:pointer;" onclick="switchAfrDashSection('waitingdelivery')"><div class="kpi-num">${vs.waitingDeliveryList.length}</div><div class="kpi-label">در انتظار تحویل‌دهی به مالک</div></div>
      <div class="kpi-card kpi-blue"><div class="kpi-num">${vs.avgProgress}٪</div><div class="kpi-label">میانگین پیشرفت</div></div>
    </div>
    ${renderStageChartHtml()}
    <div class="viewer-quicklinks" style="margin-top:18px;">
      <button class="${afrDashSection==='critical'?'active':''}" onclick="switchAfrDashSection('critical')">🔴 بحرانی ${vs.criticalList.length?('('+vs.criticalList.length+')'):''}</button>
      <button class="${afrDashSection==='waitingdelivery'?'active':''}" onclick="switchAfrDashSection('waitingdelivery')">📦 در انتظار تحویل‌دهی به مالک ${vs.waitingDeliveryList.length?('('+vs.waitingDeliveryList.length+')'):''}</button>
      <button class="${afrDashSection==='panelwait'?'active':''}" onclick="switchAfrDashSection('panelwait')">🛠 منتظر نصب صفحه کابینت ${vs.panelWaitList.length?('('+vs.panelWaitList.length+')'):''}</button>
    </div>
    <div id="afrDashSectionBody"></div>
  `;
  renderAfrDashSectionBody();
}
function switchAfrDashSection(sec){
  afrDashSection = (afrDashSection === sec) ? null : sec;
  afrDashSearch = '';
  renderApp();
}
function afrDashSectionContracts(){
  const vs = computeViewerStats();
  if(afrDashSection === 'critical') return vs.criticalList;
  if(afrDashSection === 'waitingdelivery') return vs.waitingDeliveryList;
  if(afrDashSection === 'panelwait') return vs.panelWaitList;
  if(afrDashSection === 'active') return vs.active;
  if(afrDashSection === 'closed') return vs.completed;
  if(afrDashSection === 'all') return contracts.slice();
  return [];
}
function onAfrDashSearch(v){ afrDashSearch = v; renderAfrDashSectionList(); }
function renderAfrDashSectionBody(){
  const wrap = document.getElementById('afrDashSectionBody');
  if(!wrap) return;
  if(!afrDashSection){ wrap.innerHTML = ''; return; }
  const titles = { critical:'قراردادهای بحرانی', waitingdelivery:'در انتظار تحویل‌دهی به مالک', panelwait:'منتظر نصب صفحه کابینت', active:'قراردادهای خاتمه نیافته', closed:'قراردادهای خاتمه‌یافته', all:'همه قراردادها' };
  wrap.innerHTML = `
    <div class="section-title" style="margin-top:16px;">${titles[afrDashSection]} <span class="cnt" id="afrDashCount"></span></div>
    <input type="text" id="afrDashSearchInput" placeholder="جستجو بر اساس نام یا کد قلم..." value="${escapeHtml(afrDashSearch)}" class="auth-input" style="max-width:none;width:100%;margin-bottom:10px;" oninput="onAfrDashSearch(this.value)">
    <div id="afrDashList"></div>`;
  renderAfrDashSectionList();
}
function renderAfrDashSectionList(){
  const el = document.getElementById('afrDashList');
  if(!el) return;
  const q = afrDashSearch.trim().toLowerCase();
  let items = afrDashSectionContracts();
  if(q) items = items.filter(c => (c.name||'').toLowerCase().includes(q) || (c.itemCode||'').toLowerCase().includes(q));
  const cntEl = document.getElementById('afrDashCount');
  if(cntEl) cntEl.textContent = items.length + ' مورد';
  if(!items.length){ el.innerHTML = '<div class="empty">موردی یافت نشد.</div>'; return; }
  el.innerHTML = items.map(c => renderSupervisorRow(c)).join('');
}

/* ---------- Viewer role — "مدیر پروژه": پنل کاملاً جدا، فقط گزارش + کامنت، بدون هیچ ویرایشی روی قراردادها ---------- */
function computeViewerStats(){
  const active = contracts.filter(c => !isCompleted(c));
  const completed = contracts.filter(isCompleted);
  const avgProgress = active.length ? Math.round(active.reduce((s,c) => s+overallPercent(c), 0) / active.length) : 0;
  const criticalList = active.filter(c => viewerCriticalStatus(c).critical);
  const nearList = active.filter(c => viewerCriticalStatus(c).cls === 'warn');
  const panelWaitList = active.filter(isPanelWaiting);
  const waitingDeliveryList = active.filter(c => getDisplayStageIndex(c) === STAGES.length-2);
  return { active, completed, avgProgress, criticalList, nearList, panelWaitList, waitingDeliveryList };
}

function renderViewer(el){
  const s = computeViewerStats();
  el.innerHTML = `
    <div class="viewer-hero">
      <img src="./icon-192.png" alt="افراچوب">
      <div>
        <div class="viewer-hero-title">${myPosition ? escapeHtml(myPosition) : 'مدیر پروژه'} عزیز، خوش آمدید 👋</div>
        <div class="viewer-hero-sub">نمای کلی و لحظه‌ای وضعیت همه‌ی پروژه‌های افراچوب — با یک نگاه</div>
      </div>
    </div>

    <div class="toolbar"><button id="installBtn" class="btn-secondary" onclick="installApp()">نصب اپلیکیشن روی گوشی</button></div>

    <div class="kpi-grid" style="margin-top:6px;">
      <div class="kpi-card" style="cursor:pointer;" onclick="switchViewerSection('all')"><div class="kpi-num">${contracts.length}</div><div class="kpi-label">کل قراردادها</div></div>
      <div class="kpi-card" style="cursor:pointer;" onclick="switchViewerSection('active')"><div class="kpi-num">${s.active.length}</div><div class="kpi-label">خاتمه نیافته</div></div>
      <div class="kpi-card" style="cursor:pointer;" onclick="switchViewerSection('closed')"><div class="kpi-num">${s.completed.length}</div><div class="kpi-label">خاتمه‌یافته</div></div>
      <div class="kpi-card kpi-red" style="cursor:pointer;" onclick="switchViewerSection('critical')"><div class="kpi-num">${s.criticalList.length}</div><div class="kpi-label">بحرانی</div></div>
      <div class="kpi-card kpi-blue" style="cursor:pointer;" onclick="switchViewerSection('waitingdelivery')"><div class="kpi-num">${s.waitingDeliveryList.length}</div><div class="kpi-label">در انتظار تحویل‌دهی به مالک</div></div>
      <div class="kpi-card kpi-blue"><div class="kpi-num">${s.avgProgress}٪</div><div class="kpi-label">میانگین پیشرفت</div></div>
    </div>

    ${renderStageChartHtml()}

    <div class="viewer-quicklinks">
      <button class="${viewerSection==='critical'?'active':''}" onclick="switchViewerSection('critical')">🔴 قراردادهای بحرانی ${s.criticalList.length?('('+s.criticalList.length+')'):''}</button>
      <button class="${viewerSection==='panelwait'?'active':''}" onclick="switchViewerSection('panelwait')">🛠 منتظر نصب صفحه کابینت ${s.panelWaitList.length?('('+s.panelWaitList.length+')'):''}</button>
      <button class="${viewerSection==='waitingdelivery'?'active':''}" onclick="switchViewerSection('waitingdelivery')">📦 در انتظار تحویل‌دهی به مالک ${s.waitingDeliveryList.length?('('+s.waitingDeliveryList.length+')'):''}</button>
      <button class="${viewerSection==='all'?'active':''}" onclick="switchViewerSection('all')">📋 همه قراردادها (${contracts.length})</button>
      <button class="${viewerSection==='contact'?'active':''}" onclick="switchViewerSection('contact')">✉️ ارتباط با کنترل پروژه ${pmMessagesUnseenCountForViewer()?('('+pmMessagesUnseenCountForViewer()+')'):''}</button>
    </div>

    <div id="viewerSectionBody"></div>

    <div class="section-title" style="margin-top:22px;">خروجی گزارش</div>
    <div class="export-filters">
      <div class="row1">
        <select id="exportScopeSelect" class="admin-select" onchange="onExportScopeChange(this.value)">
          <option value="all" ${exportScope==='all'?'selected':''}>همه قراردادها</option>
          <option value="active" ${exportScope==='active'?'selected':''}>فقط خاتمه‌نیافته</option>
          <option value="closed" ${exportScope==='closed'?'selected':''}>فقط خاتمه‌یافته</option>
          <option value="waiting" ${exportScope==='waiting'?'selected':''}>فقط در انتظار تحویل‌دهی</option>
        </select>
      </div>
    </div>
    <div class="export-row">
      <button class="export-btn" id="exportExcelBtn" onclick="exportExcelViewer()">📊 خروجی اکسل</button>
      <button class="export-btn" id="exportPdfBtn" onclick="exportPDFViewer()">📄 خروجی PDF (شامل نمودار)</button>
    </div>

    <div class="viewer-footer-badge">پنل هوشمند مدیریت پروژه — افراچوب</div>
    <div class="sync-note"><span class="dot" id="statusDot"></span><span id="syncNote">همگام — لحظه‌ای</span></div>
  `;
  const installBtn = document.getElementById('installBtn');
  if(installBtn) installBtn.style.display = window.__deferredPrompt ? 'block' : 'none';
  renderViewerSectionBody();
}
function switchViewerSection(sec){
  viewerSection = (viewerSection === sec) ? null : sec;
  viewerSearchQuery = '';
  renderApp();
}
function onViewerSearch(v){ viewerSearchQuery = v; renderViewerSectionList(); }
function viewerSectionContracts(){
  const s = computeViewerStats();
  if(viewerSection === 'critical') return s.criticalList;
  if(viewerSection === 'panelwait') return s.panelWaitList;
  if(viewerSection === 'waitingdelivery') return s.waitingDeliveryList;
  if(viewerSection === 'active') return s.active;
  if(viewerSection === 'closed') return s.completed;
  if(viewerSection === 'all') return contracts.slice();
  return [];
}
function viewerSectionTitle(){
  return { critical:'قراردادهای بحرانی', panelwait:'منتظر نصب صفحه کابینت', waitingdelivery:'در انتظار تحویل‌دهی به مالک', active:'قراردادهای خاتمه نیافته', closed:'قراردادهای خاتمه‌یافته', all:'همه قراردادها' }[viewerSection] || '';
}
function renderViewerSectionBody(){
  const body = document.getElementById('viewerSectionBody');
  if(!body) return;
  if(!viewerSection){ body.innerHTML = ''; return; }
  if(viewerSection === 'contact'){
    markPmNotesSeen(n => n.byRole === 'admin' && currentUser && n.toUid === currentUser.uid);
    body.innerHTML = `
      <div class="section-title" style="margin-top:18px;">✉️ ارتباط با کنترل پروژه</div>
      <div class="viewer-report-note">پیام‌هایی که اینجا می‌نویسید مستقیم برای مدیر (کنترل پروژه) ارسال می‌شود — مخصوص موضوعات کلی، نه یک قرارداد خاص.</div>
      <div id="pmNotesList">${renderPmNotesFlatHtml()}</div>
      <div class="comment-add-row" style="margin-top:12px;">
        <input type="text" id="pmNoteInput" class="auth-input" style="max-width:none; flex:1;" placeholder="پیام خود را بنویسید...">
        <button class="field-save" onclick="sendPmNote()">ارسال</button>
      </div>`;
    return;
  }
  body.innerHTML = `
    <div class="section-title" style="margin-top:18px;">${viewerSectionTitle()} <span class="cnt" id="viewerSecCount"></span></div>
    <input type="text" id="viewerSearch" placeholder="جستجو بر اساس نام یا کد قلم..." value="${escapeHtml(viewerSearchQuery)}" class="auth-input" style="max-width:none;width:100%;margin-bottom:10px;" oninput="onViewerSearch(this.value)">
    <div id="viewerList"></div>`;
  renderViewerSectionList();
}
function renderViewerSectionList(){
  const el = document.getElementById('viewerList');
  if(!el) return;
  const q = viewerSearchQuery.trim().toLowerCase();
  let items = viewerSectionContracts();
  if(q) items = items.filter(c => (c.name||'').toLowerCase().includes(q) || (c.itemCode||'').toLowerCase().includes(q));
  items = items.slice().sort((a,b) => { const ac = isCompleted(a), bc = isCompleted(b); return ac===bc ? 0 : (ac?1:-1); });
  const cntEl = document.getElementById('viewerSecCount');
  if(cntEl) cntEl.textContent = items.length + ' مورد';
  if(!items.length){ el.innerHTML = '<div class="empty">موردی یافت نشد.</div>'; return; }
  el.innerHTML = items.map(c => renderViewerCard(c)).join('');
}
function renderViewerCard(c){
  const curIdx = getCurrentIndex(c);
  const displayIdx = getDisplayStageIndex(c);
  const pct = overallPercent(c);
  const done = isCompleted(c);
  const vs = viewerCriticalStatus(c);
  const isOpen = viewerOpenId === c.id;
  const hOpen = !!viewerHistoryOpen[c.id]; // همیشه پیش‌فرض بسته
  const commentCount = (c.comments||[]).length;
  const panelWait = isPanelWaiting(c);
  const badges = [];
  if(c.itemCode) badges.push('<span class="mini-badge">کد قلم: ' + escapeHtml(c.itemCode) + '</span>');
  if(commentCount) badges.push('<span class="mini-badge">💬 ' + commentCount + '</span>');
  if(panelWait) badges.push('<span class="mini-badge" style="color:var(--amber); border-color:var(--amber);">منتظر نصب صفحه</span>');
  const timelineHtml = STAGES.map((st,i) => {
    const s = (c.status||{})[i] || {};
    const stageDone = isStageDone(c.status||{}, i);
    const dotCls = stageDone ? 'done' : (i===curIdx?'active':'');
    const nameCls = stageDone ? 'done' : '';
    const extra = st.type==='progress' ? `<div class="tl-time">${s.percent||0}٪${s.predictedDate?' — پیش‌بینی: '+escapeHtml(s.predictedDate):''}</div>` : '';
    return `<div class="tl-item"><div class="tl-dot ${dotCls}"></div><div class="tl-row"><span class="tl-name ${nameCls}">${st.name}</span></div>${s.doneAt?`<div class="tl-time">${fmtTime(s.doneAt)}</div>`:''}${extra}</div>`;
  }).join('');
  const history = c.history || [];
  const histHtml = history.slice().reverse().slice(0,20).map(h =>
    `<div class="hist-item"><span>${escapeHtml(h.label)}</span><span class="hist-time">${fmtTime(h.time)}${h.by?' — '+authorLabel(h):''}</span></div>`
  ).join('') || '<div class="hist-item"><span>—</span></div>';

  return `
    <div class="card">
      <div class="card-head" style="cursor:pointer;" onclick="toggleViewerCard('${c.id}')">
        <div class="card-title">
          <span class="card-name">${escapeHtml(c.name)}</span>
          <span class="card-sub">مرحله: ${STAGES[displayIdx].name}${c.itemCode?' — کد قلم: '+escapeHtml(c.itemCode):''}</span>
          <div class="card-badges">${badges.join('')}</div>
        </div>
        <span class="stage-pill" style="${done?'background:var(--green-dim);color:var(--green);':(vs.critical?'background:var(--red-dim);color:var(--red);':'')}">${done?'خاتمه‌یافته':pct+'٪'}</span>
      </div>
      <div class="progress-strip"><div style="width:${pct}%; ${done?'background:var(--green);':(vs.critical?'background:var(--red);':'')}"></div></div>
      ${done ? '' : `<div class="due-row"><span class="due-tag ${vs.cls==='late'?'late':vs.cls==='warn'?'warn':vs.cls==='ok'?'ok':'none'}">${vs.label}</span></div>`}
      <div class="body-panel ${isOpen?'open':''}">
        ${c.description ? `<div class="field-row text"><label>توضیحات:</label><span style="flex:1; font-size:12.5px;">${escapeHtml(c.description)}</span></div>` : ''}
        <div class="timeline">${timelineHtml}</div>
        <div class="hist-title" style="cursor:pointer; display:flex; justify-content:space-between; align-items:center;" onclick="event.stopPropagation(); toggleViewerHistory('${c.id}')">
          <span>تاریخچه ${hOpen ? '▲' : '▼'}</span>
        </div>
        ${hOpen ? histHtml : ''}
        ${renderCommentsHtml(c, 'v')}
      </div>
    </div>`;
}
function toggleViewerCard(id){ viewerOpenId = viewerOpenId===id ? null : id; renderApp(); }
function toggleViewerHistory(id){ viewerHistoryOpen[id] = !viewerHistoryOpen[id]; renderApp(); }


/* ---------- Admin view (V9 — Professional Dashboard) ---------- */
function renderAdmin(el){
  const pendingCount = usersList.filter(u => u.role === 'pending').length;
  const alertCount = adminAlerts().length;
  const pmoUnseen = pmoUnseenCount();
  const pmMsgUnseen = pmMessagesUnseenCountForAdmin();
  el.innerHTML = `
    <div class="toolbar">
      <button class="btn-primary" onclick="openAddModal()">+ قرارداد جدید</button>
      <button class="btn-secondary" onclick="openNotifications()">🔔 هشدارها ${alertCount ? '('+alertCount+')' : ''}</button>
    </div>
    <div class="toolbar"><button id="mgmtSummaryBtn" class="btn-primary" onclick="exportManagementSummaryPdf()">📱 خلاصه مدیریتی (اشتراک‌گذاری)</button></div>
    <div class="toolbar"><button id="installBtn" class="btn-secondary" onclick="installApp()">نصب اپلیکیشن روی گوشی</button></div>
    <div class="tabs">
      <button class="${adminTab==='dashboard'?'active':''}" onclick="switchAdminTab('dashboard')">داشبورد</button>
      <button class="${adminTab==='contracts'?'active':''}" onclick="switchAdminTab('contracts')">مدیریت قراردادها</button>
      <button class="${adminTab==='users'?'active':''}" onclick="switchAdminTab('users')">کاربران ${pendingCount?('('+pendingCount+')'):''}</button>
      <button class="${adminTab==='plans'?'active':''}" onclick="switchAdminTab('plans')">برنامه قراردادها</button>
    </div>
    <div class="tabs" style="margin-top:8px;">
      <button class="${adminTab==='log'?'active':''}" onclick="switchAdminTab('log')">لاگ سیستم</button>
      <button class="${adminTab==='pmoComments'?'active':''}" onclick="switchAdminTab('pmoComments')">💬 کامنت‌های مدیر پروژه ${pmoUnseen?('('+pmoUnseen+')'):''}</button>
      <button class="${adminTab==='pmoMessages'?'active':''}" onclick="switchAdminTab('pmoMessages')">✉️ ارتباط با مدیر ${pmMsgUnseen?('('+pmMsgUnseen+')'):''}</button>
    </div>
    <div id="adminBody"></div>
    <div class="sync-note"><span class="dot" id="statusDot"></span><span id="syncNote">همگام — لحظه‌ای</span></div>
  `;
  document.getElementById('installBtn').style.display = window.__deferredPrompt ? 'block' : 'none';
  if(adminTab === 'dashboard') renderAdminDashboard();
  else if(adminTab === 'contracts') renderAdminContracts();
  else if(adminTab === 'plans') renderAdminPlans();
  else if(adminTab === 'log') renderAdminLog();
  else if(adminTab === 'pmoComments'){
    document.getElementById('adminBody').innerHTML = renderPmoCommentsHtml();
    renderPmoCommentsList();
  } else if(adminTab === 'pmoMessages'){
    markPmNotesSeen(n => n.byRole === 'viewer');
    document.getElementById('adminBody').innerHTML = `
      <div class="section-title" style="margin-top:14px;">✉️ ارتباط با مدیر</div>
      <div class="viewer-report-note">گفتگوی عمومی با مدیر پروژه — مستقل از یک قرارداد خاص. می‌توانید مستقیماً از همین‌جا پاسخ بدهید.</div>
      <div id="pmConvos">${renderPmConversationsHtml()}</div>`;
  } else renderAdminUsers();
}
function switchAdminTab(t){ adminTab = t; renderApp(); }

function computeDashboardStats(){
  const active = contracts.filter(c => !isCompleted(c));
  const closed = contracts.filter(isCompleted);
  return {
    totalAll: contracts.length,
    closedCount: closed.length,
    delayed: active.filter(c => adminTimeStatus(c).cls === 'late').length,
    nearDue: active.filter(c => adminTimeStatus(c).cls === 'near').length,
    notUpdated: active.filter(isNotUpdated).length,
    waitingDelivery: active.filter(c => getDisplayStageIndex(c) === STAGES.length-2).length
  };
}

function renderStageChartHtml(){
  const counts = STAGES.map((s,i) => contracts.filter(c => getDisplayStageIndex(c) === i).length);
  const max = Math.max(1, ...counts);
  return `
    <div class="chart-box">
      <div class="chart-title">پراکندگی قراردادها بر اساس مرحله</div>
      ${STAGES.map((s,i) => `
        <div class="chart-row">
          <span class="chart-label">${s.name}</span>
          <div class="chart-bar-track"><div class="chart-bar-fill" style="width:${(counts[i]/max*100)}%"></div></div>
          <span class="chart-count">${counts[i]}</span>
        </div>`).join('')}
    </div>`;
}

function renderAdminDashboard(){
  const body = document.getElementById('adminBody');
  const stats = computeDashboardStats();
  const { totalAll, closedCount: closedLen, delayed, nearDue, notUpdated } = stats;
  const vs = computeViewerStats();

  body.innerHTML = `
    <div class="kpi-grid">
      <div class="kpi-card" style="cursor:pointer;" onclick="openAllList()"><div class="kpi-num">${totalAll}</div><div class="kpi-label">کل قراردادها</div></div>
      <div class="kpi-card" style="cursor:pointer;" onclick="openClosedList()"><div class="kpi-num">${closedLen}</div><div class="kpi-label">خاتمه‌ها</div></div>
      <div class="kpi-card kpi-red" style="cursor:pointer;" onclick="openDelayedList()"><div class="kpi-num">${delayed}</div><div class="kpi-label">عقب‌افتاده</div></div>
      <div class="kpi-card kpi-blue" style="cursor:pointer;" onclick="openNotUpdatedList()"><div class="kpi-num">${notUpdated}</div><div class="kpi-label">بروزرسانی نشده</div></div>
      <div class="kpi-card" style="cursor:pointer;" onclick="openWaitingDeliveryList()"><div class="kpi-num">${vs.waitingDeliveryList.length}</div><div class="kpi-label">در انتظار تحویل‌دهی به مالک</div></div>
    </div>
    ${renderStageChartHtml()}
    <div class="viewer-quicklinks" style="margin-top:20px;">
      <button class="${adminDashSection==='critical'?'active':''}" onclick="switchAdminDashSection('critical')">🔴 بحرانی ${vs.criticalList.length?('('+vs.criticalList.length+')'):''}</button>
      <button class="${adminDashSection==='waitingdelivery'?'active':''}" onclick="switchAdminDashSection('waitingdelivery')">📦 در انتظار تحویل‌دهی به مالک ${vs.waitingDeliveryList.length?('('+vs.waitingDeliveryList.length+')'):''}</button>
      <button class="${adminDashSection==='panelwait'?'active':''}" onclick="switchAdminDashSection('panelwait')">🛠 منتظر نصب صفحه کابینت ${vs.panelWaitList.length?('('+vs.panelWaitList.length+')'):''}</button>
    </div>
    <div id="adminDashSectionBody"></div>
  `;
  renderAdminDashSectionBody();
}
function switchAdminDashSection(sec){
  adminDashSection = (adminDashSection === sec) ? null : sec;
  adminDashSearch = '';
  renderApp();
}
function adminDashSectionContracts(){
  const vs = computeViewerStats();
  if(adminDashSection === 'critical') return vs.criticalList;
  if(adminDashSection === 'waitingdelivery') return vs.waitingDeliveryList;
  if(adminDashSection === 'panelwait') return vs.panelWaitList;
  return [];
}
function onAdminDashSearch(v){ adminDashSearch = v; renderAdminDashSectionList(); }
function renderAdminDashSectionBody(){
  const wrap = document.getElementById('adminDashSectionBody');
  if(!wrap) return;
  if(!adminDashSection){ wrap.innerHTML = ''; return; }
  const titles = { critical:'قراردادهای بحرانی', waitingdelivery:'در انتظار تحویل‌دهی به مالک', panelwait:'منتظر نصب صفحه کابینت' };
  wrap.innerHTML = `
    <div class="section-title" style="margin-top:16px;">${titles[adminDashSection]} <span class="cnt" id="adminDashCount"></span></div>
    <input type="text" id="adminDashSearchInput" placeholder="جستجو بر اساس نام یا کد قلم..." value="${escapeHtml(adminDashSearch)}" class="auth-input" style="max-width:none;width:100%;margin-bottom:10px;" oninput="onAdminDashSearch(this.value)">
    <div id="adminDashList"></div>`;
  renderAdminDashSectionList();
}
function renderAdminDashSectionList(){
  const el = document.getElementById('adminDashList');
  if(!el) return;
  let items = adminDashSectionContracts();
  const q = adminDashSearch.trim().toLowerCase();
  if(q) items = items.filter(c => (c.name||'').toLowerCase().includes(q) || (c.itemCode||'').toLowerCase().includes(q));
  const cnt = document.getElementById('adminDashCount');
  if(cnt) cnt.textContent = items.length + ' مورد';
  if(!items.length){ el.innerHTML = '<div class="empty">موردی یافت نشد.</div>'; return; }
  el.innerHTML = items.map(c => {
    const idx = getDisplayStageIndex(c);
    const pct = overallPercent(c);
    const vsC = viewerCriticalStatus(c);
    return `
      <div class="warn-item" style="cursor:pointer;" onclick="openContractDetail('${c.id}')">
        <div>
          <div class="warn-name">${escapeHtml(c.name)}</div>
          <div class="warn-sub">مرحله: ${STAGES[idx].name} — پیشرفت ${pct}٪</div>
        </div>
        <span class="warn-tag ${vsC.cls==='late'?'red':''}">${vsC.label}</span>
      </div>`;
  }).join('');
}
function openAllList(){
  adminTab = 'contracts';
  adminFilterStage = 'all';
  adminFilterStatus = 'all';
  renderApp();
}
function openClosedList(){
  adminTab = 'contracts';
  adminFilterStatus = 'closed';
  renderApp();
}
function openDelayedList(){
  adminTab = 'contracts';
  adminFilterStage = 'all';
  adminFilterStatus = 'late';
  renderApp();
}
function openNotUpdatedList(){
  adminTab = 'contracts';
  adminFilterStatus = 'stale';
  renderApp();
}
function openWaitingDeliveryList(){
  adminTab = 'contracts';
  adminFilterStage = 'all';
  adminFilterStatus = 'waiting';
  renderApp();
}


/* ---------- Admin-only: برنامه قراردادها ----------
   این بخش عمداً فقط داخل پنل مدیر است. از تاریخ قرارداد تا سررسید برنامه می‌سازد
   و وزن‌ها را مستقیماً از STAGE_WEIGHTS فعلی سیستم می‌گیرد؛ هیچ داده‌ای از contracts تغییر نمی‌کند. */
function gregorianToJalali(gy, gm, gd){
  const gdm = [0,31,28,31,30,31,30,31,31,30,31,30,31];
  const jdm = [0,31,31,31,31,31,30,30,30,30,30,30,29];
  let gy2 = gy - 1600, gm2 = gm - 1, gd2 = gd - 1;
  let gDayNo = 365*gy2 + Math.floor((gy2+3)/4) - Math.floor((gy2+99)/100) + Math.floor((gy2+399)/400);
  for(let i=0;i<gm2;i++) gDayNo += gdm[i+1];
  if(gm2 > 1 && ((gy%4===0 && gy%100!==0) || gy%400===0)) gDayNo++;
  gDayNo += gd2;
  let jDayNo = gDayNo - 79;
  let jNp = Math.floor(jDayNo/12053); jDayNo %= 12053;
  let jy = 979 + 33*jNp + 4*Math.floor(jDayNo/1461); jDayNo %= 1461;
  if(jDayNo >= 366){ jy += Math.floor((jDayNo-1)/365); jDayNo = (jDayNo-1)%365; }
  let jm=0;
  while(jm < 11 && jDayNo >= jdm[jm+1]){ jDayNo -= jdm[jm+1]; jm++; }
  return `${jy}/${String(jm+1).padStart(2,'0')}/${String(jDayNo+1).padStart(2,'0')}`;
}
function formatJalaliDate(d){
  return gregorianToJalali(d.getFullYear(), d.getMonth()+1, d.getDate());
}
function buildAdminPlan(c){
  if(!c || !c.contractDate || !c.dueDate) return null;
  const start = jalaliStrToDate(c.contractDate), end = jalaliStrToDate(c.dueDate);
  if(!start || !end || end < start) return null;
  const totalDays = daysBetween(start,end);
  const totalWeight = STAGE_WEIGHTS.reduce((a,b)=>a+b,0);
  let cursor = new Date(start);
  const rows=[];
  let cumulative = 0;
  STAGES.forEach((st,i)=>{
    const weight = Number(STAGE_WEIGHTS[i] || 0);
    const plannedStart = new Date(cursor);
    let plannedEnd = new Date(cursor);
    if(weight > 0){
      cumulative += weight;
      const targetOffset = Math.round(totalDays * cumulative / totalWeight);
      plannedEnd = new Date(start); plannedEnd.setDate(start.getDate() + targetOffset);
      if(plannedEnd > end) plannedEnd = new Date(end);
      cursor = new Date(plannedEnd);
    }
    rows.push({ stageIndex:i, name:st.name, weight, start:formatJalaliDate(plannedStart), end:formatJalaliDate(plannedEnd) });
  });
  rows[rows.length-1].end = c.dueDate;
  return { contractId:c.id, contractDate:c.contractDate, dueDate:c.dueDate, weights:STAGE_WEIGHTS.slice(), stages:rows, generatedAt:Date.now() };
}
function renderAdminPlans(){
  const body=document.getElementById('adminBody');
  if(!body) return;
  const activeId=adminPlanContractId || (contracts[0] && contracts[0].id) || '';
  adminPlanContractId=activeId;
  const c=contracts.find(x=>x.id===activeId);
  body.innerHTML=`
    <div class="section-title" style="margin-top:14px;">برنامه قراردادها</div>
    <div class="viewer-report-note">برنامه از تاریخ قرارداد تا تاریخ سررسید محاسبه می‌شود و وزن مراحل دقیقاً از درصددهی فعلی سیستم استفاده می‌کند.</div>
    <div class="export-filters">
      <div class="row1">
        <select id="adminPlanContract" class="admin-select" onchange="selectAdminPlanContract(this.value)">
          <option value="">انتخاب قرارداد...</option>
          ${contracts.map(x=>`<option value="${escapeHtml(x.id)}" ${x.id===activeId?'selected':''}>${escapeHtml(x.name)}${x.itemCode?' — '+escapeHtml(x.itemCode):''}</option>`).join('')}
        </select>
      </div>
    </div>
    <div id="adminPlanContent"></div>`;
  renderAdminPlanContent(c);
}
function selectAdminPlanContract(id){ adminPlanContractId=id; adminPlanData=null; renderAdminPlanContent(contracts.find(x=>x.id===id)); }
async function loadAdminPlan(){
  if(!db || !adminPlanContractId) return;
  try{
    const snap=await db.collection('contractPlans').doc(adminPlanContractId).get();
    adminPlanData=snap.exists ? snap.data() : null;
    renderAdminPlanContent(contracts.find(x=>x.id===adminPlanContractId));
  }catch(e){ alert('خطا در دریافت برنامه قرارداد.'); }
}
async function saveAdminPlan(){
  if(myRole!=='admin' || !db || !adminPlanContractId) return;
  const c=contracts.find(x=>x.id===adminPlanContractId);
  const plan=buildAdminPlan(c);
  if(!plan){ alert('برای این قرارداد، تاریخ قرارداد و تاریخ سررسید معتبر لازم است.'); return; }
  try{
    await db.collection('contractPlans').doc(c.id).set(plan);
    adminPlanData=plan;
    renderAdminPlanContent(c);
    logActivity('ثبت برنامه قرارداد', c.id, c.name, 'برنامه بر اساس تاریخ قرارداد، سررسید و وزن‌های درصددهی فعلی محاسبه شد.');
  }catch(e){ alert('خطا در ذخیره برنامه: '+(e.message||'دسترسی مجاز نیست')); }
}
function renderAdminPlanContent(c){
  const el=document.getElementById('adminPlanContent');
  if(!el) return;
  if(!c){ el.innerHTML='<div class="empty">قراردادی برای برنامه‌ریزی انتخاب نشده است.</div>'; return; }
  const plan=adminPlanData || buildAdminPlan(c);
  if(!plan){
    el.innerHTML=`<div class="empty">برای «${escapeHtml(c.name)}» تاریخ قرارداد یا تاریخ سررسید ثبت نشده/نامعتبر است. ابتدا تاریخ‌ها را در مدیریت قراردادها ثبت کنید.</div>`;
    return;
  }
  const totalDays=Math.max(0,daysBetween(jalaliStrToDate(c.contractDate),jalaliStrToDate(c.dueDate)));
  el.innerHTML=`
    <div class="kpi-grid" style="margin-top:14px;">
      <div class="kpi-card"><div class="kpi-num" style="font-size:17px;">${escapeHtml(c.contractDate)}</div><div class="kpi-label">تاریخ شروع برنامه</div></div>
      <div class="kpi-card"><div class="kpi-num" style="font-size:17px;">${escapeHtml(c.dueDate)}</div><div class="kpi-label">تاریخ پایان برنامه</div></div>
      <div class="kpi-card"><div class="kpi-num">${totalDays}</div><div class="kpi-label">روزهای برنامه</div></div>
    </div>
    <div class="chart-box" style="margin-top:14px;overflow:auto;">
      <div class="chart-title">برنامه زمانی مراحل</div>
      <div style="min-width:650px;">
        ${plan.stages.map((r,i)=>`
          <div class="chart-row" style="display:grid;grid-template-columns:190px 70px 120px 120px 1fr;gap:8px;align-items:center;">
            <span class="chart-label">${escapeHtml(r.name)}</span>
            <span class="chart-count">${r.weight}%</span>
            <span style="font-family:'JetBrains Mono',monospace;font-size:11px;">${escapeHtml(r.start)}</span>
            <span style="font-family:'JetBrains Mono',monospace;font-size:11px;">${escapeHtml(r.end)}</span>
            <div class="chart-bar-track"><div class="chart-bar-fill" style="width:${Math.min(100,Math.max(0,r.weight))}%"></div></div>
          </div>`).join('')}
      </div>
    </div>
    <div style="display:flex;gap:8px;margin-top:12px;">
      <button class="field-save" style="flex:1;" onclick="saveAdminPlan()">${adminPlanData?'به‌روزرسانی برنامه':'ذخیره برنامه'}</button>
      <button class="field-save" style="flex:1;background:var(--panel);" onclick="loadAdminPlan()">بارگذاری برنامه ذخیره‌شده</button>
    </div>
    <div class="viewer-report-note" style="margin-top:10px;">وزن‌ها قابل ویرایش نیستند و از درصددهی فعلی سیستم خوانده می‌شوند. هیچ تغییری در اطلاعات قرارداد ایجاد نمی‌شود.</div>`;
}

function renderAdminContracts(){
  const body = document.getElementById('adminBody');
  body.innerHTML = `
    <div class="section-title" style="margin-top:14px;">مدیریت قراردادها</div>
    <div class="export-filters">
      <div class="row1">
        <select id="exportScopeSelect" class="admin-select" onchange="onExportScopeChange(this.value)">
          <option value="all" ${exportScope==='all'?'selected':''}>همه قراردادها</option>
          <option value="active" ${exportScope==='active'?'selected':''}>فقط فعال (بدون خاتمه)</option>
          <option value="closed" ${exportScope==='closed'?'selected':''}>فقط خاتمه‌یافته</option>
          <option value="waiting" ${exportScope==='waiting'?'selected':''}>فقط در انتظار تحویل‌دهی</option>
        </select>
      </div>
      <div class="row2">
        <div class="date-field"><label>از تاریخ قرارداد:</label>
          <input type="text" id="exportFromInput" placeholder="1405/01/01" value="${escapeHtml(exportDateFrom)}" oninput="onExportDateFrom(this.value)"></div>
        <div class="date-field"><label>تا:</label>
          <input type="text" id="exportToInput" placeholder="1405/12/29" value="${escapeHtml(exportDateTo)}" oninput="onExportDateTo(this.value)"></div>
      </div>
    </div>
    <div class="export-row">
      <button class="export-btn" id="exportExcelBtn" onclick="exportExcel()">📊 خروجی اکسل</button>
      <button class="export-btn" id="exportPdfBtn" onclick="exportPDF()">📄 خروجی PDF</button>
    </div>
    <input type="text" id="adminSearch" placeholder="جستجو بر اساس نام یا کد قلم..." value="${escapeHtml(adminSearchQuery)}" class="auth-input" style="max-width:none; width:100%; margin-bottom:10px;" oninput="onAdminSearch(this.value)">
    <div style="display:flex; gap:8px; margin-bottom:14px;">
      <select id="stageFilter" class="admin-select" onchange="onStageFilter(this.value)">
        <option value="all">همه مراحل</option>
        ${STAGES.map((s,i) => `<option value="${i}" ${adminFilterStage===String(i)?'selected':''}>${s.name}</option>`).join('')}
      </select>
      <select id="statusFilter" class="admin-select" onchange="onStatusFilter(this.value)">
        <option value="all">همه وضعیت‌ها</option>
        <option value="late" ${adminFilterStatus==='late'?'selected':''}>عقب‌افتاده</option>
        <option value="near" ${adminFilterStatus==='near'?'selected':''}>نزدیک سررسید</option>
        <option value="waiting" ${adminFilterStatus==='waiting'?'selected':''}>در انتظار تحویل‌دهی به مالک</option>
        <option value="stale" ${adminFilterStatus==='stale'?'selected':''}>بروزرسانی نشده</option>
        <option value="closed" ${adminFilterStatus==='closed'?'selected':''}>خاتمه‌یافته</option>
      </select>
    </div>
    <div id="mgmtList"></div>
  `;
  renderMgmtList();
}
function onAdminSearch(v){ adminSearchQuery = v; renderMgmtList(); }
function onStageFilter(v){ adminFilterStage = v; renderMgmtList(); }
function onStatusFilter(v){ adminFilterStatus = v; renderMgmtList(); }
function onExportScopeChange(v){ exportScope = v; }
function onExportDateFrom(v){ exportDateFrom = v; }
function onExportDateTo(v){ exportDateTo = v; }

function getExportContracts(){
  let list = contracts.slice();
  if(exportScope === 'active') list = list.filter(c => !isCompleted(c));
  else if(exportScope === 'closed') list = list.filter(isCompleted);
  else if(exportScope === 'waiting') list = list.filter(c => !isCompleted(c) && getDisplayStageIndex(c) === STAGES.length-2);

  const fromStr = (exportDateFrom||'').trim();
  const toStr = (exportDateTo||'').trim();
  const fromD = fromStr ? jalaliStrToDate(fromStr) : null;
  const toD = toStr ? jalaliStrToDate(toStr) : null;
  // فقط وقتی واقعاً یک تاریخ معتبر وارد شده باشد فیلتر تاریخ اعمال می‌شود؛
  // اگر چیزی وارد نشده (یا نامعتبر بود)، این بخش کاملاً نادیده گرفته می‌شود.
  if(fromD || toD){
    list = list.filter(c => {
      if(!c.contractDate) return false;
      const d = jalaliStrToDate(c.contractDate);
      if(!d) return false;
      if(fromD && d < fromD) return false;
      if(toD && d > toD) return false;
      return true;
    });
  }
  return list;
}

/* ---------- خروجی اکسل و PDF ---------- */
function exportRows(){
  return getExportContracts().map(c => ({
    'نام قرارداد': c.name || '',
    'کد قلم': c.itemCode || '',
    'تاریخ قرارداد': c.contractDate || '—',
    'سررسید اصلی': c.dueDate || '—',
    'سررسید جبرانی': c.revisedDueDate || '—',
    'مرحله فعلی': STAGES[getDisplayStageIndex(c)].name,
    'درصد پیشرفت کل': overallPercent(c) + '%',
    'وضعیت زمانی': isCompleted(c) ? 'خاتمه‌یافته' : adminTimeStatus(c).label,
    'وضعیت': isCompleted(c) ? 'خاتمه‌یافته' : 'فعال'
  }));
}
function todayJalaliLabel(){
  const d = new Date();
  return d.toLocaleDateString('fa-IR') + ' ساعت ' + d.toLocaleTimeString('fa-IR', {hour:'2-digit', minute:'2-digit'});
}
// برای اسم فایل: تاریخ شمسی با رقم لاتین و بدون «/» (چون «/» توی اسم فایل مجاز نیست)
function todayJalaliFileLabel(){
  try{
    return new Date().toLocaleDateString('fa-IR-u-nu-latn').replace(/\//g, '-');
  }catch(e){
    return new Date().toISOString().slice(0,10);
  }
}
function reportFileName(ext){
  return `گزارش افراچوب - ${todayJalaliFileLabel()}.${ext}`;
}

function exportScopeLabel(){
  const map = { all:'همه قراردادها', active:'فقط فعال (بدون خاتمه)', closed:'فقط خاتمه‌یافته', waiting:'فقط در انتظار تحویل‌دهی' };
  let label = map[exportScope] || 'همه قراردادها';
  if(exportDateFrom || exportDateTo) label += ' — بازه‌ی تاریخ قرارداد: ' + (exportDateFrom||'ابتدا') + ' تا ' + (exportDateTo||'انتها');
  return label;
}

async function exportExcel(){
  if(getExportContracts().length === 0){
    alert('با این فیلترها هیچ قراردادی پیدا نشد. فیلترها را بررسی کنید.');
    return;
  }
  const btn = document.getElementById('exportExcelBtn');
  if(btn){ btn.disabled = true; btn.textContent = 'در حال ساخت...'; }
  try{
    const stats = computeDashboardStats();
    const summaryRows = [
      ['گزارش افراچوب — PMO', ''],
      ['تاریخ گزارش', todayJalaliLabel()],
      ['دامنه‌ی خروجی', exportScopeLabel()],
      [],
      ['کل قراردادها', stats.totalAll],
      ['خاتمه‌ها', stats.closedCount],
      ['عقب‌افتاده', stats.delayed],
      ['نزدیک سررسید', stats.nearDue],
      ['بروزرسانی نشده', stats.notUpdated],
      ['در انتظار تحویل‌دهی به مالک', stats.waitingDelivery]
    ];
    const wsSummary = XLSX.utils.aoa_to_sheet(summaryRows);
    wsSummary['!cols'] = [{wch:30},{wch:24}];

    const rows = exportRows();
    const wsList = XLSX.utils.json_to_sheet(rows);
    wsList['!cols'] = [{wch:22},{wch:14},{wch:14},{wch:14},{wch:14},{wch:22},{wch:14},{wch:20},{wch:14}];

    const wb = XLSX.utils.book_new();
    wb.Workbook = { Views: [{ RTL: true }] };
    XLSX.utils.book_append_sheet(wb, wsSummary, 'خلاصه');
    XLSX.utils.book_append_sheet(wb, wsList, 'قراردادها');
    XLSX.writeFile(wb, reportFileName('xlsx'));
  }catch(err){
    alert('خطا در ساخت فایل اکسل: ' + err.message);
  }finally{
    if(btn){ btn.disabled = false; btn.textContent = '📊 خروجی اکسل'; }
  }
}

/* ---------- V11: ساخت PDF چندصفحه‌ای با تیتر تکرارشونده در هر صفحه — بدون بریدن وسط ردیف جدول ----------
   قبلاً کل جدول یک عکس بود و برای صفحه‌ی بعد فقط جابجا می‌شد؛ همین باعث می‌شد
   ته صفحه‌ی اول وسط یک ردیف بریده بشه و صفحه‌های بعدی اصلاً تیتر/هدر نداشته باشن.
   الان هر صفحه جدا و دقیقاً بر اساس ارتفاع واقعی ردیف‌ها رندر و عکس‌برداری می‌شود. */
async function renderPaginatedReportPdf({ reportTitle, extraHeaderHtml, headers, rows, filename }){
  // اطمینان از لود کامل فونت فارسی قبل از عکس‌برداری (علت اصلی خراب دیده شدن فونت در PDF)
  try{
    await Promise.all([
      document.fonts.load('900 20px Vazirmatn'),
      document.fonts.load('800 13px Vazirmatn'),
      document.fonts.load('700 12px Vazirmatn'),
      document.fonts.load('500 11px Vazirmatn'),
      document.fonts.load('400 10.5px Vazirmatn')
    ].map(p => p.catch(()=>{})));
    await document.fonts.ready;
  }catch(e){}

  const { jsPDF } = window.jspdf;
  const pdf = new jsPDF('p', 'pt', 'a4');
  const pageW = pdf.internal.pageSize.getWidth();
  const pageH = pdf.internal.pageSize.getHeight();
  const MARGIN_TOP = 22, MARGIN_BOTTOM = 22;
  const availPt = pageH - MARGIN_TOP - MARGIN_BOTTOM;

  const bigHeaderHtml = `
    <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:2px solid #222; padding-bottom:12px; margin-bottom:8px;">
      <div style="font-size:20px; font-weight:900;">${escapeHtml(reportTitle)}</div>
      <div style="font-size:12px; color:#555;">${todayJalaliLabel()}</div>
    </div>
    <div style="font-size:11px; color:#666; margin-bottom:16px;">دامنه‌ی خروجی: ${escapeHtml(exportScopeLabel())}</div>
    ${extraHeaderHtml || ''}
  `;
  const smallHeaderHtml = (pageNo) => `
    <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:1.5px solid #222; padding-bottom:8px; margin-bottom:10px;">
      <div style="font-size:13px; font-weight:800;">${escapeHtml(reportTitle)} — ادامه</div>
      <div style="font-size:10px; color:#666;">صفحه ${pageNo}</div>
    </div>`;

  const theadHtml = `<thead><tr style="background:#222; color:#fff;">${headers.map(h=>`<th style="padding:6px 8px; text-align:right; border:1px solid #333;">${escapeHtml(h)}</th>`).join('')}</tr></thead>`;
  const rowHtml = (r) => `<tr style="background:${r.__i%2?'#f5f5f5':'#fff'};">${r.vals.map(v=>`<td style="padding:6px 8px; border:1px solid #ddd;">${escapeHtml(v==null?'':String(v))}</td>`).join('')}</tr>`;
  const dataRows = rows.map((vals,i) => ({ vals, __i:i }));

  const holder = document.createElement('div');
  holder.style.cssText = 'position:fixed; top:0; left:-99999px; width:820px; background:#ffffff; color:#1a1a1a; font-family:Vazirmatn,sans-serif; direction:rtl; padding:28px; box-sizing:border-box;';
  document.body.appendChild(holder);

  try{
    // اندازه‌گیری ارتفاع واقعی هدر بزرگ، هدر کوچک، سرستون جدول، و تک‌تک ردیف‌ها (بدون عکس‌برداری، فقط DOM)
    holder.innerHTML = bigHeaderHtml;
    const bigHeaderPx = holder.getBoundingClientRect().height;
    holder.innerHTML = smallHeaderHtml(2);
    const smallHeaderPx = holder.getBoundingClientRect().height;
    holder.innerHTML = `<table style="width:100%; border-collapse:collapse; font-size:10.5px;">${theadHtml}<tbody>${dataRows.map(rowHtml).join('')}</tbody></table>`;
    const table = holder.querySelector('table');
    const theadPx = table.querySelector('thead').getBoundingClientRect().height;
    const trEls = Array.from(table.querySelectorAll('tbody tr'));
    const rowHeightsPx = trEls.map(tr => tr.getBoundingClientRect().height);

    const cssWidth = holder.offsetWidth;
    const ptPerPx = pageW / cssWidth;
    const availPx = availPt / ptPerPx;

    // تقسیم ردیف‌ها به صفحات — بر اساس ارتفاع واقعی، بدون بریدن وسط ردیف
    const pages = [];
    let idx = 0, isFirst = true;
    while(idx < dataRows.length){
      const headPx = isFirst ? bigHeaderPx : smallHeaderPx;
      const budget = availPx - headPx - theadPx;
      let used = 0, count = 0;
      while(idx+count < dataRows.length){
        const h = rowHeightsPx[idx+count];
        if(count > 0 && used + h > budget) break;
        used += h; count++;
      }
      if(count === 0) count = 1;
      pages.push({ start: idx, count, isFirst });
      idx += count;
      isFirst = false;
    }
    if(!pages.length) pages.push({ start:0, count:0, isFirst:true });

    for(let p=0; p<pages.length; p++){
      const { start, count, isFirst: pf } = pages[p];
      const chunk = dataRows.slice(start, start+count);
      holder.innerHTML = `
        ${pf ? bigHeaderHtml : smallHeaderHtml(p+1)}
        <table style="width:100%; border-collapse:collapse; font-size:10.5px;">${theadHtml}<tbody>${chunk.map(rowHtml).join('')}</tbody></table>
      `;
      const canvas = await html2canvas(holder, { scale:2, backgroundColor:'#ffffff', useCORS:true });
      const imgData = canvas.toDataURL('image/jpeg', 0.92);
      const imgW = pageW;
      const imgH = canvas.height * (imgW / canvas.width);
      if(p > 0) pdf.addPage();
      pdf.addImage(imgData, 'JPEG', 0, MARGIN_TOP, imgW, imgH);
    }
    pdf.save(filename);
  } finally {
    document.body.removeChild(holder);
  }
}

/* ========================================================================
   V12: «خلاصه مدیریتی» — گزارش دو صفحه‌ای فشرده و بصری برای اشتراک‌گذاری با مدیران
   (نمای گانتی سرعت پیشرفت هر قرارداد نسبت به برنامه + لیست بحرانی‌ها +
   لیست جدای «در انتظار تحویل‌دهی به مالک» که هرگز بحرانی محسوب نمی‌شود)
   خروجی نهایی PDF است و در انتها با Web Share API پیشنهاد اشتراک‌گذاری
   (از جمله واتس‌اپ) به کاربر داده می‌شود. اگر مرورگر پشتیبانی نکند، فایل
   دانلود می‌شود تا کاربر خودش دستی ارسال کند. ========================== */
function truncateText(s, n){
  s = s || '';
  return s.length > n ? s.slice(0, n-1) + '…' : s;
}
// درصدی که «طبق برنامه‌ی زمانی» انتظار می‌رفت تا امروز پیش رفته باشیم (بر مبنای فاصله‌ی تاریخ ثبت تا سررسید)
function expectedPercent(c){
  if(!c.dueDate || !c.createdAt) return null;
  const due = jalaliStrToDate(c.revisedDueDate || c.dueDate);
  if(!due) return null;
  const start = new Date(c.createdAt);
  const totalDays = daysBetween(start, due);
  if(totalDays <= 0) return null;
  const elapsed = daysBetween(start, todayMid());
  return Math.max(0, Math.min(100, Math.round((elapsed/totalDays)*100)));
}
const MGMT_STATUS_COLOR = { late:'#dc2626', warn:'#d97706', ok:'#0f766e', waiting:'#2563eb' };
// وضعیت هر قرارداد برای گزارش مدیریتی: اولویت با عقب‌افتادگی سررسید، بعد نزدیک سررسید،
// بعد «در انتظار تحویل‌دهی» (که هرگز بحرانی حساب نمی‌شود)، در غیر این‌صورت عقب/جلوی برنامه بر مبنای سرعت پیشرفت
function mgmtRowStatus(c){
  const displayIdx = getDisplayStageIndex(c);
  if(displayIdx === STAGES.length-2) return { label:'در انتظار تحویل‌دهی به مالک', cls:'waiting' };
  const ts = adminTimeStatus(c);
  if(ts.cls === 'late') return { label:'بحرانی — ' + ts.label, cls:'late' };
  if(ts.cls === 'near') return { label:'نزدیک سررسید', cls:'warn' };
  const sch = scheduleText(c);
  if(sch.indexOf('عقب') === 0) return { label: sch, cls:'warn' };
  return { label: sch || 'مطابق برنامه', cls:'ok' };
}
function ganttRowHtml(c){
  const st = mgmtRowStatus(c);
  const color = MGMT_STATUS_COLOR[st.cls] || '#6b7280';
  const actual = overallPercent(c);
  const exp = expectedPercent(c);
  return `
    <div style="display:flex; align-items:center; gap:7px; margin-bottom:4px;">
      <div style="width:130px; font-size:9px; color:#222; flex-shrink:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${escapeHtml(truncateText(c.name||'—', 20))}</div>
      <div style="flex:1; position:relative; background:#eee; border-radius:4px; height:11px;">
        <div style="width:${actual}%; background:${color}; height:100%; border-radius:4px;"></div>
        ${exp!=null ? `<div style="position:absolute; top:-2px; bottom:-2px; left:${exp}%; width:2px; background:#111;"></div>` : ''}
      </div>
      <div style="width:28px; text-align:left; font-size:8.5px; color:#333; flex-shrink:0;">${actual}٪</div>
      <div style="width:112px; font-size:8px; color:${color}; font-weight:700; flex-shrink:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${escapeHtml(st.label)}</div>
    </div>`;
}
async function exportManagementSummaryPdf(){
  if(contracts.length === 0){ alert('هنوز قراردادی ثبت نشده است.'); return; }
  const btn = document.getElementById('mgmtSummaryBtn');
  if(btn){ btn.disabled = true; btn.textContent = 'در حال ساخت گزارش...'; }
  try{
    try{
      await Promise.all([
        document.fonts.load('900 20px Vazirmatn'),
        document.fonts.load('800 12px Vazirmatn'),
        document.fonts.load('700 10px Vazirmatn'),
        document.fonts.load('400 9px Vazirmatn')
      ].map(p => p.catch(()=>{})));
      await document.fonts.ready;
    }catch(e){}

    const active = contracts.filter(c => !isCompleted(c));
    const closedCount = contracts.length - active.length;
    const criticalList = active.filter(c => mgmtRowStatus(c).cls === 'late');
    const nearList = active.filter(c => mgmtRowStatus(c).cls === 'warn' && adminTimeStatus(c).cls === 'near');
    const waitingDeliveryList = active.filter(c => getDisplayStageIndex(c) === STAGES.length-2);
    const onScheduleCount = active.filter(c => mgmtRowStatus(c).cls === 'ok').length;
    const avgProgress = active.length ? Math.round(active.reduce((s,c)=>s+overallPercent(c),0)/active.length) : 0;

    // ترتیب گزارش گانتی: بحرانی‌ها اول، بعد نزدیک/عقب از برنامه، بعد مطابق برنامه، در انتها در انتظار تحویل
    const order = { late:0, warn:1, ok:2, waiting:3 };
    const ganttList = active.slice().sort((a,b) => order[mgmtRowStatus(a).cls]-order[mgmtRowStatus(b).cls]);
    const GANTT_CAP = 18;
    const ganttShown = ganttList.slice(0, GANTT_CAP);
    const ganttExtra = ganttList.length - ganttShown.length;

    const kpi = (label, val, color) => `<div style="border:1px solid #ddd; border-radius:8px; padding:9px 6px; text-align:center;">
        <div style="font-size:17px; font-weight:900; ${color?('color:'+color+';'):''}">${val}</div>
        <div style="font-size:9px; color:#666; margin-top:3px;">${label}</div>
      </div>`;

    const insight = `از ${active.length} قرارداد فعال، ${criticalList.length} مورد بحرانی (عقب‌افتاده از سررسید)، ${onScheduleCount} مورد مطابق یا جلوتر از برنامه، و ${waitingDeliveryList.length} مورد فقط در انتظار تحویل‌دهی به مالک هستند.`;

    const stageCounts = STAGES.map((s,i) => contracts.filter(c => getDisplayStageIndex(c) === i).length);
    const stageMax = Math.max(1, ...stageCounts);
    const stageChartHtml = STAGES.map((s,i) => `
      <div style="display:flex; align-items:center; gap:7px; margin-bottom:5px;">
        <div style="width:118px; font-size:8.5px; color:#333; flex-shrink:0;">${escapeHtml(s.name)}</div>
        <div style="flex:1; background:#eee; border-radius:4px; height:11px;"><div style="width:${(stageCounts[i]/stageMax*100)}%; background:#0f766e; height:100%; border-radius:4px;"></div></div>
        <div style="width:18px; text-align:left; font-size:8.5px; color:#333;">${stageCounts[i]}</div>
      </div>`).join('');

    // ---------------- صفحه‌ی اول: خلاصه‌ی وضعیت + نمای گانتی سرعت پیشرفت همه‌ی قراردادهای فعال ----------------
    const page1Html = `
      <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:2px solid #222; padding-bottom:10px; margin-bottom:10px;">
        <div style="font-size:19px; font-weight:900;">خلاصه مدیریتی — وضعیت قراردادها</div>
        <div style="font-size:11px; color:#555;">${todayJalaliLabel()}</div>
      </div>
      <div style="display:grid; grid-template-columns:repeat(5,1fr); gap:7px; margin-bottom:12px;">
        ${kpi('کل قراردادها', contracts.length)}
        ${kpi('بحرانی', criticalList.length, '#dc2626')}
        ${kpi('نزدیک سررسید', nearList.length, '#d97706')}
        ${kpi('در انتظار تحویل', waitingDeliveryList.length, '#2563eb')}
        ${kpi('میانگین پیشرفت', avgProgress+'٪')}
      </div>
      <div style="background:#f6f6f4; border:1px solid #e2e2de; border-radius:8px; padding:9px 12px; font-size:10.5px; color:#333; margin-bottom:14px; line-height:1.8;">📌 ${escapeHtml(insight)}</div>
      <div style="font-size:11.5px; font-weight:800; margin-bottom:8px;">پراکندگی قراردادها بر اساس مرحله</div>
      <div style="margin-bottom:16px;">${stageChartHtml}</div>
      <div style="font-size:11.5px; font-weight:800; margin-bottom:2px;">نمای کلی پیشرفت نسبت به برنامه‌ی زمانی (خط تیره = پیشرفت مورد انتظار طبق سررسید)</div>
      <div style="font-size:8.5px; color:#777; margin-bottom:8px;">مرتب‌شده بر اساس اولویت: بحرانی ← نزدیک/عقب از برنامه ← مطابق برنامه ← در انتظار تحویل‌دهی</div>
      <div>${ganttShown.map(ganttRowHtml).join('')}</div>
      ${ganttExtra > 0 ? `<div style="font-size:9px; color:#777; margin-top:6px;">+ ${ganttExtra} قرارداد دیگر (جزئیات کامل در خروجی PDF/اکسل اصلی)</div>` : ''}
    `;

    // ---------------- صفحه‌ی دوم: لیست بحرانی‌ها + لیست جدای «در انتظار تحویل‌دهی به مالک» ----------------
    const CRIT_CAP = 12, WAIT_CAP = 12;
    const critSorted = criticalList.slice().sort((a,b) => (dueStatus(a).daysLeft??0) - (dueStatus(b).daysLeft??0));
    const critShown = critSorted.slice(0, CRIT_CAP);
    const critExtra = critSorted.length - critShown.length;
    const waitShown = waitingDeliveryList.slice(0, WAIT_CAP);
    const waitExtra = waitingDeliveryList.length - waitShown.length;

    const critTableHtml = critShown.length ? `
      <table style="width:100%; border-collapse:collapse; font-size:9.5px; margin-bottom:6px;">
        <thead><tr style="background:#dc2626; color:#fff;">
          ${['نام قرارداد','کد قلم','پیشرفت','سررسید فعال','وضعیت'].map(h=>`<th style="padding:5px 7px; text-align:right; border:1px solid #b91c1c;">${h}</th>`).join('')}
        </tr></thead>
        <tbody>
          ${critShown.map((c,i) => `<tr style="background:${i%2?'#fef2f2':'#fff'};">
            <td style="padding:5px 7px; border:1px solid #f3d0d0;">${escapeHtml(c.name||'—')}</td>
            <td style="padding:5px 7px; border:1px solid #f3d0d0;">${escapeHtml(c.itemCode||'—')}</td>
            <td style="padding:5px 7px; border:1px solid #f3d0d0;">${overallPercent(c)}٪</td>
            <td style="padding:5px 7px; border:1px solid #f3d0d0;">${escapeHtml(c.revisedDueDate || c.dueDate || '—')}</td>
            <td style="padding:5px 7px; border:1px solid #f3d0d0; color:#dc2626; font-weight:700;">${escapeHtml(dueStatus(c).label)}</td>
          </tr>`).join('')}
        </tbody>
      </table>` : `<div style="font-size:10px; color:#0f766e; margin-bottom:10px;">✅ در حال حاضر هیچ قرارداد بحرانی‌ای وجود ندارد.</div>`;

    const waitTableHtml = waitShown.length ? `
      <table style="width:100%; border-collapse:collapse; font-size:9.5px; margin-bottom:6px;">
        <thead><tr style="background:#2563eb; color:#fff;">
          ${['نام قرارداد','کد قلم','پیشرفت'].map(h=>`<th style="padding:5px 7px; text-align:right; border:1px solid #1d4ed8;">${h}</th>`).join('')}
        </tr></thead>
        <tbody>
          ${waitShown.map((c,i) => `<tr style="background:${i%2?'#eff6ff':'#fff'};">
            <td style="padding:5px 7px; border:1px solid #cfe0fb;">${escapeHtml(c.name||'—')}</td>
            <td style="padding:5px 7px; border:1px solid #cfe0fb;">${escapeHtml(c.itemCode||'—')}</td>
            <td style="padding:5px 7px; border:1px solid #cfe0fb;">${overallPercent(c)}٪</td>
          </tr>`).join('')}
        </tbody>
      </table>` : `<div style="font-size:10px; color:#777; margin-bottom:10px;">موردی در این وضعیت نیست.</div>`;

    const page2Html = `
      <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:1.5px solid #222; padding-bottom:8px; margin-bottom:12px;">
        <div style="font-size:14px; font-weight:800;">خلاصه مدیریتی — جزئیات موارد نیازمند پیگیری</div>
        <div style="font-size:9.5px; color:#666;">صفحه ۲</div>
      </div>
      <div style="font-size:11.5px; font-weight:800; margin-bottom:8px; color:#dc2626;">🔴 قراردادهای بحرانی (عقب‌افتاده از سررسید) ${criticalList.length ? '— '+criticalList.length+' مورد' : ''}</div>
      ${critTableHtml}
      ${critExtra > 0 ? `<div style="font-size:9px; color:#777; margin-bottom:14px;">+ ${critExtra} مورد بحرانی دیگر</div>` : '<div style="margin-bottom:14px;"></div>'}
      <div style="font-size:11.5px; font-weight:800; margin-bottom:8px; color:#2563eb;">📦 در انتظار تحویل‌دهی به مالک ${waitingDeliveryList.length ? '— '+waitingDeliveryList.length+' مورد' : ''} <span style="font-size:8.5px; color:#777; font-weight:400;">(این‌ها بحرانی محسوب نمی‌شوند)</span></div>
      ${waitTableHtml}
      ${waitExtra > 0 ? `<div style="font-size:9px; color:#777;">+ ${waitExtra} مورد دیگر</div>` : ''}
      <div style="margin-top:24px; padding-top:10px; border-top:1px solid #ddd; font-size:8.5px; color:#999;">گزارش خودکار افراچوب — ${todayJalaliLabel()} — برای جزئیات کامل هر قرارداد از پنل «مدیریت قراردادها» استفاده کنید.</div>
    `;

    const holder = document.createElement('div');
    holder.style.cssText = 'position:fixed; top:0; left:-99999px; width:820px; background:#ffffff; color:#1a1a1a; font-family:Vazirmatn,sans-serif; direction:rtl; padding:26px; box-sizing:border-box;';
    document.body.appendChild(holder);
    let pdf;
    try{
      const { jsPDF } = window.jspdf;
      pdf = new jsPDF('p', 'pt', 'a4');
      const pageW = pdf.internal.pageSize.getWidth();
      holder.innerHTML = page1Html;
      const canvas1 = await html2canvas(holder, { scale:2, backgroundColor:'#ffffff', useCORS:true });
      pdf.addImage(canvas1.toDataURL('image/jpeg', 0.92), 'JPEG', 0, 18, pageW, canvas1.height*(pageW/canvas1.width));
      pdf.addPage();
      holder.innerHTML = page2Html;
      const canvas2 = await html2canvas(holder, { scale:2, backgroundColor:'#ffffff', useCORS:true });
      pdf.addImage(canvas2.toDataURL('image/jpeg', 0.92), 'JPEG', 0, 18, pageW, canvas2.height*(pageW/canvas2.width));
    } finally {
      document.body.removeChild(holder);
    }

    const filename = `خلاصه مدیریتی - ${todayJalaliFileLabel()}.pdf`;
    const blob = pdf.output('blob');

    // پیشنهاد اشتراک‌گذاری مستقیم (شامل واتس‌اپ) از طریق Web Share API؛ در صورت عدم پشتیبانی مرورگر، فایل دانلود می‌شود
    let shared = false;
    try{
      const file = new File([blob], filename, { type:'application/pdf' });
      if(navigator.canShare && navigator.canShare({ files:[file] })){
        await navigator.share({ files:[file], title:'خلاصه مدیریتی افراچوب', text:'خلاصه وضعیت قراردادها' });
        shared = true;
      }
    }catch(shareErr){
      // اگر کاربر خودش اشتراک‌گذاری را لغو کند، خطا می‌گیریم؛ در این حالت دیگر دانلود اجباری نکنیم
      if(shareErr && shareErr.name === 'AbortError') shared = true;
    }
    if(!shared){
      pdf.save(filename);
      alert('مرورگر شما امکان اشتراک‌گذاری مستقیم (واتس‌اپ و…) را ندارد؛ فایل PDF دانلود شد و می‌توانید خودتان از همان‌جا ارسال کنید.');
    }
  }catch(err){
    alert('خطا در ساخت گزارش: ' + err.message);
  }finally{
    if(btn){ btn.disabled = false; btn.textContent = '📱 خلاصه مدیریتی (اشتراک‌گذاری)'; }
  }
}

async function exportPDF(){
  if(getExportContracts().length === 0){
    alert('با این فیلترها هیچ قراردادی پیدا نشد. فیلترها را بررسی کنید.');
    return;
  }
  const btn = document.getElementById('exportPdfBtn');
  if(btn){ btn.disabled = true; btn.textContent = 'در حال ساخت...'; }
  try{
    const stats = computeDashboardStats();
    const rows = exportRows();
    const kpi = (label, val) => `<div style="border:1px solid #ddd; border-radius:8px; padding:12px; text-align:center;">
        <div style="font-size:20px; font-weight:900;">${val}</div>
        <div style="font-size:11px; color:#666; margin-top:4px;">${label}</div>
      </div>`;
    const extraHeaderHtml = `
      <div style="display:grid; grid-template-columns:repeat(3,1fr); gap:10px; margin-bottom:20px;">
        ${kpi('کل قراردادها', stats.totalAll)}
        ${kpi('خاتمه‌ها', stats.closedCount)}
        ${kpi('عقب‌افتاده', stats.delayed)}
        ${kpi('نزدیک سررسید', stats.nearDue)}
        ${kpi('بروزرسانی نشده', stats.notUpdated)}
        ${kpi('در انتظار تحویل به مالک', stats.waitingDelivery)}
      </div>`;
    const headers = ['نام قرارداد','کد قلم','تاریخ قرارداد','سررسید اصلی','سررسید جبرانی','مرحله فعلی','پیشرفت','وضعیت زمانی','وضعیت'];
    const tableRows = rows.map(r => [
      r['نام قرارداد'], r['کد قلم'], r['تاریخ قرارداد'], r['سررسید اصلی'], r['سررسید جبرانی'],
      r['مرحله فعلی'], r['درصد پیشرفت کل'], r['وضعیت زمانی'], r['وضعیت']
    ]);
    await renderPaginatedReportPdf({
      reportTitle: 'گزارش افراچوب — PMO',
      extraHeaderHtml,
      headers,
      rows: tableRows,
      filename: reportFileName('pdf')
    });
  }catch(err){
    alert('خطا در ساخت فایل PDF: ' + err.message);
  }finally{
    if(btn){ btn.disabled = false; btn.textContent = '📄 خروجی PDF'; }
  }
}

/* ---------- خروجی مخصوص مدیر پروژه — ستون‌های خلاصه‌تر (بدون جزئیات ریز مثل روز بروزرسانی) + نمودار ---------- */
function viewerExportRows(){
  return getExportContracts().map(c => ({
    'نام قرارداد': c.name || '',
    'کد قلم': c.itemCode || '',
    'تاریخ قرارداد': c.contractDate || '—',
    'سررسید اصلی': c.dueDate || '—',
    'سررسید جبرانی': c.revisedDueDate || '—',
    'مرحله فعلی': STAGES[getDisplayStageIndex(c)].name,
    'پیشرفت': overallPercent(c) + '%',
    'وضعیت': isCompleted(c) ? 'خاتمه‌یافته' : viewerCriticalStatus(c).label
  }));
}
function viewerChartRowsForPdf(){
  const counts = STAGES.map((s,i) => contracts.filter(c => getDisplayStageIndex(c) === i).length);
  const max = Math.max(1, ...counts);
  return STAGES.map((s,i) => `
    <div style="display:flex; align-items:center; gap:8px; margin-bottom:7px;">
      <div style="width:140px; font-size:10px; color:#333; flex-shrink:0;">${escapeHtml(s.name)}</div>
      <div style="flex:1; background:#eee; border-radius:4px; height:14px; overflow:hidden;">
        <div style="width:${(counts[i]/max*100)}%; background:#0f766e; height:100%;"></div>
      </div>
      <div style="width:22px; text-align:left; font-size:10px; color:#333;">${counts[i]}</div>
    </div>`).join('');
}
async function exportExcelViewer(){
  if(getExportContracts().length === 0){
    alert('با این فیلترها هیچ قراردادی پیدا نشد. فیلترها را بررسی کنید.');
    return;
  }
  const btn = document.getElementById('exportExcelBtn');
  if(btn){ btn.disabled = true; btn.textContent = 'در حال ساخت...'; }
  try{
    const s = computeViewerStats();
    const summaryRows = [
      ['گزارش افراچوب — مدیر پروژه', ''],
      ['تاریخ گزارش', todayJalaliLabel()],
      ['دامنه‌ی خروجی', exportScopeLabel()],
      [],
      ['کل قراردادها', contracts.length],
      ['خاتمه نیافته', s.active.length],
      ['خاتمه‌یافته', s.completed.length],
      ['بحرانی', s.criticalList.length],
      ['نزدیک سررسید', s.nearList.length],
      ['منتظر نصب صفحه کابینت', s.panelWaitList.length],
      ['در انتظار تحویل‌دهی به مالک', s.waitingDeliveryList.length],
      [],
      ['پراکندگی بر اساس مرحله', '']
    ];
    STAGES.forEach((st,i) => summaryRows.push([st.name, contracts.filter(c => getDisplayStageIndex(c)===i).length]));
    const wsSummary = XLSX.utils.aoa_to_sheet(summaryRows);
    wsSummary['!cols'] = [{wch:30},{wch:24}];

    const rows = viewerExportRows();
    const wsList = XLSX.utils.json_to_sheet(rows);
    wsList['!cols'] = [{wch:24},{wch:14},{wch:14},{wch:14},{wch:14},{wch:22},{wch:10},{wch:26}];

    const wb = XLSX.utils.book_new();
    wb.Workbook = { Views: [{ RTL: true }] };
    XLSX.utils.book_append_sheet(wb, wsSummary, 'خلاصه و پراکندگی مراحل');
    XLSX.utils.book_append_sheet(wb, wsList, 'قراردادها');
    XLSX.writeFile(wb, reportFileName('xlsx'));
  }catch(err){
    alert('خطا در ساخت فایل اکسل: ' + err.message);
  }finally{
    if(btn){ btn.disabled = false; btn.textContent = '📊 خروجی اکسل'; }
  }
}
async function exportPDFViewer(){
  if(getExportContracts().length === 0){
    alert('با این فیلترها هیچ قراردادی پیدا نشد. فیلترها را بررسی کنید.');
    return;
  }
  const btn = document.getElementById('exportPdfBtn');
  if(btn){ btn.disabled = true; btn.textContent = 'در حال ساخت...'; }
  try{
    const s = computeViewerStats();
    const rows = viewerExportRows();
    const kpi = (label, val) => `<div style="border:1px solid #ddd; border-radius:8px; padding:12px; text-align:center;">
        <div style="font-size:20px; font-weight:900;">${val}</div>
        <div style="font-size:11px; color:#666; margin-top:4px;">${label}</div>
      </div>`;
    const extraHeaderHtml = `
      <div style="display:grid; grid-template-columns:repeat(3,1fr); gap:10px; margin-bottom:20px;">
        ${kpi('کل قراردادها', contracts.length)}
        ${kpi('خاتمه نیافته', s.active.length)}
        ${kpi('خاتمه‌یافته', s.completed.length)}
        ${kpi('بحرانی', s.criticalList.length)}
        ${kpi('نزدیک سررسید', s.nearList.length)}
        ${kpi('منتظر نصب صفحه', s.panelWaitList.length)}
      </div>
      <div style="font-size:13px; font-weight:800; margin-bottom:10px;">پراکندگی قراردادها بر اساس مرحله</div>
      <div style="margin-bottom:22px;">${viewerChartRowsForPdf()}</div>`;
    const headers = ['نام قرارداد','کد قلم','تاریخ قرارداد','سررسید اصلی','سررسید جبرانی','مرحله فعلی','پیشرفت','وضعیت'];
    const tableRows = rows.map(r => [
      r['نام قرارداد'], r['کد قلم'], r['تاریخ قرارداد'], r['سررسید اصلی'], r['سررسید جبرانی'],
      r['مرحله فعلی'], r['پیشرفت'], r['وضعیت']
    ]);
    await renderPaginatedReportPdf({
      reportTitle: 'گزارش افراچوب — مدیر پروژه',
      extraHeaderHtml,
      headers,
      rows: tableRows,
      filename: reportFileName('pdf')
    });
  }catch(err){
    alert('خطا در ساخت فایل PDF: ' + err.message);
  }finally{
    if(btn){ btn.disabled = false; btn.textContent = '📄 خروجی PDF (شامل نمودار)'; }
  }
}

function renderMgmtList(){
  const el = document.getElementById('mgmtList');
  if(!el) return;
  let items = contracts.slice();
  const q = adminSearchQuery.trim().toLowerCase();
  if(q) items = items.filter(c => (c.name||'').toLowerCase().includes(q) || (c.itemCode||'').toLowerCase().includes(q));
  if(adminFilterStage !== 'all') items = items.filter(c => getDisplayStageIndex(c) === parseInt(adminFilterStage,10));
  if(adminFilterStatus === 'closed'){
    items = items.filter(isCompleted);
  } else if(adminFilterStatus === 'waiting'){
    items = items.filter(c => !isCompleted(c) && getDisplayStageIndex(c) === STAGES.length-2);
  } else if(adminFilterStatus !== 'all'){
    items = items.filter(c => !isCompleted(c) && (adminFilterStatus === 'stale' ? isNotUpdated(c) : adminTimeStatus(c).cls === adminFilterStatus));
  }
  if(!items.length){ el.innerHTML = '<div class="empty">موردی یافت نشد.</div>'; return; }
  items.sort((a,b) => { const ac = isCompleted(a), bc = isCompleted(b); return ac===bc ? 0 : (ac?1:-1); });
  el.innerHTML = items.map(c => {
    const idx = getDisplayStageIndex(c);
    const pct = overallPercent(c);
    const done = isCompleted(c);
    const ts = adminTimeStatus(c);
    const dueTagCls = ts.cls==='ontime' ? 'ok' : (ts.cls==='near' ? 'warn' : (ts.cls==='late' ? 'late' : 'none'));
    return `
      <div class="card" style="cursor:pointer;" onclick="openContractDetail('${c.id}')">
        <div class="card-head">
          <div class="card-title">
            <span class="card-name">${escapeHtml(c.name)}</span>
            <span class="card-sub">مرحله: ${STAGES[idx].name}${c.itemCode ? ' — کد قلم: '+escapeHtml(c.itemCode) : ''}</span>
          </div>
          <span class="stage-pill" style="${done?'background:var(--green-dim);color:var(--green);':''}">${done?'خاتمه‌یافته':pct+'٪'}</span>
        </div>
        <div class="progress-strip"><div style="width:${pct}%; ${done?'background:var(--green);':''}"></div></div>
        ${done ? '' : `<div class="due-row"><span class="due-tag ${dueTagCls}">${ts.label}</span></div>`}
      </div>`;
  }).join('');
}

let openContractModalId = null;
let openContractModalIsAdmin = true;
function openContractDetail(id, isAdmin){
  if(isAdmin === undefined) isAdmin = true;
  const c = contracts.find(x => x.id === id);
  if(!c) return;
  openContractModalId = id;
  openContractModalIsAdmin = isAdmin;
  document.getElementById('contractModalBody').innerHTML = renderCard(c, isAdmin, true);
  document.getElementById('contractModalBg').classList.add('open');
}
function refreshContractModal(){
  if(!openContractModalId) return;
  const bg = document.getElementById('contractModalBg');
  if(!bg || !bg.classList.contains('open')) return;
  const c = contracts.find(x => x.id === openContractModalId);
  if(!c){ closeModal('contractModalBg'); return; }
  document.getElementById('contractModalBody').innerHTML = renderCard(c, openContractModalIsAdmin, true);
}

function openNotifications(){
  const alerts = adminAlerts();
  document.getElementById('notifModalBody').innerHTML = !alerts.length
    ? '<div class="empty">هشداری وجود ندارد.</div>'
    : alerts.map(a => `
        <div class="warn-item ${a.type==='near'?'soon':''}">
          <div><div class="warn-name">${escapeHtml(a.c.name)}</div><div class="warn-sub">${a.label}</div></div>
          <button class="field-save" onclick="closeModal('notifModalBg'); openContractDetail('${a.c.id}')">مشاهده</button>
        </div>`).join('');
  document.getElementById('notifModalBg').classList.add('open');
}

function onLogDateFrom(v){ logDateFrom = v; }
function onLogDateTo(v){ logDateTo = v; }
function applyLogDateFilter(){ renderAdminLog(); }
function clearLogDateFilter(){ logDateFrom = ''; logDateTo = ''; renderAdminLog(); }

function renderAdminLog(){
  const body = document.getElementById('adminBody');
  if(!body) return;
  let rows = activityLog;
  const fromD = logDateFrom ? jalaliStrToDate(logDateFrom) : null;
  const toD = logDateTo ? jalaliStrToDate(logDateTo) : null;
  if(fromD) rows = rows.filter(r => new Date(r.time) >= fromD);
  if(toD){ const end = new Date(toD); end.setHours(23,59,59,999); rows = rows.filter(r => new Date(r.time) <= end); }

  body.innerHTML = `
    <div class="section-title" style="margin-top:14px;">لاگ فعالیت‌ها <span class="cnt">${rows.length} مورد</span></div>
    <div class="export-filters">
      <div class="row2">
        <div class="date-field"><label>از تاریخ:</label>
          <input type="text" id="logFromInput" placeholder="1405/06/01" value="${escapeHtml(logDateFrom)}" oninput="onLogDateFrom(this.value)"></div>
        <div class="date-field"><label>تا تاریخ:</label>
          <input type="text" id="logToInput" placeholder="1405/06/30" value="${escapeHtml(logDateTo)}" oninput="onLogDateTo(this.value)"></div>
      </div>
      <div class="row2" style="margin-top:8px;">
        <button class="field-save" style="flex:1;" onclick="applyLogDateFilter()">اعمال فیلتر</button>
        <button class="field-save" style="flex:1; background:var(--panel);" onclick="clearLogDateFilter()">پاک‌کردن فیلتر</button>
      </div>
    </div>
    <div id="logList">
      ${rows.length ? rows.map(r => `
        <div class="log-item">
          <div class="log-top">
            <span class="log-action">${escapeHtml(r.action||'')}</span>
            <span class="log-time">${fmtTime(new Date(r.time).toISOString())}</span>
          </div>
          <div class="log-meta">
            ${r.contractName ? 'قرارداد: '+escapeHtml(r.contractName)+' — ' : ''}${authorLabel(r)}
            ${r.details ? '<br>'+escapeHtml(r.details) : ''}
          </div>
        </div>`).join('') : '<div class="empty">موردی یافت نشد.</div>'}
    </div>
  `;
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
    } else if(u.role === 'supervisor' || u.role === 'viewer' || u.role === 'afrachoobSupervisor'){
      actions = `<button class="btn-revoke" onclick="setUserRole('${u.id}','pending')">لغو دسترسی</button>
                 <button class="btn-block" onclick="setUserRole('${u.id}','blocked')">مسدود کن</button>`;
    } else if(u.role === 'blocked'){
      actions = `<button class="btn-approve" onclick="openApproveModal('${u.id}','${escapeHtml(u.name||'')}')">فعال‌سازی مجدد</button>
                 <button class="btn-delete" onclick="deleteUser('${u.id}')">حذف کامل</button>`;
    } else if(u.role === 'admin' && !isSelf){
      actions = `<button class="btn-revoke" onclick="setUserRole('${u.id}','pending')">حذف دسترسی مدیر</button>`;
    }
    const nameLine = u.name ? escapeHtml(u.name) : '';
    const roleColorLine = u.position ? escapeHtml(u.position) : roleFa(u.role);
    const resetBtn = `<button class="btn-secondary" style="font-size:10.5px; padding:6px 10px;" onclick="sendPasswordReset('${escapeHtml(u.email)}')">🔑 ایمیل بازیابی رمز</button>`;
    const online = isUserOnline(u);
    const statusLine = `<div class="user-status ${online?'online':''}"><span class="stat-dot"></span>${online ? 'آنلاین' : escapeHtml(fmtLastSeen(u.lastSeen))}</div>`;
    return `
      <div class="user-row">
        <div class="user-info">
          <div class="user-email">${escapeHtml(u.email)}${isSelf?' (شما)':''}</div>
          ${nameLine ? `<div class="user-role" style="color:var(--ink-soft);">${nameLine}</div>` : ''}
          <div class="user-role ${u.role}">${roleColorLine}</div>
          ${statusLine}
        </div>
        <div class="user-actions">${actions}${resetBtn}</div>
      </div>`;
  }).join('') + '</div>';
}

async function sendPasswordReset(email){
  if(!auth || !email) return;
  if(!confirm('ایمیل بازیابی رمز عبور برای «' + email + '» ارسال شود؟')) return;
  try{
    await auth.sendPasswordResetEmail(email);
    alert('ایمیل بازیابی رمز برای ' + email + ' ارسال شد.');
    logActivity('ارسال ایمیل بازیابی رمز', null, null, email);
  }catch(err){
    alert('خطا در ارسال ایمیل بازیابی: ' + mapAuthError(err));
  }
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
  document.getElementById('approveRole').value = 'supervisor';
  document.getElementById('approveModalBg').classList.add('open');
}
async function confirmApprove(){
  if(!approveTargetUid || !db) return;
  const name = document.getElementById('approveName').value.trim();
  const position = document.getElementById('approvePosition').value.trim();
  const role = document.getElementById('approveRole').value;
  await db.collection('users').doc(approveTargetUid).update({
    role, name, position, approvedAt: Date.now()
  });
  closeModal('approveModalBg');
  approveTargetUid = null;
}

function rangeFillCss(val, max){
  const v = Math.max(0, Math.min(Number(val)||0, Number(max)||100));
  const m = Number(max)||100;
  const pct = m > 0 ? (v / m * 100) : 0;
  return `linear-gradient(to right, var(--teal) 0%, var(--teal) ${pct}%, var(--line) ${pct}%, var(--line) 100%)`;
}

/* ---------- Contract list & card ---------- */
function renderList(isAdmin, predicate){
  const list = document.getElementById('list');
  if(!list) return;
  const items = predicate ? contracts.filter(predicate) : contracts;
  if(items.length === 0){
    list.innerHTML = '<div class="empty">موردی برای نمایش نیست.</div>';
    return;
  }
  list.innerHTML = items.map(c => renderSupervisorRow(c)).join('');
}

function renderSupervisorRow(c){
  const displayIdx = getDisplayStageIndex(c);
  const pct = overallPercent(c);
  const done = isCompleted(c);
  const due = dueStatus(c);
  const badges = (c.itemCode ? `<span class="mini-badge">کد قلم: ${escapeHtml(c.itemCode)}</span>` : '')
    + (myRole !== 'afrachoobSupervisor' && myRole !== 'supervisor' && (c.comments||[]).length ? `<span class="mini-badge">💬 ${c.comments.length}</span>` : '');
  return `
    <div class="card" style="cursor:pointer;" onclick="openContractDetail('${c.id}', false)">
      <div class="card-head">
        <div class="card-title">
          <span class="card-name">${escapeHtml(c.name)}</span>
          <span class="card-sub">مرحله: ${STAGES[displayIdx].name}</span>
          <div class="card-badges">${badges}</div>
        </div>
        <span class="stage-pill" style="${done?'background:var(--green-dim);color:var(--green);':''}">${done?'خاتمه‌یافته':pct+'٪'}</span>
      </div>
      <div class="progress-strip"><div style="width:${pct}%; ${done?'background:var(--green);':''}"></div></div>
      ${done ? '' : `<div class="due-row"><span class="due-tag ${due.cls}">${due.label}</span></div>`}
    </div>`;
}

function renderCard(c, isAdmin, forceOpen){
  const status = c.status || {};
  const curIdx = getCurrentIndex(c);
  const displayIdx = getDisplayStageIndex(c);
  const pct = overallPercent(c);
  const done = isCompleted(c);
  const isOpen = forceOpen || (openCardId === c.id);
  const due = dueStatus(c);
  const sched = scheduleText(c);

  const badges = [];
  if(c.itemCode) badges.push('<span class="mini-badge">کد قلم: ' + escapeHtml(c.itemCode) + '</span>');
  if(myRole !== 'afrachoobSupervisor' && myRole !== 'supervisor' && (c.comments||[]).length) badges.push('<span class="mini-badge">💬 ' + c.comments.length + '</span>');

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
          <button class="chk-btn ${panelInstalled?'done':''}" style="width:100%;margin-top:10px;" onclick="event.stopPropagation(); togglePanelInstalled('${c.id}', ${i})">
            ${panelInstalled ? '✓ نصب صفحه کابینت انجام شد' : 'نصب صفحه کابینت'}
          </button>
          ${!panelInstalled ? '<div class="admin-only-note">تا نصب نشدن این مرحله، پیشرفت حداکثر ۸۰٪ ثبت می‌شود.</div>' : ''}
        ` : '';
      const dateFieldHtml = isAdmin ? `
          <div class="prog-date">
            <label>پیش‌بینی پایان (شمسی):</label>
            <input type="text" id="date_${c.id}_${i}" placeholder="1405/06/04" value="${escapeHtml(pd)}">
          </div>` : '';
      progBox = `
        <div class="prog-box">
          <div class="prog-row">
            <input type="range" min="0" max="${maxAllowed}" value="${Math.min(pv,maxAllowed)}" id="range_${c.id}_${i}"
              style="background:${rangeFillCss(Math.min(pv,maxAllowed), maxAllowed)}"
              oninput="document.getElementById('val_${c.id}_${i}').textContent = this.value + '%'; this.style.background = rangeFillCss(this.value, ${maxAllowed});">
            <span class="prog-val" id="val_${c.id}_${i}">${Math.min(pv,maxAllowed)}%</span>
          </div>
          <div class="prog-strip-mini"><div style="width:${Math.min(pv,maxAllowed)}%"></div></div>
          ${panelBtnHtml}
          ${dateFieldHtml}
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
    `<div class="hist-item"><span>${escapeHtml(h.label)}</span><span class="hist-time">${fmtTime(h.time)}${h.by ? ' — '+authorLabel(h) : ''}</span></div>`
  ).join('') || '<div class="hist-item"><span>—</span></div>';
  // V10: تاریخچه برای سرپرست نصب و سرپرست افراچوب اصلاً نمایش داده نمی‌شود (فقط مدیر می‌بیند)
  const showHistory = (myRole !== 'supervisor' && myRole !== 'afrachoobSupervisor');
  // V10: سرپرست افراچوب اجازه‌ی کامنت‌گذاری/دیدن کامنت‌های قرارداد را ندارد
  const showComments = (myRole !== 'afrachoobSupervisor' && myRole !== 'supervisor');

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

  // V11: پنل سرپرست نصب — سررسید جبرانی فقط وقتی از قبل ثبت شده باشد نمایش داده می‌شود (فقط‌خواندنی)، وگرنه اصلاً نشان داده نمی‌شود
  const revDueFieldHtml = (myRole === 'supervisor')
    ? (c.revisedDueDate ? `
    <div class="field-row">
      <label>سررسید جبرانی:</label>
      <span style="font-family:'JetBrains Mono',monospace; color:var(--ink-soft);">${escapeHtml(c.revisedDueDate)}</span>
    </div>` : '')
    : `
    <div class="field-row">
      <label>سررسید جبرانی:</label>
      <input type="text" id="revdue_${c.id}" placeholder="1405/06/20" value="${escapeHtml(c.revisedDueDate||'')}">
      <button class="field-save" onclick="saveRevisedDueDate('${c.id}')">ثبت</button>
    </div>`;

  const nameFieldHtml = isAdmin ? `
    <div class="field-row text">
      <label>نام قرارداد:</label>
      <input type="text" id="name_${c.id}" placeholder="نام مشتری / کد قرارداد" value="${escapeHtml(c.name||'')}">
      <button class="field-save" onclick="saveName('${c.id}')">ثبت</button>
    </div>` : '';

  const itemCodeFieldHtml = isAdmin ? `
    <div class="field-row text">
      <label>کد قلم:</label>
      <input type="text" id="item_${c.id}" placeholder="مثلاً K-104" value="${escapeHtml(c.itemCode||'')}">
      <button class="field-save" onclick="saveItemCode('${c.id}')">ثبت</button>
    </div>` : '';

  const contractDateFieldHtml = isAdmin ? `
    <div class="field-row">
      <label>تاریخ قرارداد:</label>
      <input type="text" id="cdate_${c.id}" placeholder="1405/06/04" value="${escapeHtml(c.contractDate||'')}">
      <button class="field-save" onclick="saveContractDate('${c.id}')">ثبت</button>
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
          <span class="card-sub">مرحله فعلی: ${STAGES[displayIdx].name}</span>
          <div class="card-badges">${badges.join('')}</div>
        </div>
        <span class="stage-pill" style="${done?'background:var(--green-dim);color:var(--green);':''}">${done?'خاتمه‌یافته':pct+'٪'}</span>
      </div>
      <div class="progress-strip"><div style="width:${pct}%; ${done?'background:var(--green);':''}"></div></div>
      ${done ? '' : `
      <div class="due-row">
        <span class="due-tag ${due.cls}">${due.label}</span>
        ${sched ? `<span class="schedule-tag">${sched}</span>` : ''}
      </div>`}
      <div class="body-panel ${isOpen ? 'open' : ''}">
        ${nameFieldHtml}
        ${dueFieldHtml}
        ${revDueFieldHtml}
        ${itemCodeFieldHtml}
        ${contractDateFieldHtml}
        ${descFieldHtml}
        <div class="timeline">${timelineHtml}</div>
        ${showHistory ? `
        <div class="hist-title" style="cursor:pointer; display:flex; justify-content:space-between; align-items:center;">
          <span onclick="event.stopPropagation(); toggleHistory('${c.id}')">تاریخچه ${hOpen ? '▲' : '▼'}</span>
          ${isAdmin ? `<button onclick="event.stopPropagation(); clearHistory('${c.id}')" style="border:none;background:none;color:var(--red);font-size:10.5px;cursor:pointer;font-family:'Vazirmatn';text-decoration:underline;">پاک‌کردن تاریخچه</button>` : ''}
        </div>
        ${hOpen ? histHtml : ''}` : ''}
        ${showComments ? renderCommentsHtml(c, isAdmin ? 'a' : 's') : ''}
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
  const label = STAGES[idx].name + ' — ' + (nowDone?'انجام شد':'لغو شد');
  const history = (c.history || []).concat([historyEntry(label)]);
  await db.collection('contracts').doc(id).update({ status, history });
  logActivity('تغییر مرحله', id, c.name, label);
}

async function togglePanelInstalled(id, idx){
  if(!db) return;
  const c = contracts.find(x => x.id === id);
  if(!c) return;
  const status = c.status || {};
  const cur = status[idx] || {};
  const now = !cur.panelInstalled;
  let percent = cur.percent || 0;
  if(now){
    percent = 100; // نصب صفحه کابینت که زده شد، پیشرفت خودکار می‌رود روی ۱۰۰٪
  } else if(percent > 80){
    percent = 80;
  }
  status[idx] = { ...cur, panelInstalled: now, percent, doneAt: now ? new Date().toISOString() : null };
  const label = STAGES[idx].name + ' — نصب صفحه کابینت ' + (now?'انجام شد':'لغو شد');
  const history = (c.history || []).concat([historyEntry(label)]);
  await db.collection('contracts').doc(id).update({ status, history });
  logActivity('نصب صفحه کابینت', id, c.name, label);
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
  const dateEl = document.getElementById(`date_${id}_${idx}`);
  const predictedDate = dateEl ? dateEl.value.trim() : (cur.predictedDate || '');
  const status = c.status || {};
  status[idx] = { ...cur, percent, predictedDate, updatedAt: new Date().toISOString(),
                   doneAt: (percent>=100 && (!st.requiresPanel || panelInstalled)) ? new Date().toISOString() : null };
  const label = STAGES[idx].name + ' — پیشرفت ' + percent + '٪' + (predictedDate?' — پیش‌بینی: '+predictedDate:'');
  const history = (c.history || []).concat([historyEntry(label)]);
  await db.collection('contracts').doc(id).update({ status, history });
  logActivity('ثبت پیشرفت', id, c.name, label);
}

async function saveDueDate(id){
  if(!db) return;
  const val = document.getElementById(`due_${id}`).value.trim();
  if(val && !parseJalaliStr(val)){ alert('فرمت تاریخ درست نیست. مثال: 1405/06/04'); return; }
  const c = contracts.find(x => x.id === id);
  const history = (c.history||[]).concat([historyEntry('سررسید ثبت شد: '+val)]);
  await db.collection('contracts').doc(id).update({ dueDate: val, history });
  logActivity('ویرایش سررسید', id, c && c.name, 'سررسید: '+val);
}
async function saveRevisedDueDate(id){
  if(!db) return;
  const val = document.getElementById(`revdue_${id}`).value.trim();
  if(val && !parseJalaliStr(val)){ alert('فرمت تاریخ درست نیست. مثال: 1405/06/20'); return; }
  const c = contracts.find(x => x.id === id);
  const history = (c.history||[]).concat([historyEntry('سررسید جبرانی ثبت شد: '+val)]);
  await db.collection('contracts').doc(id).update({ revisedDueDate: val, history });
  logActivity('ویرایش سررسید جبرانی', id, c && c.name, 'سررسید جبرانی: '+val);
}
async function saveItemCode(id){
  if(!db) return;
  const val = document.getElementById(`item_${id}`).value.trim();
  const c = contracts.find(x => x.id === id);
  const history = (c.history||[]).concat([historyEntry('کد قلم ثبت شد: '+val)]);
  await db.collection('contracts').doc(id).update({ itemCode: val, history });
  logActivity('ویرایش کد قلم', id, c && c.name, 'کد قلم: '+val);
}
async function saveName(id){
  if(!db) return;
  const val = document.getElementById(`name_${id}`).value.trim();
  if(!val){ alert('نام قرارداد نمی‌تواند خالی باشد.'); return; }
  const c = contracts.find(x => x.id === id);
  const history = (c.history||[]).concat([historyEntry('نام قرارداد ویرایش شد: '+val)]);
  await db.collection('contracts').doc(id).update({ name: val, history });
  logActivity('ویرایش نام قرارداد', id, val, '');
}
async function saveContractDate(id){
  if(!db) return;
  const val = document.getElementById(`cdate_${id}`).value.trim();
  if(val && !parseJalaliStr(val)){ alert('فرمت تاریخ درست نیست. مثال: 1405/06/04'); return; }
  const c = contracts.find(x => x.id === id);
  const history = (c.history||[]).concat([historyEntry('تاریخ قرارداد ثبت شد: '+val)]);
  await db.collection('contracts').doc(id).update({ contractDate: val, history });
  logActivity('ویرایش تاریخ قرارداد', id, c && c.name, 'تاریخ قرارداد: '+val);
}
async function saveDescription(id){
  if(!db) return;
  const val = document.getElementById(`desc_${id}`).value.trim();
  const c = contracts.find(x => x.id === id);
  const history = (c.history||[]).concat([historyEntry('توضیحات ثبت شد')]);
  await db.collection('contracts').doc(id).update({ description: val, history });
  logActivity('ویرایش توضیحات', id, c && c.name, val);
}
async function deleteContract(id){
  if(!db) return;
  if(!confirm('این قرارداد حذف شود؟')) return;
  const c = contracts.find(x => x.id === id);
  await db.collection('contracts').doc(id).delete();
  logActivity('حذف قرارداد', id, c && c.name, '');
}
async function clearHistory(id){
  if(!db) return;
  if(!confirm('کل تاریخچه‌ی این قرارداد پاک شود؟ این کار قابل بازگشت نیست.')) return;
  const c = contracts.find(x => x.id === id);
  await db.collection('contracts').doc(id).update({ history: [historyEntry('تاریخچه توسط مدیر پاک شد')] });
  logActivity('پاک‌کردن تاریخچه', id, c && c.name, '');
}

function openAddModal(){
  document.getElementById('newName').value = '';
  document.getElementById('newItemCode').value = '';
  document.getElementById('newContractDate').value = '';
  document.getElementById('newDueDate').value = '';
  document.getElementById('addModalBg').classList.add('open');
}
function closeModal(id){
  document.getElementById(id).classList.remove('open');
  if(id === 'contractModalBg') openContractModalId = null;
}
async function addContract(){
  if(!db) return;
  const name = document.getElementById('newName').value.trim();
  const itemCode = document.getElementById('newItemCode').value.trim();
  const contractDate = document.getElementById('newContractDate').value.trim();
  const dueDate = document.getElementById('newDueDate').value.trim();
  if(!name) return;
  if(contractDate && !parseJalaliStr(contractDate)){ alert('فرمت تاریخ قرارداد درست نیست. مثال: 1405/06/04'); return; }
  if(dueDate && !parseJalaliStr(dueDate)){ alert('فرمت سررسید درست نیست. مثال: 1405/06/04'); return; }
  const ref = await db.collection('contracts').add({
    name, itemCode: itemCode || '', contractDate: contractDate || '', dueDate: dueDate || '',
    status: {},
    history: [historyEntry('قرارداد ثبت شد')],
    createdAt: Date.now()
  });
  logActivity('ثبت قرارداد جدید', ref.id, name, '');
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
    navigator.serviceWorker.register('./service-worker.js').then((reg) => {
      // هر بار اپ دوباره جلوی چشم کاربر بیاید (باز شدن مجدد تب/برنامه)،
      // خودش چک می‌کند نسخه‌ی جدیدتری هست یا نه — بدون نیاز به خروج/ورود دوباره.
      document.addEventListener('visibilitychange', () => {
        if(document.visibilityState === 'visible') reg.update().catch(() => {});
      });
    }).catch(() => {});
  });
}

/* ---------- Splash safety fallback + theme icon sync ---------- */
setTimeout(hideSplash, 6000);
(function(){
  const btn = document.getElementById('themeToggleBtn');
  if(btn) btn.textContent = document.documentElement.getAttribute('data-theme') === 'light' ? '☀️' : '🌙';
})();

initAuthAndData();
