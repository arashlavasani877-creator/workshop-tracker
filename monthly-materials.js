/* Monthly material purchases — admin financial report only. */
let monthlyMaterials = null;
function monthlyMaterialsState(){
  if(!monthlyMaterials){
    let year = 1405, month = 6;
    try{
      const parts = new Intl.DateTimeFormat('en-US-u-ca-persian', {
        year:'numeric', month:'numeric', timeZone:'Asia/Tehran'
      }).formatToParts(new Date());
      year = Number(parts.find(p=>p.type==='year').value);
      month = Number(parts.find(p=>p.type==='month').value);
    }catch(e){}
    monthlyMaterials = {year,month,records:[],loading:true,error:'',unsub:null,key:'',editingId:null,saving:false};
  }
  return monthlyMaterials;
}
function monthlyMaterialsAllowed(){ return myRole === 'admin' && !!currentUser && !!db; }
function monthlyMaterialsDigits(value){
  return String(value).replace(/[۰-۹]/g,d=>String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
    .replace(/[٠-٩]/g,d=>String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
}
function monthlyMaterialsKey(year,month){ return `${year}-${String(month).padStart(2,'0')}`; }
function monthlyMaterialsMoney(amount){ return amount.toLocaleString('en-US'); }
function monthlyMaterialsMonths(selected){
  return JALALI_MONTHS.map((name,i)=>`<option value="${i+1}" ${selected===i+1?'selected':''}>${name}</option>`).join('');
}
function renderMonthlyMaterials(){
  if(myRole !== 'admin') return '';
  const state = monthlyMaterialsState();
  return `<section id="monthlyMaterials" class="mp" aria-labelledby="mpTitle">
    <style>
      .mp{margin:22px 0;padding:18px;background:var(--panel);border:1px solid var(--line);border-radius:16px}
      .mp,.mp-dialog{font-size:13px;line-height:1.8}
      .mp-head{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}
      .mp h2{margin:0;font-size:16px}.mp-note{color:var(--ink-soft);font-size:11px;margin:8px 0 16px}
      .mp button,.mp-dialog button{font:inherit;cursor:pointer;border-radius:10px;min-height:44px;padding:9px 14px;border:1px solid var(--line)}
      .mp-primary{background:var(--amber);color:#191300;font-weight:700!important;border-color:transparent!important}
      .mp-primary:disabled{opacity:.55;cursor:wait}.mp-secondary{background:var(--panel-2);color:var(--ink)}
      .mp :focus-visible,.mp-dialog :focus-visible{outline:2px solid var(--teal);outline-offset:3px}
      .mp-filters,.mp-form-row{display:grid;grid-template-columns:1fr 1fr;gap:12px}
      .mp label,.mp-dialog label{display:block;color:var(--ink-soft);font-size:12px}
      .mp select,.mp input,.mp-dialog input,.mp-dialog select,.mp-dialog textarea{display:block;width:100%;min-width:0;background:var(--panel-2);border:1px solid var(--line);border-radius:9px;color:var(--ink);font:inherit;font-size:16px;padding:10px 12px;min-height:46px;margin-top:5px;color-scheme:dark}
      .mp-filters{padding:14px 0;border-top:1px solid var(--line);align-items:end}.mp-filters button{grid-column:1/-1}
      .mp-summary{padding:16px;background:var(--teal-dim);border:1px solid #4fd1c52b;border-radius:12px;margin:0 0 20px}
      .mp-summary h3{font-size:12px;color:var(--teal);margin:0 0 10px}
      .mp-breakdown{display:flex;justify-content:space-between;gap:12px;margin:7px 0;align-items:baseline}
      .mp-breakdown>span:first-child{min-width:0;overflow-wrap:anywhere}.mp-num{font-variant-numeric:tabular-nums;white-space:nowrap}
      .mp-total{border-top:1px solid #4fd1c533;padding-top:12px;margin-top:12px;display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;font-weight:700}
      .mp-total strong{font-size:20px;color:var(--teal)}.mp-unit{font-size:11px;color:var(--ink-soft);font-weight:400}
      .mp-list-title{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;font-weight:700}
      .mp-count{font-size:11px;color:var(--ink-soft);font-weight:400}
      .mp-record{border:1px solid var(--line);border-radius:12px;padding:14px;margin-top:10px;background:var(--panel-2)}
      .mp-record-top{display:flex;justify-content:space-between;align-items:flex-start;gap:12px}.mp-record-title{min-width:0;overflow-wrap:anywhere}
      .mp-record h4{margin:0;font-size:14px}.mp-date{color:var(--ink-soft);font-size:11px;margin-top:2px}
      .mp-record button{background:transparent;color:var(--teal);padding:6px 12px;flex-shrink:0;font-size:12px}
      .mp-record-amount{margin-top:12px;font-weight:700;font-size:18px}
      .mp-record-note{color:var(--ink-soft);font-size:12px;margin:10px 0 0;white-space:pre-wrap;overflow-wrap:anywhere;border-top:1px solid var(--line);padding-top:9px}
      .mp-empty{text-align:center;padding:28px 12px;border:1px dashed var(--line);border-radius:12px;color:var(--ink-soft)}
      .mp-empty strong{display:block;color:var(--ink);margin-bottom:5px}.mp-error{color:var(--red);font-size:12px}
      .mp-status{color:var(--teal);font-size:12px}.mp-status:empty{display:none}
      .mp-dialog{color:var(--ink);background:var(--panel);border:1px solid var(--line);border-radius:20px 20px 0 0;width:100%;max-width:640px;max-height:92dvh;box-sizing:border-box;margin:auto auto 0;padding:22px 20px max(22px,env(safe-area-inset-bottom));overflow:auto;font-family:'Vazirmatn',sans-serif}
      .mp-dialog::backdrop{background:rgba(0,0,0,.72);backdrop-filter:blur(3px)}
      .mp-dialog h3{margin:0;font-size:18px}.mp-dialog .mp-head button{background:transparent;color:var(--ink-soft);font-size:22px;padding:0;width:44px}
      .mp-dialog label{margin-bottom:14px}.mp-dialog textarea{resize:vertical;min-height:82px;font-size:14px}
      .mp-dialog .mp-help{font-size:11px;color:var(--ink-soft);margin:4px 0 0}
      .mp-dialog .mp-error{min-height:22px;margin:5px 0 10px}.mp-dialog .mp-actions{display:flex;gap:10px}.mp-dialog .mp-actions button:first-child{flex:1}
      @media(min-width:680px){.mp-dialog{margin:auto;border-radius:18px}.mp{padding:22px}}
      @media(max-width:370px){.mp{padding:13px}.mp-head>.mp-primary{width:100%}.mp-total strong{font-size:18px}}
    </style>
    <div class="mp-head"><h2 id="mpTitle">خرید متریال ماهانه</h2>
      <button type="button" class="mp-primary" id="mpAdd" onclick="openMonthlyMaterialForm()">+ ثبت خرید جدید</button></div>
    <p class="mp-note">مبلغ‌ها به ریال ثبت می‌شوند.</p>
    <div class="mp-filters">
      <label for="mpFilterMonth">ماه<select id="mpFilterMonth">${monthlyMaterialsMonths(state.month)}</select></label>
      <label for="mpFilterYear">سال<input id="mpFilterYear" type="text" inputmode="numeric" maxlength="4" value="${state.year}" placeholder="1405"></label>
      <button type="button" class="mp-secondary" onclick="filterMonthlyMaterials()">نمایش خریدهای ماه</button>
    </div>
    <p id="mpFilterError" class="mp-error" role="alert"></p>
    <div id="mpResults">${renderMonthlyMaterialResults()}</div>
    <p class="mp-status" id="mpStatus" role="status" aria-live="polite"></p>
    <dialog id="mpDialog" class="mp-dialog" aria-labelledby="mpDialogTitle" onclose="monthlyMaterialFormClosed()">
      <div class="mp-head"><h3 id="mpDialogTitle">ثبت خرید جدید</h3><button type="button" aria-label="بستن فرم خرید" onclick="closeMonthlyMaterialForm()">×</button></div>
      <p class="mp-note">مبلغ خرید را به ریال وارد کنید.</p>
      <form id="mpForm" onsubmit="saveMonthlyMaterial(event)" novalidate>
        <label for="mpSupplier">تأمین‌کننده<input id="mpSupplier" type="text" placeholder="مثلاً ملونی یا پارسیان چوب" maxlength="100" required autocomplete="off"></label>
        <label for="mpAmount">مبلغ کل خرید (ریال)<input id="mpAmount" type="text" inputmode="numeric" dir="ltr" placeholder="180,000,000" required oninput="formatMonthlyMaterialAmount(this)" aria-describedby="mpAmountHelp"><span id="mpAmountHelp" class="mp-help">مبلغ کامل خرید را به ریال وارد کنید.</span></label>
        <div class="mp-form-row">
          <label for="mpMonth">ماه<select id="mpMonth">${monthlyMaterialsMonths(state.month)}</select></label>
          <label for="mpYear">سال<input id="mpYear" type="text" inputmode="numeric" dir="ltr" maxlength="4" placeholder="1405" required></label>
        </div>
        <label for="mpDescription">توضیح <span class="mp-unit">(اختیاری)</span><textarea id="mpDescription" maxlength="1000" placeholder="جزئیات خرید، نوع متریال یا شماره فاکتور…"></textarea></label>
        <p id="mpError" class="mp-error" role="alert"></p>
        <div class="mp-actions"><button type="submit" id="mpSubmit" class="mp-primary">ثبت خرید</button><button type="button" class="mp-secondary" onclick="closeMonthlyMaterialForm()">انصراف</button></div>
      </form>
    </dialog>
  </section>`;
}
function renderMonthlyMaterialResults(){
  if(myRole !== 'admin') return '';
  const state = monthlyMaterialsState();
  if(state.loading) return '<div class="mp-empty">در حال بارگذاری خریدهای این ماه…</div>';
  if(state.error) return `<div class="mp-empty mp-error"><strong>خریدهای این ماه بارگذاری نشد</strong>${escapeHtml(state.error)}</div>`;
  const rows = state.records;
  const suppliers = new Map();
  rows.forEach(p=>suppliers.set(p.supplier,(suppliers.get(p.supplier)||0n)+BigInt(p.amountRial)));
  const total = rows.reduce((sum,p)=>sum+BigInt(p.amountRial),0n);
  const period = `${JALALI_MONTHS[state.month-1]} ${state.year}`;
  return `<div class="mp-summary" aria-label="خلاصه خرید ماه انتخاب‌شده">
      <h3>خلاصه ${period}</h3>
      ${[...suppliers].map(([name,amount])=>`<div class="mp-breakdown"><span>خرید ${escapeHtml(name)}</span><span class="mp-num" dir="ltr">${monthlyMaterialsMoney(amount)}</span></div>`).join('')}
      <div class="mp-total"><span>جمع خرید متریال</span><span><strong class="mp-num" dir="ltr">${monthlyMaterialsMoney(total)}</strong> <span class="mp-unit">ریال</span></span></div>
    </div>
    <div class="mp-list-title"><span>خریدهای ${period}</span><span class="mp-count">${rows.length} خرید</span></div>
    ${rows.length ? rows.map(p=>`<article class="mp-record"><div class="mp-record-top"><div class="mp-record-title"><h4>${escapeHtml(p.supplier)}</h4><div class="mp-date">${JALALI_MONTHS[p.month-1]} ${p.year}</div></div><button type="button" data-mp-edit="${escapeHtml(p.id)}" onclick="openMonthlyMaterialForm(this.dataset.mpEdit)">ویرایش</button></div>
      <div class="mp-record-amount"><bdi class="mp-num">${monthlyMaterialsMoney(p.amountRial)}</bdi> <span class="mp-unit">ریال</span></div>
      ${p.description?`<p class="mp-record-note">${escapeHtml(p.description)}</p>`:''}</article>`).join('') : '<div class="mp-empty"><strong>هنوز خریدی برای این ماه ثبت نشده</strong>برای شروع، «ثبت خرید جدید» را بزنید.</div>'}`;
}
function updateMonthlyMaterialsResults(){
  const target = document.getElementById('mpResults');
  if(target && myRole === 'admin') target.innerHTML = renderMonthlyMaterialResults();
}
function stopMonthlyMaterials(){
  if(monthlyMaterials && monthlyMaterials.unsub){monthlyMaterials.unsub();monthlyMaterials.unsub=null;monthlyMaterials.key='';}
}
function subscribeMonthlyMaterials(){
  if(!monthlyMaterialsAllowed() || adminTab !== 'financial') return;
  const state = monthlyMaterialsState();
  const key = monthlyMaterialsKey(state.year,state.month);
  if(state.unsub && state.key === key) return;
  stopMonthlyMaterials();
  state.key = key; state.loading = true; state.error = ''; state.records = [];
  updateMonthlyMaterialsResults();
  state.unsub = db.collection('monthlyMaterialPurchases').where('periodKey','==',key).onSnapshot(snap=>{
    if(myRole !== 'admin' || state.key !== key) return;
    state.records = snap.docs.map(d=>({id:d.id,...d.data()})).sort((a,b)=>{
      const left = a.createdAt && a.createdAt.toMillis ? a.createdAt.toMillis() : 0;
      const right = b.createdAt && b.createdAt.toMillis ? b.createdAt.toMillis() : 0;
      return right-left;
    });
    state.loading = false;state.error='';updateMonthlyMaterialsResults();
  },err=>{
    if(state.key !== key) return;
    state.loading=false;state.error=err.code==='permission-denied'?'دسترسی این بخش هنوز در Firestore Rules فعال نشده است.':'خطا در دریافت خریدها. اتصال را بررسی کنید.';
    updateMonthlyMaterialsResults();
  });
}
function filterMonthlyMaterials(){
  if(!monthlyMaterialsAllowed()) return;
  const raw = monthlyMaterialsDigits(document.getElementById('mpFilterYear').value).trim();
  const month = Number(document.getElementById('mpFilterMonth').value);
  if(!/^[1-9]\d{3}$/.test(raw) || !Number.isInteger(month) || month<1 || month>12){
    document.getElementById('mpFilterError').textContent = 'سال چهاررقمی و ماه معتبر وارد کنید.';return;
  }
  const state = monthlyMaterialsState();
  state.year=Number(raw);state.month=month;
  document.getElementById('mpFilterError').textContent='';
  subscribeMonthlyMaterials();
}
function openMonthlyMaterialForm(id){
  if(!monthlyMaterialsAllowed()) return;
  const state = monthlyMaterialsState();
  const record = id == null ? null : state.records.find(p=>p.id===id);
  if(id != null && !record) return;
  state.editingId=record?record.id:null;
  document.getElementById('mpForm').reset();
  document.getElementById('mpDialogTitle').textContent=record?'ویرایش خرید':'ثبت خرید جدید';
  document.getElementById('mpSubmit').textContent=record?'ذخیره تغییرات':'ثبت خرید';
  document.getElementById('mpSupplier').value=record?record.supplier:'';
  document.getElementById('mpAmount').value=record?monthlyMaterialsMoney(record.amountRial):'';
  document.getElementById('mpYear').value=record?record.year:state.year;
  document.getElementById('mpMonth').value=record?record.month:state.month;
  document.getElementById('mpDescription').value=record?record.description:'';
  document.getElementById('mpError').textContent='';
  document.getElementById('mpDialog').showModal();
  document.getElementById('mpSupplier').focus();
}
function closeMonthlyMaterialForm(){
  if(!monthlyMaterialsAllowed() || monthlyMaterialsState().saving) return;
  document.getElementById('mpDialog').close();
}
function monthlyMaterialFormClosed(){ if(monthlyMaterials && !monthlyMaterials.saving) monthlyMaterials.editingId=null; }
function formatMonthlyMaterialAmount(input){
  const raw=monthlyMaterialsDigits(input.value).replace(/[,٬\s]/g,'');
  if(!/^\d*$/.test(raw)) return;
  const before=monthlyMaterialsDigits(input.value.slice(0,input.selectionStart)).replace(/[,٬\s]/g,'').length;
  input.value=raw.replace(/\B(?=(\d{3})+(?!\d))/g,',');
  let digits=0,caret=0;
  while(caret<input.value.length && digits<before){if(/\d/.test(input.value[caret])) digits++;caret++;}
  input.setSelectionRange(caret,caret);
}
async function saveMonthlyMaterial(event){
  event.preventDefault();
  if(!monthlyMaterialsAllowed()) return;
  const state=monthlyMaterialsState();
  if(state.saving) return;
  const supplier=document.getElementById('mpSupplier').value.trim().replace(/\s+/g,' ');
  const rawAmount=monthlyMaterialsDigits(document.getElementById('mpAmount').value).replace(/[,٬\s]/g,'');
  const rawYear=monthlyMaterialsDigits(document.getElementById('mpYear').value).trim();
  const amount=Number(rawAmount),year=Number(rawYear),month=Number(document.getElementById('mpMonth').value);
  const description=document.getElementById('mpDescription').value.trim();
  const fail=(message,id)=>{document.getElementById('mpError').textContent=message;document.getElementById(id).focus();};
  if(!supplier) return fail('نام تأمین‌کننده را وارد کنید.','mpSupplier');
  if(!/^\d+$/.test(rawAmount) || !Number.isSafeInteger(amount) || amount<=0) return fail('مبلغ خرید باید عدد صحیح مثبت و معتبر به ریال باشد.','mpAmount');
  if(!/^[1-9]\d{3}$/.test(rawYear)) return fail('سال را با چهار رقم وارد کنید؛ مثلاً 1405.','mpYear');
  if(!Number.isInteger(month) || month<1 || month>12) return fail('ماه معتبر انتخاب کنید.','mpMonth');
  const data={supplier,amountRial:amount,year,month,periodKey:monthlyMaterialsKey(year,month),description,
    updatedAt:firebase.firestore.FieldValue.serverTimestamp(),updatedByUid:currentUser.uid};
  state.saving=true;
  const button=document.getElementById('mpSubmit');button.disabled=true;button.textContent='در حال ذخیره…';
  try{
    if(state.editingId){
      await db.collection('monthlyMaterialPurchases').doc(state.editingId).update(data);
    }else{
      await db.collection('monthlyMaterialPurchases').add({...data,
        createdAt:firebase.firestore.FieldValue.serverTimestamp(),createdByUid:currentUser.uid});
    }
    const message=state.editingId?'تغییرات خرید ذخیره شد.':'خرید ثبت شد.';
    document.getElementById('mpDialog').close();
    state.editingId=null;
    if(state.year!==year || state.month!==month){
      state.year=year;state.month=month;
      document.getElementById('monthlyMaterials').outerHTML=renderMonthlyMaterials();
      subscribeMonthlyMaterials();
    }else{
      const target=document.getElementById('mpStatus');if(target) target.textContent=message;
    }
  }catch(err){
    const target=document.getElementById('mpError');
    if(target) target.textContent=err.code==='permission-denied'?'دسترسی ثبت خرید در Firestore Rules فعال نیست.':'ذخیره انجام نشد. اتصال را بررسی و دوباره تلاش کنید.';
  }finally{
    state.saving=false;
    const submit=document.getElementById('mpSubmit');if(submit){submit.disabled=false;submit.textContent=state.editingId?'ذخیره تغییرات':'ثبت خرید';}
  }
}
