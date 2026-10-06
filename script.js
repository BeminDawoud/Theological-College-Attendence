/* =====================================================================
   طبقة التخزين — الربط الوحيد مع ملف students.json
   ===================================================================== */

// قراءة البيانات من ملف students.json
async function loadStudentsFile() {
  const res = await fetch('students.json?t=' + Date.now(), { cache: 'no-store' });
  if (!res.ok) throw new Error('تعذّر تحميل students.json');
  return res.json();
}

// تخزين مقبض الملف في المتصفح حتى لا نطلب اختيار الملف في كل مرة
function kvDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('attendance-app', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function kvGet(key) {
  try {
    const db = await kvDb();
    return await new Promise(res => {
      const r = db.transaction('kv').objectStore('kv').get(key);
      r.onsuccess = () => res(r.result);
      r.onerror = () => res(undefined);
    });
  } catch (e) { return undefined; }
}
async function kvSet(key, value) {
  try {
    const db = await kvDb();
    await new Promise(res => {
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put(value, key);
      tx.oncomplete = tx.onerror = () => res();
    });
  } catch (e) { /* تجاهل */ }
}

let fileHandle = null;

// الحصول على إذن الكتابة في ملف students.json (يجب أن تُستدعى من نقرة زر)
async function getWritableHandle() {
  if (!fileHandle) fileHandle = await kvGet('students-file');
  if (fileHandle) {
    let perm = await fileHandle.queryPermission({ mode: 'readwrite' });
    if (perm !== 'granted') perm = await fileHandle.requestPermission({ mode: 'readwrite' });
    if (perm === 'granted') return fileHandle;
    fileHandle = null;
  }
  // أول مرة: اختر ملف students.json الموجود في مجلد الموقع
  const [h] = await window.showOpenFilePicker({
    multiple: false,
    types: [{ description: 'ملف البيانات students.json', accept: { 'application/json': ['.json'] } }]
  });
  if (h.name !== 'students.json') throw new Error('اختر ملف students.json');
  if ((await h.requestPermission({ mode: 'readwrite' })) !== 'granted') throw new Error('لم يتم السماح بالكتابة في الملف');
  fileHandle = h;
  await kvSet('students-file', h);
  return h;
}

// كتابة البيانات في ملف students.json (استبدال محتواه مباشرة، بدون تنزيل أي ملف)
async function saveStudentsFile(data) {
  if (!window.showOpenFilePicker) {
    throw new Error(window.isSecureContext
      ? 'هذا المتصفح لا يدعم الكتابة المباشرة في الملف — استخدم Chrome أو Edge على الكمبيوتر'
      : 'الصفحة مفتوحة بعنوان غير آمن — افتحها عبر https أو localhost أو كملف مباشرة');
  }
  const h = await getWritableHandle();
  const w = await h.createWritable();
  await w.write(JSON.stringify(data, null, 2));
  await w.close();
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
async function loadData() {
  try {
    data = normalize(await loadStudentsFile());
    loaded = true;
    showMsg('تم تحميل البيانات');
  } catch (e) {
    data = { students: [], attendance: {} };
    showMsg(e.message || 'تعذّر تحميل البيانات', 'err');
  }
  renderAll();
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
    showMsg('✔ تم حفظ البيانات في students.json');
  } catch (e) {
    showMsg(e.name === 'AbortError' ? 'تم إلغاء اختيار الملف — لم يتم الحفظ' : 'فشل الحفظ: ' + (e.message || 'خطأ غير معروف'), 'err');
  } finally {
    saveBtn.disabled = false;
  }
});

window.addEventListener('beforeunload', e => {
  if (dirty) { e.preventDefault(); e.returnValue = ''; }
});

/* ===== البدء ===== */
syncReportInputs();
renderAll();
loadData();
