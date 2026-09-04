/* ===== راسپینا — کنترل پروژه ساختمان — منطق اصلی اپ (فاز ۱ و ۲) ===== */

firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.firestore();

let currentUser = null;   // آبجکت کاربر Firebase Auth
let myProfile = null;     // سند users/{uid}
let loginBusy = false;

let myProjects = [];               // پروژه‌های قابل‌مشاهده برای کاربر جاری
let projectsUnsub = null;          // لغو listener لیست پروژه‌ها (ادمین)
let currentProject = null;         // پروژه‌ی باز‌شده در صفحه‌ی جزئیات
let currentBlocks = [];            // بلوک‌های پروژه‌ی جاری، هرکدام با floors پر شده

const appEl = document.getElementById('app');
const headerRight = document.getElementById('headerRight');
const headerSub = document.getElementById('headerSub');
const statusDot = document.getElementById('statusDot');
const syncNote = document.getElementById('syncNote');

function hideSplash() {
  const s = document.getElementById('splashScreen');
  if (s) s.classList.add('hide');
}

function setStatus(online) {
  if (!statusDot || !syncNote) return;
  statusDot.classList.toggle('off', !online);
  syncNote.textContent = online ? 'متصل' : 'قطع ارتباط';
}

function escapeHtml(str) {
  return String(str || '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

/* ================= ورود ================= */

function renderLogin(errorMsg) {
  headerRight.innerHTML = '';
  headerSub.textContent = 'راسپینا';
  appEl.innerHTML = `
    <div class="center-screen">
      <img src="./icon-192.png" alt="راسپینا">
      <h2>ورود به سامانه</h2>
      <p>نام کاربری و رمز عبور خود را وارد کنید.</p>
      <input id="loginUsername" class="auth-input" placeholder="نام کاربری" autocomplete="username">
      <input id="loginPassword" class="auth-input" type="password" placeholder="رمز عبور" autocomplete="current-password">
      ${errorMsg ? `<div class="auth-error">${escapeHtml(errorMsg)}</div>` : ''}
      <button id="loginBtn" class="auth-btn">ورود</button>
    </div>
  `;
  document.getElementById('loginBtn').addEventListener('click', doLogin);
  document.getElementById('loginPassword').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doLogin();
  });
}

async function doLogin() {
  if (loginBusy) return;
  const username = (document.getElementById('loginUsername').value || '').trim();
  const password = document.getElementById('loginPassword').value || '';

  if (!username || !password) {
    renderLogin('نام کاربری و رمز عبور را وارد کنید.');
    return;
  }

  loginBusy = true;
  const btn = document.getElementById('loginBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'در حال بررسی…'; }

  try {
    const usernameDoc = await db.collection('usernames').doc(username).get();
    if (!usernameDoc.exists) {
      throw { code: 'custom/username-not-found' };
    }
    const email = usernameDoc.data().email;
    await auth.signInWithEmailAndPassword(email, password);
  } catch (err) {
    loginBusy = false;
    renderLogin(loginErrorMessage(err));
  }
}

function loginErrorMessage(err) {
  const code = err && err.code;
  if (code === 'custom/username-not-found') return 'نام کاربری یافت نشد.';
  if (code === 'auth/wrong-password' || code === 'auth/invalid-credential') return 'رمز عبور اشتباه است.';
  if (code === 'auth/too-many-requests') return 'تعداد تلاش‌ها زیاد بوده، کمی صبر کنید.';
  if (code === 'auth/network-request-failed') return 'مشکل در اتصال اینترنت.';
  return 'ورود ناموفق بود، دوباره تلاش کنید.';
}

function doLogout() {
  if (projectsUnsub) { projectsUnsub(); projectsUnsub = null; }
  currentProject = null;
  auth.signOut();
}

/* ================= صفحه‌ی غیرفعال ================= */

function renderBlocked() {
  headerSub.textContent = myProfile && myProfile.username ? myProfile.username : '';
  headerRight.innerHTML = `<button class="signout-btn" onclick="doLogout()">خروج</button>`;
  appEl.innerHTML = `
    <div class="center-screen">
      <img src="./icon-192.png" alt="راسپینا">
      <h2>دسترسی فعال نیست</h2>
      <p>حساب کاربری شما در حال حاضر غیرفعال است. با مدیر سیستم تماس بگیرید.</p>
    </div>
  `;
}

/* ================= لیست پروژه‌ها ================= */

function startProjectsListener() {
  if (projectsUnsub) projectsUnsub();

  if (myProfile.roleId === 'admin') {
    projectsUnsub = db.collection('projects')
      .orderBy('createdAt', 'desc')
      .onSnapshot((snap) => {
        myProjects = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        if (!currentProject) renderProjectList();
      }, (err) => {
        console.error(err);
        appEl.innerHTML = `<div class="center-screen"><p class="auth-error">خطا در دریافت پروژه‌ها.</p></div>`;
      });
  } else {
    loadProjectsForUser();
  }
}

// برای جلوگیری از نیاز به Index، پروژه‌های تخصیص‌داده‌شده را یکی‌یکی می‌خوانیم
// (به‌جای یک کوئری ترکیبی whereIn + where).
async function loadProjectsForUser() {
  const ids = myProfile.assignedProjectIds || [];
  if (ids.length === 0) {
    myProjects = [];
    renderProjectList();
    return;
  }
  const docs = await Promise.all(ids.map((id) => db.collection('projects').doc(id).get()));
  myProjects = docs
    .filter((d) => d.exists && d.data().active !== false)
    .map((d) => ({ id: d.id, ...d.data() }));
  renderProjectList();
}

function renderProjectList() {
  currentProject = null;
  const isAdmin = myProfile.roleId === 'admin';

  headerSub.textContent = myProfile.username || '';
  headerRight.innerHTML = `
    ${isAdmin ? '<span class="role-badge">مدیر</span>' : ''}
    <button class="signout-btn" onclick="doLogout()">خروج</button>
  `;

  let listHtml;
  if (myProjects.length === 0) {
    listHtml = `
      <div class="card flat" style="text-align:center; color:var(--ink-soft); font-size:13px; line-height:1.9;">
        هیچ پروژه‌ای برای شما تعریف نشده است.${isAdmin ? '' : '<br>با مدیر سیستم تماس بگیرید.'}
      </div>
    `;
  } else {
    listHtml = myProjects.map((p) => `
      <div class="card">
        <div class="card-row" onclick="openProject('${p.id}')">
          <div>
            <div class="card-title">${escapeHtml(p.name)}</div>
            <div class="card-sub">${escapeHtml(p.description) || 'کد: ' + escapeHtml(p.code || '—')}</div>
          </div>
          ${p.active === false ? '<span class="chip off">غیرفعال</span>' : '<span class="arrow">‹</span>'}
        </div>
      </div>
    `).join('');
  }

  appEl.innerHTML = `
    <div class="section-title">پروژه‌ها</div>
    ${listHtml}
    ${isAdmin ? '<div style="height:70px;"></div>' : ''}
  `;

  if (isAdmin) {
    const fab = document.createElement('button');
    fab.className = 'fab';
    fab.id = 'newProjectFab';
    fab.textContent = '+ پروژه جدید';
    fab.onclick = renderProjectBuilder;
    appEl.appendChild(fab);
  }
}

/* ================= ساخت پروژه‌ی جدید (فقط مدیر) ================= */

let builderBlocks = [];

function newFloorGroup() {
  return { type: 'residential', floorStart: 1, floorEnd: 1, repeatCount: 1, unitsPerFloor: 0 };
}
function newBlock() {
  return { name: 'بلوک ' + (builderBlocks.length + 1), groups: [newFloorGroup()] };
}

function renderProjectBuilder() {
  builderBlocks = [newBlock()];
  headerRight.innerHTML = `<button class="back-btn" onclick="renderProjectList()">بازگشت</button>`;
  headerSub.textContent = 'ساخت پروژه جدید';
  drawBuilder();
}

function computeBuilderTotals() {
  let floors = 0, units = 0;
  for (const b of builderBlocks) {
    for (const g of b.groups) {
      const fc = floorCountOf(g);
      floors += fc;
      units += fc * (parseInt(g.unitsPerFloor) || 0);
    }
  }
  return { blocks: builderBlocks.length, floors, units };
}

function floorCountOf(g) {
  if (g.type === 'residential') {
    const s = parseInt(g.floorStart) || 1;
    const e = parseInt(g.floorEnd) || 1;
    return Math.max(0, e - s + 1);
  }
  return parseInt(g.repeatCount) || 1;
}

function floorLabelOf(g, index) {
  switch (g.type) {
    case 'parking': return `پارکینگ ${index + 1}`;
    case 'ground': return 'همکف';
    case 'roof': return 'بام';
    default: {
      const start = parseInt(g.floorStart) || 1;
      return `طبقه ${start + index}`;
    }
  }
}

function drawBuilder() {
  const totals = computeBuilderTotals();
  appEl.innerHTML = `
    <div class="section-title">اطلاعات پروژه</div>
    <div class="card flat">
      <label class="field-label">نام پروژه</label>
      <input id="pName" class="field-input" placeholder="مثلاً برج راسپینا">
      <label class="field-label">کد پروژه</label>
      <input id="pCode" class="field-input" placeholder="اختیاری">
      <label class="field-label">توضیحات</label>
      <input id="pDesc" class="field-input" placeholder="اختیاری">
    </div>

    <div class="section-title">بلوک‌ها</div>
    <div id="blocksHost"></div>
    <button class="btn-secondary" onclick="addBlock()">+ افزودن بلوک</button>

    <div class="summary-strip">
      <div class="summary-item"><div class="summary-num">${totals.blocks}</div><div class="summary-label">بلوک</div></div>
      <div class="summary-item"><div class="summary-num">${totals.floors}</div><div class="summary-label">طبقه</div></div>
      <div class="summary-item"><div class="summary-num">${totals.units}</div><div class="summary-label">واحد</div></div>
    </div>

    <div id="builderError" class="auth-error" style="margin-bottom:10px;"></div>
    <button id="submitBuilderBtn" class="btn-primary" style="width:100%;" onclick="submitBuilder()">ساخت پروژه</button>
  `;
  drawBlocks();
}

function drawBlocks() {
  const host = document.getElementById('blocksHost');
  host.innerHTML = builderBlocks.map((b, bi) => `
    <div class="subcard">
      <div class="subcard-head">
        <input class="field-input" style="margin-bottom:0;" value="${escapeHtml(b.name)}"
               oninput="builderBlocks[${bi}].name=this.value">
        ${builderBlocks.length > 1 ? `<button class="icon-btn" onclick="removeBlock(${bi})">✕</button>` : ''}
      </div>
      ${b.groups.map((g, gi) => drawGroup(b, bi, g, gi)).join('')}
      <button class="btn-secondary" onclick="addGroup(${bi})">+ افزودن گروه طبقه</button>
    </div>
  `).join('');
}

function drawGroup(block, bi, g, gi) {
  const isResidential = g.type === 'residential';
  return `
    <div class="subcard" style="background:var(--panel);">
      <div class="subcard-head">
        <select class="field-input" style="margin-bottom:0;" onchange="builderBlocks[${bi}].groups[${gi}].type=this.value; drawBlocks(); refreshTotals();">
          <option value="parking" ${g.type === 'parking' ? 'selected' : ''}>پارکینگ</option>
          <option value="ground" ${g.type === 'ground' ? 'selected' : ''}>همکف</option>
          <option value="residential" ${g.type === 'residential' ? 'selected' : ''}>مسکونی (بازه طبقه)</option>
          <option value="roof" ${g.type === 'roof' ? 'selected' : ''}>بام</option>
        </select>
        ${block.groups.length > 1 ? `<button class="icon-btn" onclick="removeGroup(${bi},${gi})">✕</button>` : ''}
      </div>
      ${isResidential ? `
        <div class="row-2">
          <div>
            <label class="field-label">از طبقه</label>
            <input type="number" class="field-input" value="${g.floorStart}"
                   oninput="builderBlocks[${bi}].groups[${gi}].floorStart=this.value; refreshTotals();">
          </div>
          <div>
            <label class="field-label">تا طبقه</label>
            <input type="number" class="field-input" value="${g.floorEnd}"
                   oninput="builderBlocks[${bi}].groups[${gi}].floorEnd=this.value; refreshTotals();">
          </div>
        </div>
      ` : `
        <label class="field-label">تعداد طبقه از این نوع</label>
        <input type="number" class="field-input" value="${g.repeatCount}"
               oninput="builderBlocks[${bi}].groups[${gi}].repeatCount=this.value; refreshTotals();">
      `}
      <label class="field-label">تعداد واحد در هر طبقه (۰ = بدون واحد)</label>
      <input type="number" class="field-input" value="${g.unitsPerFloor}"
             oninput="builderBlocks[${bi}].groups[${gi}].unitsPerFloor=this.value; refreshTotals();">
    </div>
  `;
}

function addBlock() { builderBlocks.push(newBlock()); drawBlocks(); refreshTotals(); }
function removeBlock(i) { builderBlocks.splice(i, 1); drawBlocks(); refreshTotals(); }
function addGroup(bi) { builderBlocks[bi].groups.push(newFloorGroup()); drawBlocks(); refreshTotals(); }
function removeGroup(bi, gi) { builderBlocks[bi].groups.splice(gi, 1); drawBlocks(); refreshTotals(); }

function refreshTotals() {
  const totals = computeBuilderTotals();
  const el = document.querySelector('.summary-strip');
  if (!el) return;
  el.innerHTML = `
    <div class="summary-item"><div class="summary-num">${totals.blocks}</div><div class="summary-label">بلوک</div></div>
    <div class="summary-item"><div class="summary-num">${totals.floors}</div><div class="summary-label">طبقه</div></div>
    <div class="summary-item"><div class="summary-num">${totals.units}</div><div class="summary-label">واحد</div></div>
  `;
}

async function submitBuilder() {
  const name = document.getElementById('pName').value.trim();
  const code = document.getElementById('pCode').value.trim();
  const desc = document.getElementById('pDesc').value.trim();
  const errEl = document.getElementById('builderError');
  const btn = document.getElementById('submitBuilderBtn');

  if (!name) {
    errEl.textContent = 'نام پروژه را وارد کنید.';
    return;
  }
  errEl.textContent = '';
  btn.disabled = true;
  btn.textContent = 'در حال ساخت…';

  try {
    await createProjectWithStructure(name, code, desc, builderBlocks);
    renderProjectList();
  } catch (err) {
    console.error(err);
    errEl.textContent = 'خطا در ساخت پروژه: ' + (err.message || err);
    btn.disabled = false;
    btn.textContent = 'ساخت پروژه';
  }
}

// ساخت پروژه + بلوک‌ها + طبقات + واحدها با batch (حداکثر ۴۰۰ عملیات در هر batch)
async function createProjectWithStructure(name, code, description, blocks) {
  const projectRef = db.collection('projects').doc();
  const writes = [
    { ref: projectRef, data: {
        name, code, description, active: true,
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      } },
  ];

  let blockOrder = 0;
  for (const b of blocks) {
    const blockRef = db.collection('blocks').doc();
    writes.push({ ref: blockRef, data: {
      projectId: projectRef.id, name: b.name, order: blockOrder++,
    } });

    let floorOrder = 0;
    for (const g of b.groups) {
      const fc = floorCountOf(g);
      const unitsPerFloor = parseInt(g.unitsPerFloor) || 0;
      for (let i = 0; i < fc; i++) {
        const floorRef = db.collection('floors').doc();
        writes.push({ ref: floorRef, data: {
          blockId: blockRef.id, projectId: projectRef.id,
          name: floorLabelOf(g, i), order: floorOrder++,
          type: g.type, unitsCount: unitsPerFloor,
        } });

        for (let u = 1; u <= unitsPerFloor; u++) {
          const unitRef = db.collection('units').doc();
          writes.push({ ref: unitRef, data: {
            floorId: floorRef.id, blockId: blockRef.id, projectId: projectRef.id,
            name: 'واحد ' + u,
          } });
        }
      }
    }
  }

  for (let i = 0; i < writes.length; i += 400) {
    const chunk = writes.slice(i, i + 400);
    const batch = db.batch();
    chunk.forEach((w) => batch.set(w.ref, w.data));
    await batch.commit();
  }
  return projectRef.id;
}

/* ================= صفحه‌ی پروژه (بلوک/طبقه/واحد + ماژول‌ها) ================= */

async function openProject(projectId) {
  const p = myProjects.find((x) => x.id === projectId);
  if (!p) return;
  currentProject = p;

  headerSub.textContent = p.name;
  headerRight.innerHTML = `<button class="back-btn" onclick="renderProjectList()">بازگشت</button>`;
  appEl.innerHTML = `<div class="center-screen"><span class="sync-note"><span class="dot"></span><span>در حال بارگذاری…</span></span></div>`;

  // بدون OrderBy در کوئری (برای پرهیز از نیاز به Index)؛ مرتب‌سازی سمت کلاینت.
  const blocksSnap = await db.collection('blocks').where('projectId', '==', projectId).get();
  const blocks = blocksSnap.docs.map((d) => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (a.order || 0) - (b.order || 0));

  for (const b of blocks) {
    const floorsSnap = await db.collection('floors').where('blockId', '==', b.id).get();
    b.floors = floorsSnap.docs.map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b2) => (a.order || 0) - (b2.order || 0));
  }
  currentBlocks = blocks;
  renderProjectHome();
}

function renderProjectHome() {
  const p = currentProject;
  const isAdmin = myProfile.roleId === 'admin';

  const treeHtml = currentBlocks.map((b, i) => `
    <div class="tree-block">
      <div class="tree-head" onclick="toggleTreeBlock(${i})">
        <span>${escapeHtml(b.name)}</span>
        <span class="cnt" style="margin-inline-start:auto;">${b.floors.length} طبقه</span>
      </div>
      <div class="tree-body" id="treeBody${i}">
        ${b.floors.map((f) => `
          <div class="tree-floor">
            <span>${escapeHtml(f.name)}</span>
            <span class="cnt">${f.unitsCount > 0 ? f.unitsCount + ' واحد' : 'بدون واحد'}</span>
          </div>
        `).join('') || '<div class="tree-floor">طبقه‌ای ثبت نشده</div>'}
      </div>
    </div>
  `).join('');

  appEl.innerHTML = `
    <div class="section-title">${escapeHtml(p.name)}</div>
    ${p.description ? `<p style="color:var(--ink-soft); font-size:12.5px; margin-top:-6px;">${escapeHtml(p.description)}</p>` : ''}

    <div class="module-grid">
      <div class="module-tile" onclick="alert('چک‌لیست در فاز بعدی اضافه می‌شود.')">
        <div class="em">📋</div><div class="lbl">چک‌لیست ساختمان</div>
      </div>
      <div class="module-tile" onclick="alert('ثبت پیشرفت در فاز بعدی اضافه می‌شود.')">
        <div class="em">📈</div><div class="lbl">ثبت پیشرفت</div>
      </div>
      <div class="module-tile" onclick="alert('استقرار نفرات در فاز بعدی اضافه می‌شود.')">
        <div class="em">👷</div><div class="lbl">نیروی کاری</div>
      </div>
      <div class="module-tile" onclick="alert('گزارش‌ها در فاز بعدی اضافه می‌شود.')">
        <div class="em">📊</div><div class="lbl">داشبورد و گزارش</div>
      </div>
    </div>

    <div class="section-title">ساختار پروژه</div>
    ${treeHtml || '<div class="card flat">بلوکی برای این پروژه تعریف نشده.</div>'}

    ${isAdmin ? `
      <div style="margin-top:18px;">
        <button class="btn-danger" onclick="confirmDeactivateProject()">
          ${p.active === false ? '' : 'غیرفعال کردن این پروژه'}
        </button>
      </div>
    ` : ''}
  `;
}

function toggleTreeBlock(i) {
  const el = document.getElementById('treeBody' + i);
  if (el) el.classList.toggle('open');
}

async function confirmDeactivateProject() {
  if (!currentProject) return;
  if (!confirm('این پروژه غیرفعال شود؟ اطلاعات آن حذف نمی‌شود.')) return;
  await db.collection('projects').doc(currentProject.id).update({ active: false });
  renderProjectList();
}

/* ================= مسیر اصلی ================= */

auth.onAuthStateChanged(async (user) => {
  currentUser = user;
  setStatus(true);

  if (projectsUnsub) { projectsUnsub(); projectsUnsub = null; }

  if (!user) {
    myProfile = null;
    renderLogin();
    hideSplash();
    return;
  }

  try {
    const doc = await db.collection('users').doc(user.uid).get();
    if (!doc.exists) {
      myProfile = { username: '', displayName: '', roleId: '', active: false };
      renderBlocked();
      hideSplash();
      return;
    }
    myProfile = doc.data();

    if (myProfile.active !== true) {
      renderBlocked();
    } else {
      startProjectsListener();
    }
  } catch (err) {
    console.error(err);
    appEl.innerHTML = `<div class="center-screen"><p class="auth-error">خطا در دریافت اطلاعات کاربر.</p></div>`;
  }
  hideSplash();
});

window.addEventListener('offline', () => setStatus(false));
window.addEventListener('online', () => setStatus(true));
