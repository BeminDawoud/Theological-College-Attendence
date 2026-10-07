/* =====================================================================
   طبقة التخزين — الاتصال بخادم Google Apps Script (يحفظ في students.json على Drive)
   ===================================================================== */

// ضع هنا رابط النشر (Web app URL) الذي ينتهي بـ /exec
const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbzor6dduXwz2wKlfeUF0kNTErlAXM34XNbwG0LoVxmScgDtbZ1D5nGeUcCfgPpXLT8p/exec';

const PW_KEY = 'attendance_password';
let password = '';        // كلمة سر المشرف الحالية (فارغة في وضع الزائر)
let currentRev = null;    // رقم نسخة البيانات على الخادم (لمنع تعارض مشرفين)
let seenSeq = 0;          // آخر تسجيل زائر تم دمجه في البيانات المحمّلة

function getStoredPassword() {
  try { return localStorage.getItem(PW_KEY) || ''; } catch (e) { return ''; }
}
function setStoredPassword(p) {
  try {
    if (p) localStorage.setItem(PW_KEY, p); else localStorage.removeItem(PW_KEY);
  } catch (e) { /* تجاهل */ }
}

const API_ERRORS = {
  unauthorized: 'كلمة السر غير صحيحة',
  conflict: 'البيانات تغيّرت من جهاز آخر — أعد تحميل الصفحة ثم عدّل مرة أخرى',
  invalid_data: 'بيانات غير صالحة',
  bad_request: 'طلب غير صالح',
  bad_action: 'طلب غير صالح'
};

async function api(body) {
  if (!APPS_SCRIPT_URL) throw new Error('لم يتم ضبط APPS_SCRIPT_URL في أول script.js');
  // كلمة السر تُرسل فقط مع عمليات المشرف
  const admin = body.action === 'load' || body.action === 'save';
  let res;
  try {
    res = await fetch(APPS_SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // بدون preflight
      body: JSON.stringify(admin ? { ...body, password } : body)
    });
  } catch (e) {
    throw new Error('تعذّر الاتصال بالخادم — تحقق من الإنترنت');
  }
  if (!res.ok) throw new Error('تعذّر الاتصال بالخادم (' + res.status + ')');
  let out;
  try { out = await res.json(); } catch (e) { throw new Error('رد غير مفهوم من الخادم — راجع إعدادات نشر الـ Script'); }
  if (!out.ok) {
    const err = new Error(API_ERRORS[out.error] || out.error || 'خطأ في الخادم');
    err.code = out.error;
    throw err;
  }
  return out;
}

// زائر: أسماء الطلاب ونطاق التواريخ المسموح (بدون أي بيانات حضور)
async function loadGuestInfo() {
  return api({ action: 'students' });
}

// زائر: إرسال تسجيلات الحضور الجديدة (إضافة فقط في الخانات الفارغة)
async function saveGuestEntries(entries) {
  return api({ action: 'guestSave', entries });
}

// مشرف: قراءة كل البيانات
async function loadStudentsFile() {
  const out = await api({ action: 'load' });
  currentRev = out.rev;
  seenSeq = out.seq || 0;
  return out.data;
}

// مشرف: حفظ البيانات (استبدال محتوى students.json على Drive). تُرجع تسجيلات الزوار التي دُمجت أثناء الحفظ.
async function saveStudentsFile(data) {
  if (currentRev === null) throw new Error('لم يتم تحميل البيانات — أعد تحميل الصفحة');
  const out = await api({ action: 'save', data: data, baseRev: currentRev, seenSeq: seenSeq });
  currentRev = out.rev;
  seenSeq = out.seq || seenSeq;
  return out.added || [];
}

/* =====================================================================
   منطق الموقع
   ===================================================================== */
const PERIODS = [
  { key: 'isha',  label: 'صلاة عشية' },
  { key: 'baker', label: 'صلاة باكر' }
];
const STATUSES = ['حضور', 'غياب', 'اعتذار', 'إجازة'];

// data = { students: [{id, name, year}], attendance: { "YYYY-MM-DD": { studentId: {isha, baker} } } }
let data = { students: [], attendance: {} };
let currentDate = toISO(new Date());
let isAdmin = false;      // false = زائر (تسجيل حضور فقط)، true = مشرف
let loaded = false;       // لا نحفظ قبل نجاح التحميل حتى لا نمسح البيانات
let dirty = false;        // (مشرف) توجد تغييرات لم تُحفظ بعد
let guestPending = {};    // (زائر) تسجيلات لم تُرسل بعد:  "date|id|period" → {date,id,period,value}
let guestLocked = {};     // (زائر) تسجيلات أُرسلت في هذه الجلسة (لا يمكن تعديلها)

const $ = id => document.getElementById(id);
const datePicker = $('datePicker');
const savedDates = $('savedDates');
const statusMsg = $('statusMsg');
const saveBtn = $('saveBtn');
const tbody = $('attendanceBody');

/* ===== أدوات ===== */
function toISO(d) {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function showMsg(text, type = 'ok') {
  statusMsg.textContent = text;
  statusMsg.className = 'status-msg ' + type;
}

const cellKey = (date, id, period) => `${date}|${id}|${period}`;

function setPending(on) {
  saveBtn.classList.toggle('pending', on);
}

function markDirty() {
  dirty = true;
  setPending(true);
  showMsg('تغييرات غير محفوظة — اضغط "حفظ الحضور"', 'err');
}

function hasUnsaved() {
  return isAdmin ? dirty : Object.keys(guestPending).length > 0;
}

function normalize(raw) {
  const students = Array.isArray(raw && raw.students) ? raw.students.map(s => ({
    id: Number(s.id),
    name: String(s.name || '').trim(),
    year: String(s.year || 'الأولى')
  })) : [];
  const attendance = (raw && typeof raw.attendance === 'object' && raw.attendance) || {};
  return { students, attendance };
}

/* ===== الدخول والخروج ===== */
function showLogin(msg = '') {
  $('loginError').textContent = msg;
  $('loginOverlay').hidden = false;
  $('loginPassword').focus();
}
function hideLogin() {
  $('loginOverlay').hidden = true;
  $('loginPassword').value = '';
  $('loginError').textContent = '';
}

// وضع الزائر: أسماء الطلاب فقط، تسجيل الحضور في النطاق المسموح
async function enterGuest() {
  isAdmin = false;
  loaded = false;
  password = '';
  dirty = false;
  guestPending = {};
  guestLocked = {};
  data = { students: [], attendance: {} };
  document.body.classList.remove('admin');
  setPending(false);
  renderAll();   // امسح أي بيانات مشرف ظاهرة فوراً قبل انتظار الخادم
  try {
    const out = await loadGuestInfo();
    data.students = normalize({ students: out.students }).students;
    datePicker.min = out.minDate;
    datePicker.max = out.today;
    currentDate = out.today;
    loaded = true;
    showMsg('وضع تسجيل الحضور — اختر الحالة لكل طالب ثم اضغط "حفظ الحضور"');
  } catch (e) {
    showMsg(e.message || 'تعذّر تحميل قائمة الطلاب', 'err');
  }
  renderAll();
}

// وضع المشرف: يعيد null عند النجاح، أو الخطأ عند الفشل
async function tryAdmin(pw) {
  password = pw;
  try {
    data = normalize(await loadStudentsFile());
  } catch (e) {
    if (e.code === 'unauthorized') {
      password = '';
      setStoredPassword('');
    }
    return e;
  }
  isAdmin = true;
  loaded = true;
  dirty = false;
  guestPending = {};
  guestLocked = {};
  setStoredPassword(pw);
  document.body.classList.add('admin');
  datePicker.removeAttribute('min');
  datePicker.removeAttribute('max');
  setPending(false);
  hideLogin();
  showMsg('تم الدخول كمشرف — تم تحميل البيانات');
  syncReportInputs();
  renderAll();
  return null;
}

async function logout() {
  if (hasUnsaved() && !confirm('توجد تغييرات غير محفوظة وستضيع. هل تريد تسجيل الخروج؟')) return;
  setStoredPassword('');
  await enterGuest();
}

/* ===== حساب نسبة اليوم ===== */
function dayStats(studentId) {
  const rec = (data.attendance[currentDate] || {})[studentId] || {};
  const counts = { 'حضور': 0, 'غياب': 0, 'اعتذار': 0, 'إجازة': 0 };
  let total = 0;
  PERIODS.forEach(p => {
    const v = rec[p.key];
    if (v && counts[v] !== undefined) { counts[v]++; total++; }
  });
  const percent = total ? Math.round((counts['حضور'] / total) * 100) : null;
  return { counts, percent };
}

function barColor(p) {
  if (p === null) return 'none';
  if (p > 75) return 'green';
  if (p >= 50) return 'yellow';
  return 'red';
}

/* ===== التقرير الأسبوعي / الشهري (محسوب من نفس البيانات، لا يُخزَّن) ===== */
function parseISO(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

// النطاق الذي ينتمي إليه اليوم المختار: الأسبوع (الأحد → السبت) أو الشهر
function reportRange(type) {
  // الأسبوع: أي يوم يقع داخله (من خانة التاريخ)، الشهر: من خانة الشهر
  const base = (type === 'month' && $('reportMonth').value)
    ? $('reportMonth').value + '-01'
    : ($('reportDate').value || currentDate);
  const d = parseISO(base);
  if (type === 'month') {
    return {
      start: toISO(new Date(d.getFullYear(), d.getMonth(), 1)),
      end: toISO(new Date(d.getFullYear(), d.getMonth() + 1, 0))
    };
  }
  const s = new Date(d.getFullYear(), d.getMonth(), d.getDate() - d.getDay());
  return { start: toISO(s), end: toISO(new Date(s.getFullYear(), s.getMonth(), s.getDate() + 6)) };
}

function rangeStats(studentId, start, end) {
  const counts = { 'حضور': 0, 'غياب': 0, 'اعتذار': 0, 'إجازة': 0 };
  let total = 0;
  for (const date in data.attendance) {
    if (date < start || date > end) continue;
    const rec = data.attendance[date][studentId];
    if (!rec) continue;
    PERIODS.forEach(p => {
      const v = rec[p.key];
      if (v && counts[v] !== undefined) { counts[v]++; total++; }
    });
  }
  const percent = total ? Math.round((counts['حضور'] / total) * 100) : null;
  return { counts, percent };
}

// ضبط خانتي التقرير على اليوم المختار في الكشف اليومي
function syncReportInputs() {
  $('reportDate').value = currentDate;
  $('reportMonth').value = currentDate.slice(0, 7);
}

function renderReport() {
  if (!isAdmin) return;
  const type = $('reportType').value;
  $('reportDate').hidden = type === 'month';
  $('reportMonth').hidden = type !== 'month';
  const { start, end } = reportRange(type);
  $('reportLabel').textContent = (type === 'month' ? '— الشهر' : '— الأسبوع') + ` من ${start} إلى ${end}`;
  const body = $('reportBody');
  if (!data.students.length) {
    body.innerHTML = '<tr><td colspan="7" class="empty">لا يوجد طلاب.</td></tr>';
    return;
  }
  body.innerHTML = data.students.map(s => {
    const st = rangeStats(s.id, start, end);
    const c = st.counts;
    const width = st.percent === null ? 0 : st.percent;
    const pText = st.percent === null ? 'لا توجد بيانات' : st.percent + '%';
    return `<tr>
      <td class="name">${esc(s.name)}</td>
      <td>${esc(s.year)}</td>
      <td>${c['حضور']}</td>
      <td>${c['غياب']}</td>
      <td>${c['اعتذار']}</td>
      <td>${c['إجازة']}</td>
      <td class="progress-cell">
        <div class="progress"><div class="progress-bar ${barColor(st.percent)}" style="width:${width}%"></div></div>
        <div class="percent">${pText}</div>
      </td>
    </tr>`;
  }).join('');
}

/* ===== العرض ===== */
function renderSavedDates() {
  const dates = Object.keys(data.attendance)
    .filter(d => Object.values(data.attendance[d]).some(rec => PERIODS.some(p => rec[p.key])))
    .sort().reverse();
  savedDates.innerHTML = '<option value="">— اختر يوماً مسجلاً —</option>' +
    dates.map(d => `<option value="${d}"${d === currentDate ? ' selected' : ''}>${d}</option>`).join('');
}

function renderTable() {
  renderReport();
  $('dayLabel').textContent = '— ' + currentDate;
  if (!data.students.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty">' +
      (isAdmin ? 'لا يوجد طلاب. أضف طالباً من النموذج أعلاه.' : 'لا يوجد طلاب.') + '</td></tr>';
    return;
  }
  const dayRec = data.attendance[currentDate] || {};
  tbody.innerHTML = data.students.map(s => {
    const rec = dayRec[s.id] || {};
    const selects = PERIODS.map(p => {
      let v = '', disabled = false;
      if (isAdmin) {
        v = rec[p.key] || '';
      } else {
        // الزائر يرى فقط ما أدخله هو في هذه الجلسة
        const k = cellKey(currentDate, s.id, p.key);
        const own = guestPending[k] || guestLocked[k];
        v = own ? own.value : '';
        disabled = !!guestLocked[k];
      }
      const opts = '<option value="">— غير مسجل —</option>' +
        STATUSES.map(st => `<option value="${st}"${st === v ? ' selected' : ''}>${st}</option>`).join('');
      return `<td><select data-id="${s.id}" data-period="${p.key}" class="${v ? 'st-' + v : ''}"${disabled ? ' disabled' : ''}>${opts}</select></td>`;
    }).join('');

    if (!isAdmin) {
      return `<tr><td class="name">${esc(s.name)}</td><td>${esc(s.year)}</td>${selects}</tr>`;
    }

    const st = dayStats(s.id);
    const width = st.percent === null ? 0 : st.percent;
    const pText = st.percent === null ? 'لا توجد بيانات' : st.percent + '%';
    const c = st.counts;

    return `<tr>
      <td class="name">${esc(s.name)}</td>
      <td>${esc(s.year)}</td>
      ${selects}
      <td class="progress-cell admin-only">
        <div class="progress"><div class="progress-bar ${barColor(st.percent)}" style="width:${width}%"></div></div>
        <div class="percent">${pText}</div>
      </td>
      <td class="details admin-only">حضور <b>${c['حضور']}</b> | غياب <b>${c['غياب']}</b> | اعتذار <b>${c['اعتذار']}</b> | إجازة <b>${c['إجازة']}</b></td>
      <td class="admin-only"><button class="btn danger" data-delete="${s.id}" title="حذف الطالب">🗑</button></td>
    </tr>`;
  }).join('');
}

function renderAll() {
  datePicker.value = currentDate;
  if (isAdmin) renderSavedDates();
  renderTable();
}

/* ===== الأحداث ===== */
datePicker.addEventListener('change', () => {
  if (!datePicker.value) return;
  let d = datePicker.value;
  // الزائر محصور في النطاق الذي حدده الخادم
  if (!isAdmin && datePicker.min && datePicker.max) {
    if (d < datePicker.min) d = datePicker.min;
    if (d > datePicker.max) d = datePicker.max;
  }
  currentDate = d;
  if (isAdmin) syncReportInputs();
  renderAll();
});

savedDates.addEventListener('change', () => {
  if (!isAdmin || !savedDates.value) return;
  currentDate = savedDates.value;
  syncReportInputs();
  renderAll();
});

// تسجيل الحضور
tbody.addEventListener('change', e => {
  const sel = e.target.closest('select[data-id]');
  if (!sel) return;
  const id = sel.dataset.id, period = sel.dataset.period, value = sel.value;

  if (!isAdmin) {
    // زائر: تسجيل مؤقت في الذاكرة حتى الضغط على "حفظ الحضور"
    const k = cellKey(currentDate, id, period);
    if (guestLocked[k]) return;
    if (value) guestPending[k] = { date: currentDate, id: id, period: period, value: value };
    else delete guestPending[k];
    setPending(Object.keys(guestPending).length > 0);
    showMsg(Object.keys(guestPending).length ? 'تسجيلات غير محفوظة — اضغط "حفظ الحضور"' : 'وضع تسجيل الحضور',
      Object.keys(guestPending).length ? 'err' : 'ok');
    renderTable();
    return;
  }

  // مشرف: تعديل في الذاكرة حتى الضغط على زر الحفظ
  if (!data.attendance[currentDate]) data.attendance[currentDate] = {};
  if (!data.attendance[currentDate][id]) data.attendance[currentDate][id] = {};
  const rec = data.attendance[currentDate][id];
  if (value) rec[period] = value; else delete rec[period];
  // تنظيف السجلات الفارغة
  if (!Object.keys(rec).length) delete data.attendance[currentDate][id];
  if (!Object.keys(data.attendance[currentDate]).length) delete data.attendance[currentDate];
  markDirty();
  renderSavedDates();
  renderTable();
});

// حذف طالب (مشرف)
tbody.addEventListener('click', e => {
  const btn = e.target.closest('[data-delete]');
  if (!btn || !isAdmin) return;
  const id = Number(btn.dataset.delete);
  const s = data.students.find(x => x.id === id);
  if (!s || !confirm(`هل تريد حذف الطالب "${s.name}" وكل سجلات حضوره؟`)) return;
  data.students = data.students.filter(x => x.id !== id);
  for (const d in data.attendance) {
    delete data.attendance[d][id];
    if (!Object.keys(data.attendance[d]).length) delete data.attendance[d];
  }
  markDirty();
  renderAll();
});

$('reportType').addEventListener('change', renderReport);
$('reportDate').addEventListener('change', renderReport);
$('reportMonth').addEventListener('change', renderReport);

// حذف بيانات اليوم المختار بالكامل (مشرف)
$('deleteDayBtn').addEventListener('click', () => {
  if (!isAdmin) return;
  if (!data.attendance[currentDate]) {
    showMsg('لا توجد بيانات مسجلة في هذا اليوم', 'err');
    return;
  }
  if (!confirm(`هل تريد حذف كل بيانات الحضور المسجلة في يوم ${currentDate}؟`)) return;
  delete data.attendance[currentDate];
  markDirty();
  renderAll();
});

// إضافة طالب (مشرف)
$('addForm').addEventListener('submit', e => {
  e.preventDefault();
  if (!isAdmin) return;
  const name = $('studentName').value.trim();
  if (!name) return;
  const id = data.students.reduce((m, s) => Math.max(m, s.id), 0) + 1;
  data.students.push({ id, name, year: $('studentYear').value });
  $('studentName').value = '';
  markDirty();
  renderTable();
});

// زر الحفظ
saveBtn.addEventListener('click', async () => {
  if (!loaded) {
    showMsg('لم يتم تحميل البيانات، لذلك لن يتم الحفظ', 'err');
    return;
  }
  saveBtn.disabled = true;
  try {
    if (isAdmin) await adminSave(); else await guestSave();
  } finally {
    saveBtn.disabled = false;
  }
});

async function adminSave() {
  try {
    const added = await saveStudentsFile(data);
    // تسجيلات زوار وصلت بعد آخر تحميل: دُمجت في الملف، فندمجها هنا أيضاً
    added.forEach(en => {
      if (!data.attendance[en.date]) data.attendance[en.date] = {};
      if (!data.attendance[en.date][en.id]) data.attendance[en.date][en.id] = {};
      data.attendance[en.date][en.id][en.period] = en.value;
    });
    dirty = false;
    setPending(false);
    showMsg(added.length ? `✔ تم حفظ البيانات (وإضافة ${added.length} تسجيل من الزوار)` : '✔ تم حفظ البيانات');
    renderAll();
  } catch (e) {
    if (e.code === 'unauthorized') {
      // تم تغيير كلمة السر: نطلب الدخول من جديد (التعديلات غير المحفوظة تبقى في الصفحة)
      password = '';
      setStoredPassword('');
      showLogin('تم تغيير كلمة السر — ادخل بالكلمة الجديدة ثم احفظ مرة أخرى');
    }
    showMsg('فشل الحفظ: ' + (e.message || 'خطأ غير معروف'), 'err');
  }
}

async function guestSave() {
  const entries = Object.values(guestPending);
  if (!entries.length) {
    showMsg('لا توجد تسجيلات جديدة للحفظ', 'err');
    return;
  }
  try {
    const out = await saveGuestEntries(entries);
    const skipped = new Set(out.skipped || []);
    entries.forEach(en => {
      const k = cellKey(en.date, en.id, en.period);
      if (!skipped.has(k)) guestLocked[k] = en;   // أُرسل: يُقفل
      delete guestPending[k];                       // المتخطّى يُزال أيضاً
    });
    setPending(false);
    showMsg(skipped.size
      ? `✔ تم حفظ ${out.saved} تسجيل — وتم تخطي ${skipped.size} لأنها مسجلة مسبقاً`
      : `✔ تم حفظ ${out.saved} تسجيل`, skipped.size ? 'err' : 'ok');
    renderTable();
  } catch (e) {
    showMsg('فشل الحفظ: ' + (e.message || 'خطأ غير معروف'), 'err');
  }
}

window.addEventListener('beforeunload', e => {
  if (hasUnsaved()) { e.preventDefault(); e.returnValue = ''; }
});

// دخول المشرف
$('adminBtn').addEventListener('click', () => showLogin());
$('loginCancel').addEventListener('click', hideLogin);

$('loginForm').addEventListener('submit', async e => {
  e.preventDefault();
  if (hasUnsaved() && !confirm('التسجيلات غير المحفوظة في وضع الزائر ستضيع عند الدخول كمشرف. هل تريد المتابعة؟')) return;
  $('loginError').textContent = 'جارٍ التحقق...';
  const err = await tryAdmin($('loginPassword').value);
  if (err) $('loginError').textContent = err.message || 'تعذّر الدخول';
});

$('logoutBtn').addEventListener('click', logout);

/* ===== البدء ===== */
(async function start() {
  renderAll();
  const stored = getStoredPassword();
  // إن وُجدت كلمة سر محفوظة على الجهاز: ندخل كمشرف تلقائياً، وإلا (أو إن فشل) نبدأ كزائر
  if (stored && !(await tryAdmin(stored))) return;
  await enterGuest();
})();
