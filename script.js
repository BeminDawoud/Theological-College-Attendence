/* =====================================================================
   طبقة التخزين — الاتصال بخادم Google Apps Script (يحفظ في students.json على Drive)
   ===================================================================== */

// ضع هنا رابط النشر (Web app URL) الذي ينتهي بـ /exec
const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbzor6dduXwz2wKlfeUF0kNTErlAXM34XNbwG0LoVxmScgDtbZ1D5nGeUcCfgPpXLT8p/exec';

const PW_KEY = 'attendance_password';
let password = '';        // كلمة السر الحالية
let currentRev = null;    // رقم نسخة البيانات على الخادم (لمنع تعارض التعديل)

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
  let res;
  try {
    res = await fetch(APPS_SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // بدون preflight
      body: JSON.stringify({ ...body, password })
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

// قراءة البيانات
async function loadStudentsFile() {
  const out = await api({ action: 'load' });
  currentRev = out.rev;
  return out.data;
}

// حفظ البيانات (استبدال محتوى students.json على Drive)
async function saveStudentsFile(data) {
  if (currentRev === null) throw new Error('لم يتم تحميل البيانات — أعد تحميل الصفحة');
  const out = await api({ action: 'save', data: data, baseRev: currentRev });
  currentRev = out.rev;
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
let loaded = false;   // لا نحفظ قبل نجاح تحميل الملف حتى لا نمسح البيانات
let dirty = false;    // توجد تغييرات لم تُحفظ بعد

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

function markDirty() {
  dirty = true;
  saveBtn.classList.add('pending');
  showMsg('تغييرات غير محفوظة — اضغط "حفظ البيانات"', 'err');
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

/* ===== التحميل ===== */
function showLogin(msg = '') {
  $('loginError').textContent = msg;
  $('loginOverlay').hidden = false;
  $('loginPassword').focus();
}
function hideLogin() {
  $('loginOverlay').hidden = true;
  $('loginPassword').value = '';
}

async function loadData() {
  loaded = false;
  data = { students: [], attendance: {} };
  // بدون كلمة سر محفوظة: نعرض شاشة الدخول مباشرة
  if (!password) {
    renderAll();
    showLogin();
    return;
  }
  try {
    data = normalize(await loadStudentsFile());
    loaded = true;
    setStoredPassword(password);   // كلمة السر صحيحة: نحفظها على هذا الجهاز
    hideLogin();
    showMsg('تم تحميل البيانات');
  } catch (e) {
    if (e.code === 'unauthorized') {
      password = '';
      setStoredPassword('');
    }
    showLogin(e.message || 'تعذّر تحميل البيانات');
  }
  renderAll();
}

function logout() {
  if (dirty && !confirm('توجد تغييرات غير محفوظة وستضيع. هل تريد تسجيل الخروج؟')) return;
  dirty = false;
  saveBtn.classList.remove('pending');
  password = '';
  setStoredPassword('');
  loaded = false;
  data = { students: [], attendance: {} };
  renderAll();
  showLogin();
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
    tbody.innerHTML = '<tr><td colspan="7" class="empty">لا يوجد طلاب. أضف طالباً من النموذج أعلاه.</td></tr>';
    return;
  }
  const dayRec = data.attendance[currentDate] || {};
  tbody.innerHTML = data.students.map(s => {
    const rec = dayRec[s.id] || {};
    const selects = PERIODS.map(p => {
      const v = rec[p.key] || '';
      const opts = '<option value="">— غير مسجل —</option>' +
        STATUSES.map(st => `<option value="${st}"${st === v ? ' selected' : ''}>${st}</option>`).join('');
      return `<td><select data-id="${s.id}" data-period="${p.key}" class="${v ? 'st-' + v : ''}">${opts}</select></td>`;
    }).join('');

    const st = dayStats(s.id);
    const width = st.percent === null ? 0 : st.percent;
    const pText = st.percent === null ? 'لا توجد بيانات' : st.percent + '%';
    const c = st.counts;

    return `<tr>
      <td class="name">${esc(s.name)}</td>
      <td>${esc(s.year)}</td>
      ${selects}
      <td class="progress-cell">
        <div class="progress"><div class="progress-bar ${barColor(st.percent)}" style="width:${width}%"></div></div>
        <div class="percent">${pText}</div>
      </td>
      <td class="details">حضور <b>${c['حضور']}</b> | غياب <b>${c['غياب']}</b> | اعتذار <b>${c['اعتذار']}</b> | إجازة <b>${c['إجازة']}</b></td>
      <td><button class="btn danger" data-delete="${s.id}" title="حذف الطالب">🗑</button></td>
    </tr>`;
  }).join('');
}

function renderAll() {
  datePicker.value = currentDate;
  renderSavedDates();
  renderTable();
}

/* ===== الأحداث ===== */
datePicker.addEventListener('change', () => {
  if (!datePicker.value) return;
  currentDate = datePicker.value;
  syncReportInputs();
  renderAll();
});

savedDates.addEventListener('change', () => {
  if (!savedDates.value) return;
  currentDate = savedDates.value;
  syncReportInputs();
  renderAll();
});

// تسجيل الحضور (في الذاكرة حتى الضغط على زر الحفظ)
tbody.addEventListener('change', e => {
  const sel = e.target.closest('select[data-id]');
  if (!sel) return;
  const id = sel.dataset.id, period = sel.dataset.period, value = sel.value;
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

// حذف طالب
tbody.addEventListener('click', e => {
  const btn = e.target.closest('[data-delete]');
  if (!btn) return;
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

// حذف بيانات اليوم المختار بالكامل
$('deleteDayBtn').addEventListener('click', () => {
  if (!data.attendance[currentDate]) {
    showMsg('لا توجد بيانات مسجلة في هذا اليوم', 'err');
    return;
  }
  if (!confirm(`هل تريد حذف كل بيانات الحضور المسجلة في يوم ${currentDate}؟`)) return;
  delete data.attendance[currentDate];
  markDirty();
  renderAll();
});

// إضافة طالب
$('addForm').addEventListener('submit', e => {
  e.preventDefault();
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
    await saveStudentsFile(data);
    dirty = false;
    saveBtn.classList.remove('pending');
    showMsg('✔ تم حفظ البيانات');
  } catch (e) {
    if (e.code === 'unauthorized') {
      // تم تغيير كلمة السر: نطلب الدخول من جديد (التعديلات غير المحفوظة تبقى في الصفحة)
      password = '';
      setStoredPassword('');
      showLogin('تم تغيير كلمة السر — ادخل بالكلمة الجديدة ثم احفظ مرة أخرى');
    }
    showMsg('فشل الحفظ: ' + (e.message || 'خطأ غير معروف'), 'err');
  } finally {
    saveBtn.disabled = false;
  }
});

window.addEventListener('beforeunload', e => {
  if (dirty) { e.preventDefault(); e.returnValue = ''; }
});

// تسجيل الدخول
$('loginForm').addEventListener('submit', e => {
  e.preventDefault();
  password = $('loginPassword').value;
  $('loginError').textContent = 'جارٍ التحقق...';
  loadData();
});

$('logoutBtn').addEventListener('click', logout);

/* ===== البدء ===== */
password = getStoredPassword();
syncReportInputs();
renderAll();
loadData();
