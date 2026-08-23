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
let adminTab = 'dashboard';   // 'dashboard' | 'contracts' | 'users' | 'log'
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
let activityLog = [];
let exportScope = 'all';   // 'all' | 'active' | 'closed' | 'waiting'
let exportDateFrom = '';
let exportDateTo = '';
let logDateFrom = '';
let logDateTo = '';
let splashHidden = false;

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
    details: details || '', by: currentUser.email || '', byUid: currentUser.uid,
    time: Date.now()
  }).catch(() => { /* لاگ فقط جنبه‌ی گزارشیه؛ خطای احتمالی نباید کار اصلی رو مختل کنه */ });
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
function adminAlerts(){
  const list = [];
  contracts.filter(c => !isCompleted(c)).forEach(c => {
    const ts = adminTimeStatus(c);
    if(ts.cls === 'late') list.push({ type:'late', c, label:'عقب‌افتاده — ' + ts.label });
    else if(ts.cls === 'near') list.push({ type:'near', c, label:'نزدیک سررسید — ' + ts.label });
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
  if(myRole !== 'admin' && myRole !== 'supervisor' && myRole !== 'viewer') return;
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

  el.innerHTML = `<div class="center-screen">
    <span class="sync-note"><span class="dot" id="statusDot"></span><span id="syncNote">در حال بارگذاری…</span></span>
    ${authErrorMsg ? `<p style="color:var(--red); font-family:'JetBrains Mono',monospace; font-size:11px; direction:ltr; max-width:320px;">${escapeHtml(authErrorMsg)}</p>` : ''}
    <button class="signout-btn" onclick="signOutUser()">خروج و تلاش دوباره</button>
  </div>`;
}

function roleFa(r){
  return { admin:'مدیر', supervisor:'سرپرست نصب', viewer:'مدیر پروژه', pending:'در انتظار تایید', blocked:'مسدود' }[r] || r;
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
    <div class="toolbar"><button id="installBtn" class="btn-secondary" onclick="installApp()">نصب اپلیکیشن روی گوشی</button></div>
    <div class="tabs">
      <button class="${supervisorTab==='contracts'?'active':''}" onclick="switchSupervisorTab('contracts')">قراردادها</button>
      <button class="${supervisorTab==='warnings'?'active':''}" onclick="switchSupervisorTab('warnings')">هشدار سررسید</button>
      <button class="${supervisorTab==='closed'?'active':''}" onclick="switchSupervisorTab('closed')">خاتمه‌ها ${closedCount?('('+closedCount+')'):''}</button>
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

/* ---------- Viewer role — "مدیر پروژه": read-only report panel, fully separate from admin/supervisor ---------- */
function renderViewer(el){
  const active = contracts.filter(c => !isCompleted(c));
  const completed = contracts.filter(isCompleted);
  const avgProgress = active.length ? Math.round(active.reduce((s,c) => s+overallPercent(c), 0) / active.length) : 0;
  const late = active.filter(c => adminTimeStatus(c).cls === 'late').length;
  const near = active.filter(c => adminTimeStatus(c).cls === 'near').length;
  el.innerHTML = `
    <div class="toolbar"><button id="installBtn" class="btn-secondary" onclick="installApp()">نصب اپلیکیشن روی گوشی</button></div>
    <div class="kpi-grid" style="margin-top:14px;">
      <div class="kpi-card"><div class="kpi-num">${contracts.length}</div><div class="kpi-label">کل قراردادها</div></div>
      <div class="kpi-card"><div class="kpi-num">${active.length}</div><div class="kpi-label">فعال</div></div>
      <div class="kpi-card"><div class="kpi-num">${completed.length}</div><div class="kpi-label">خاتمه‌یافته</div></div>
      <div class="kpi-card kpi-red"><div class="kpi-num">${late}</div><div class="kpi-label">عقب‌افتاده</div></div>
      <div class="kpi-card kpi-amber"><div class="kpi-num">${near}</div><div class="kpi-label">نزدیک سررسید</div></div>
      <div class="kpi-card"><div class="kpi-num">${avgProgress}٪</div><div class="kpi-label">میانگین پیشرفت</div></div>
    </div>
    <div class="section-title" style="margin-top:20px;">وضعیت قراردادها <span class="cnt" id="viewerCount"></span></div>
    <input type="text" id="viewerSearch" placeholder="جستجو بر اساس نام یا کد قلم..." value="${escapeHtml(viewerSearchQuery)}" class="auth-input" style="max-width:none;width:100%;margin-bottom:10px;" oninput="onViewerSearch(this.value)">
    <div id="viewerList"></div>
    <div class="sync-note"><span class="dot" id="statusDot"></span><span id="syncNote">همگام — لحظه‌ای</span></div>
  `;
  const installBtn = document.getElementById('installBtn');
  if(installBtn) installBtn.style.display = window.__deferredPrompt ? 'block' : 'none';
  renderViewerList();
}
function onViewerSearch(v){ viewerSearchQuery = v; renderViewerList(); }
function renderViewerList(){
  const el = document.getElementById('viewerList');
  if(!el) return;
  const q = viewerSearchQuery.trim().toLowerCase();
  let items = contracts;
  if(q) items = items.filter(c => (c.name||'').toLowerCase().includes(q) || (c.itemCode||'').toLowerCase().includes(q));
  items = items.slice().sort((a,b) => { const ac = isCompleted(a), bc = isCompleted(b); return ac===bc ? 0 : (ac?1:-1); });
  const cntEl = document.getElementById('viewerCount');
  if(cntEl) cntEl.textContent = items.length + ' مورد';
  if(!items.length){ el.innerHTML = '<div class="empty">موردی یافت نشد.</div>'; return; }
  el.innerHTML = items.map(c => renderViewerCard(c)).join('');
}
function renderViewerCard(c){
  const curIdx = getCurrentIndex(c);
  const displayIdx = getDisplayStageIndex(c);
  const pct = overallPercent(c);
  const done = isCompleted(c);
  const ts = adminTimeStatus(c);
  const isOpen = viewerOpenId === c.id;
  const dueTagCls = done ? 'ok' : (ts.cls==='ontime'?'ok':ts.cls==='near'?'warn':ts.cls==='late'?'late':'none');
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
    `<div class="hist-item"><span>${escapeHtml(h.label)}</span><span class="hist-time">${fmtTime(h.time)}${h.by?' — '+escapeHtml(h.by.split('@')[0]):''}</span></div>`
  ).join('') || '<div class="hist-item"><span>—</span></div>';

  return `
    <div class="card">
      <div class="card-head" style="cursor:pointer;" onclick="toggleViewerCard('${c.id}')">
        <div class="card-title">
          <span class="card-name">${escapeHtml(c.name)}</span>
          <span class="card-sub">مرحله: ${STAGES[displayIdx].name}${c.itemCode?' — کد قلم: '+escapeHtml(c.itemCode):''}</span>
        </div>
        <span class="stage-pill" style="${done?'background:var(--green-dim);color:var(--green);':''}">${done?'خاتمه‌یافته':pct+'٪'}</span>
      </div>
      <div class="progress-strip"><div style="width:${pct}%; ${done?'background:var(--green);':''}"></div></div>
      ${done ? '' : `<div class="due-row"><span class="due-tag ${dueTagCls}">${ts.label}</span></div>`}
      <div class="body-panel ${isOpen?'open':''}">
        ${c.description ? `<div class="field-row text"><label>توضیحات:</label><span style="flex:1; font-size:12.5px;">${escapeHtml(c.description)}</span></div>` : ''}
        <div class="timeline">${timelineHtml}</div>
        <div class="hist-title">تاریخچه</div>
        ${histHtml}
      </div>
    </div>`;
}
function toggleViewerCard(id){ viewerOpenId = viewerOpenId===id ? null : id; renderViewerList(); }

/* ---------- Admin view (V9 — Professional Dashboard) ---------- */
function renderAdmin(el){
  const pendingCount = usersList.filter(u => u.role === 'pending').length;
  const alertCount = adminAlerts().length;
  el.innerHTML = `
    <div class="toolbar">
      <button class="btn-primary" onclick="openAddModal()">+ قرارداد جدید</button>
      <button class="btn-secondary" onclick="openNotifications()">🔔 هشدارها ${alertCount ? '('+alertCount+')' : ''}</button>
    </div>
    <div class="toolbar"><button id="installBtn" class="btn-secondary" onclick="installApp()">نصب اپلیکیشن روی گوشی</button></div>
    <div class="tabs">
      <button class="${adminTab==='dashboard'?'active':''}" onclick="switchAdminTab('dashboard')">داشبورد</button>
      <button class="${adminTab==='contracts'?'active':''}" onclick="switchAdminTab('contracts')">مدیریت قراردادها</button>
      <button class="${adminTab==='users'?'active':''}" onclick="switchAdminTab('users')">کاربران ${pendingCount?('('+pendingCount+')'):''}</button>
    </div>
    <div class="tabs" style="margin-top:8px;">
      <button class="${adminTab==='log'?'active':''}" onclick="switchAdminTab('log')">لاگ سیستم</button>
    </div>
    <div id="adminBody"></div>
    <div class="sync-note"><span class="dot" id="statusDot"></span><span id="syncNote">همگام — لحظه‌ای</span></div>
  `;
  document.getElementById('installBtn').style.display = window.__deferredPrompt ? 'block' : 'none';
  if(adminTab === 'dashboard') renderAdminDashboard();
  else if(adminTab === 'contracts') renderAdminContracts();
  else if(adminTab === 'log') renderAdminLog();
  else renderAdminUsers();
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
  const { totalAll, closedCount: closedLen, delayed, nearDue, notUpdated, waitingDelivery } = stats;
  const alerts = adminAlerts();
  const needAction = new Set(alerts.map(a => a.c.id)).size;

  body.innerHTML = `
    <div class="kpi-grid">
      <div class="kpi-card"><div class="kpi-num">${totalAll}</div><div class="kpi-label">کل قراردادها</div></div>
      <div class="kpi-card" style="cursor:pointer;" onclick="openClosedList()"><div class="kpi-num">${closedLen}</div><div class="kpi-label">خاتمه‌ها</div></div>
      <div class="kpi-card kpi-red"><div class="kpi-num">${delayed}</div><div class="kpi-label">عقب‌افتاده</div></div>
      <div class="kpi-card kpi-amber"><div class="kpi-num">${nearDue}</div><div class="kpi-label">نزدیک سررسید</div></div>
      <div class="kpi-card kpi-blue" style="cursor:pointer;" onclick="openNotUpdatedList()"><div class="kpi-num">${notUpdated}</div><div class="kpi-label">بروزرسانی نشده</div></div>
      <div class="kpi-card"><div class="kpi-num">${waitingDelivery}</div><div class="kpi-label">در انتظار تحویل‌دهی به مالک</div></div>
    </div>
    ${renderStageChartHtml()}
    <div class="section-title" style="margin-top:20px;">نیازمند اقدام <span class="cnt">${needAction} مورد</span></div>
    <div id="actionList"></div>
  `;
  const actionList = document.getElementById('actionList');
  if(!alerts.length){
    actionList.innerHTML = '<div class="empty">موردی نیازمند اقدام فوری نیست.</div>';
    return;
  }
  actionList.innerHTML = alerts.map(a => {
    const idx = getDisplayStageIndex(a.c);
    const pct = overallPercent(a.c);
    const tagColor = a.type === 'late' ? 'red' : (a.type === 'near' ? 'amber' : '');
    return `
      <div class="warn-item ${a.type==='near'?'soon':''}" style="cursor:pointer;" onclick="openContractDetail('${a.c.id}')">
        <div>
          <div class="warn-name">${escapeHtml(a.c.name)}</div>
          <div class="warn-sub">مرحله: ${STAGES[idx].name} — پیشرفت ${pct}٪</div>
        </div>
        <span class="warn-tag ${tagColor}" style="${a.type==='stale' ? 'background:var(--teal-dim);color:var(--teal);' : ''}">${a.label}</span>
      </div>`;
  }).join('');
}
function openClosedList(){
  adminTab = 'contracts';
  adminFilterStatus = 'closed';
  renderApp();
}
function openNotUpdatedList(){
  adminTab = 'contracts';
  adminFilterStatus = 'stale';
  renderApp();
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
    'مرحله فعلی': STAGES[getDisplayStageIndex(c)].name,
    'درصد پیشرفت کل': overallPercent(c) + '%',
    'سررسید اصلی': c.dueDate || '—',
    'سررسید جبرانی': c.revisedDueDate || '—',
    'وضعیت زمانی': isCompleted(c) ? 'خاتمه‌یافته' : adminTimeStatus(c).label,
    'روز از آخرین آپدیت': daysSinceUpdate(c),
    'وضعیت': isCompleted(c) ? 'خاتمه‌یافته' : 'فعال'
  }));
}
function todayJalaliLabel(){
  const d = new Date();
  return d.toLocaleDateString('fa-IR') + ' ساعت ' + d.toLocaleTimeString('fa-IR', {hour:'2-digit', minute:'2-digit'});
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
    wsList['!cols'] = [{wch:22},{wch:14},{wch:14},{wch:22},{wch:14},{wch:14},{wch:14},{wch:20},{wch:16},{wch:14}];

    const wb = XLSX.utils.book_new();
    wb.Workbook = { Views: [{ RTL: true }] };
    XLSX.utils.book_append_sheet(wb, wsSummary, 'خلاصه');
    XLSX.utils.book_append_sheet(wb, wsList, 'قراردادها');
    XLSX.writeFile(wb, `افراچوب-گزارش-${new Date().toISOString().slice(0,10)}.xlsx`);
  }catch(err){
    alert('خطا در ساخت فایل اکسل: ' + err.message);
  }finally{
    if(btn){ btn.disabled = false; btn.textContent = '📊 خروجی اکسل'; }
  }
}

async function exportPDF(){
  if(getExportContracts().length === 0){
    alert('با این فیلترها هیچ قراردادی پیدا نشد. فیلترها را بررسی کنید.');
    return;
  }
  const btn = document.getElementById('exportPdfBtn');
  if(btn){ btn.disabled = true; btn.textContent = 'در حال ساخت...'; }
  const holder = document.createElement('div');
  holder.style.cssText = 'position:fixed; top:0; left:-99999px; width:820px; background:#ffffff; color:#1a1a1a; font-family:Vazirmatn,sans-serif; direction:rtl; padding:28px;';
  const stats = computeDashboardStats();
  const rows = exportRows();
  const kpi = (label, val) => `<div style="border:1px solid #ddd; border-radius:8px; padding:12px; text-align:center;">
      <div style="font-size:20px; font-weight:900;">${val}</div>
      <div style="font-size:11px; color:#666; margin-top:4px;">${label}</div>
    </div>`;
  holder.innerHTML = `
    <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:2px solid #222; padding-bottom:12px; margin-bottom:8px;">
      <div style="font-size:20px; font-weight:900;">گزارش افراچوب — PMO</div>
      <div style="font-size:12px; color:#555;">${todayJalaliLabel()}</div>
    </div>
    <div style="font-size:11px; color:#666; margin-bottom:16px;">دامنه‌ی خروجی: ${escapeHtml(exportScopeLabel())}</div>
    <div style="display:grid; grid-template-columns:repeat(3,1fr); gap:10px; margin-bottom:20px;">
      ${kpi('کل قراردادها', stats.totalAll)}
      ${kpi('خاتمه‌ها', stats.closedCount)}
      ${kpi('عقب‌افتاده', stats.delayed)}
      ${kpi('نزدیک سررسید', stats.nearDue)}
      ${kpi('بروزرسانی نشده', stats.notUpdated)}
      ${kpi('در انتظار تحویل به مالک', stats.waitingDelivery)}
    </div>
    <table style="width:100%; border-collapse:collapse; font-size:10.5px;">
      <thead>
        <tr style="background:#222; color:#fff;">
          ${['نام قرارداد','کد قلم','تاریخ قرارداد','مرحله فعلی','پیشرفت','سررسید','وضعیت زمانی','روز بدون آپدیت','وضعیت'].map(h=>`<th style="padding:6px 8px; text-align:right; border:1px solid #333;">${h}</th>`).join('')}
        </tr>
      </thead>
      <tbody>
        ${rows.map((r,i) => `<tr style="background:${i%2?'#f5f5f5':'#fff'};">
          <td style="padding:6px 8px; border:1px solid #ddd;">${escapeHtml(r['نام قرارداد'])}</td>
          <td style="padding:6px 8px; border:1px solid #ddd;">${escapeHtml(r['کد قلم'])}</td>
          <td style="padding:6px 8px; border:1px solid #ddd;">${escapeHtml(r['تاریخ قرارداد'])}</td>
          <td style="padding:6px 8px; border:1px solid #ddd;">${escapeHtml(r['مرحله فعلی'])}</td>
          <td style="padding:6px 8px; border:1px solid #ddd;">${r['درصد پیشرفت کل']}</td>
          <td style="padding:6px 8px; border:1px solid #ddd;">${escapeHtml(r['سررسید اصلی'])}</td>
          <td style="padding:6px 8px; border:1px solid #ddd;">${escapeHtml(r['وضعیت زمانی'])}</td>
          <td style="padding:6px 8px; border:1px solid #ddd;">${r['روز از آخرین آپدیت']}</td>
          <td style="padding:6px 8px; border:1px solid #ddd;">${escapeHtml(r['وضعیت'])}</td>
        </tr>`).join('')}
      </tbody>
    </table>
  `;
  document.body.appendChild(holder);
  try{
    const canvas = await html2canvas(holder, { scale:2, backgroundColor:'#ffffff', useCORS:true });
    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF('p', 'pt', 'a4');
    const pageW = pdf.internal.pageSize.getWidth();
    const pageH = pdf.internal.pageSize.getHeight();
    const imgW = pageW;
    const imgH = canvas.height * (imgW / canvas.width);
    let remaining = imgH, position = 0, first = true;
    const imgData = canvas.toDataURL('image/jpeg', 0.92);
    while(remaining > 0){
      if(!first) pdf.addPage();
      pdf.addImage(imgData, 'JPEG', 0, position, imgW, imgH);
      remaining -= pageH;
      position -= pageH;
      first = false;
    }
    pdf.save(`افراچوب-گزارش-${new Date().toISOString().slice(0,10)}.pdf`);
  }catch(err){
    alert('خطا در ساخت فایل PDF: ' + err.message);
  }finally{
    document.body.removeChild(holder);
    if(btn){ btn.disabled = false; btn.textContent = '📄 خروجی PDF'; }
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
            ${r.contractName ? 'قرارداد: '+escapeHtml(r.contractName)+' — ' : ''}${escapeHtml((r.by||'').split('@')[0])}
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
    } else if(u.role === 'supervisor'){
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
  const badges = c.itemCode ? `<span class="mini-badge">کد قلم: ${escapeHtml(c.itemCode)}</span>` : '';
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
        ${dueFieldHtml}
        ${revDueFieldHtml}
        ${itemCodeFieldHtml}
        ${contractDateFieldHtml}
        ${descFieldHtml}
        <div class="timeline">${timelineHtml}</div>
        <div class="hist-title" style="cursor:pointer; display:flex; justify-content:space-between; align-items:center;">
          <span onclick="event.stopPropagation(); toggleHistory('${c.id}')">تاریخچه ${hOpen ? '▲' : '▼'}</span>
          ${isAdmin ? `<button onclick="event.stopPropagation(); clearHistory('${c.id}')" style="border:none;background:none;color:var(--red);font-size:10.5px;cursor:pointer;font-family:'Vazirmatn';text-decoration:underline;">پاک‌کردن تاریخچه</button>` : ''}
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
  if(!name) return;
  if(contractDate && !parseJalaliStr(contractDate)){ alert('فرمت تاریخ قرارداد درست نیست. مثال: 1405/06/04'); return; }
  const ref = await db.collection('contracts').add({
    name, itemCode: itemCode || '', contractDate: contractDate || '',
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
