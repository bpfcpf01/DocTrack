/* ส่งถึง — แอป พขร. (PWA)
 * - ถ่ายรูปผ่านกล้องสด (getUserMedia) เป็นหลัก ถ้าใช้ไม่ได้ fallback เป็น <input capture> และถูกติดธง NOT_LIVE_CAMERA
 * - ทุกการบันทึกเข้าคิว IndexedDB ก่อนเสมอ แล้ว sync ตามลำดับ (FIFO) → ใช้ได้แม้ไม่มีสัญญาณ
 * - client_id สร้างในเครื่อง → backend ไม่บันทึกซ้ำแม้ส่งซ้ำ
 */
(() => {
'use strict';
const CFG = window.DOCDROP_CONFIG;
const $ = s => document.querySelector(s);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : 'x' + Date.now().toString(36) + Math.random().toString(36).slice(2, 12));
const icon = n => '<svg class="ic" aria-hidden="true"><use href="#i-' + n + '"/></svg>';
const fmtTime = t => new Date(t).toLocaleString('th-TH', {timeZone: 'Asia/Bangkok', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'});
const fmtClock = t => new Date(t).toLocaleTimeString('th-TH', {timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit'}) + ' น.';
const LS = {
  get(k, d) { try { const v = localStorage.getItem('dd_' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('dd_' + k, JSON.stringify(v)); } catch (e) {} },
  del(k) { try { localStorage.removeItem('dd_' + k); } catch (e) {} },
};

const S = {
  boot: LS.get('boot', null),
  token: LS.get('token', null),
  driver: LS.get('driver', null),
  serverHand: LS.get('hand', []),
  queue: [],
  pk: {photos: []},
  dv: {photos: [], selected: new Set()},
};

/* ---------- UI helpers ---------- */
function show(id) {
  document.querySelectorAll('.screen').forEach(s => s.hidden = s.id !== id);
  window.scrollTo(0, 0);
}
function toast(m, ms) {
  const t = $('#toast'); t.textContent = m; t.classList.add('on');
  clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('on'), ms || 3200);
}
function busy(on) { $('#busy').classList.toggle('on', !!on); }

/* ---------- API ---------- */
async function api(action, body) {
  let res;
  try {
    res = await fetch(CFG.API_URL, {
      method: 'POST', redirect: 'follow',
      headers: {'Content-Type': 'text/plain;charset=utf-8'},
      body: JSON.stringify(Object.assign({action: action}, body || {})),
    });
  } catch (e) { const x = new Error('ไม่มีสัญญาณ'); x.offline = true; throw x; }
  if (!res.ok) { const x = new Error('เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ (' + res.status + ')'); x.offline = true; throw x; }
  const j = await res.json();
  if (!j.ok) { const x = new Error(j.error || 'เกิดข้อผิดพลาด'); x.code = j.code; throw x; }
  return j.data;
}

/* ---------- IndexedDB queue ---------- */
const DB = {
  _db: null,
  open() {
    if (this._db) return Promise.resolve(this._db);
    return new Promise((ok, bad) => {
      const r = indexedDB.open('docdrop', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('queue', {keyPath: 'client_id'});
      r.onsuccess = () => { this._db = r.result; ok(r.result); };
      r.onerror = () => bad(r.error);
    });
  },
  async tx(mode, fn) {
    const db = await this.open();
    return new Promise((ok, bad) => {
      const t = db.transaction('queue', mode); const st = t.objectStore('queue');
      const req = fn(st); t.oncomplete = () => ok(req && req.result); t.onerror = () => bad(t.error);
    });
  },
  all() { return this.tx('readonly', s => s.getAll()); },
  put(v) { return this.tx('readwrite', s => s.put(v)); },
  del(k) { return this.tx('readwrite', s => s.delete(k)); },
};

async function loadQueue() {
  S.queue = (await DB.all()).sort((a, b) => a.created - b.created);
}

let syncing = false;
async function sync() {
  if (syncing || !S.token) return;
  syncing = true;
  try {
    await loadQueue();
    for (const it of S.queue) {
      if (it.failed || it.driver_id !== S.driver.id) continue;
      try {
        await api(it.action, Object.assign({}, it.payload, {token: S.token}));
        await DB.del(it.client_id);
      } catch (e) {
        if (e.offline) break;
        if (e.code === 'AUTH') { toast('กรุณาเข้าสู่ระบบใหม่ — รายการที่ค้างยังอยู่ในเครื่อง'); logout(true); break; }
        it.failed = true; it.error = e.message; await DB.put(it);
        if (it.action === 'deliver') break; // ไม่ส่งรายการถัดไปจนกว่าคนจะเห็นปัญหา
      }
    }
    if (navigator.onLine) await refreshHand();
  } finally {
    syncing = false;
    await loadQueue();
    renderHome();
  }
}

async function refreshHand() {
  try {
    S.serverHand = await api('inHand', {token: S.token});
    LS.set('hand', S.serverHand);
  } catch (e) {
    if (e.code === 'AUTH') logout(true);
  }
}

async function refreshBoot() {
  try {
    S.boot = await api('bootstrap');
    LS.set('boot', S.boot);
  } catch (e) { /* ใช้ค่าที่ cache ไว้ */ }
}

/* ซองในมือ = จากเซิร์ฟเวอร์ + ที่ยังรอในคิว − ที่อยู่ในคิวส่งเข้ากล่องแล้ว */
function handList() {
  const mine = S.queue.filter(q => S.driver && q.driver_id === S.driver.id);
  const inDeliverQueue = new Set();
  mine.filter(q => q.action === 'deliver').forEach(q => q.payload.envelope_ids.forEach(id => inDeliverQueue.add(id)));
  const map = new Map();
  S.serverHand.forEach(e => map.set(e.id, Object.assign({local: false}, e)));
  mine.filter(q => q.action === 'pickup').forEach(q => {
    if (!map.has(q.client_id)) map.set(q.client_id, {
      id: q.client_id, dept_name: q.meta.dept_name, sealed: q.payload.sealed,
      captured_at: q.payload.captured_at, local: true, failed: q.failed, can_void: false,
    });
  });
  return [...map.values()].filter(e => !inDeliverQueue.has(e.id))
    .sort((a, b) => new Date(a.captured_at) - new Date(b.captured_at));
}

/* ---------- Network indicator ---------- */
function renderNet() {
  const on = navigator.onLine;
  $('#net').classList.toggle('off', !on);
  $('#netTxt').textContent = on ? 'ออนไลน์' : 'ไม่มีสัญญาณ · ใช้งานได้ปกติ';
}
addEventListener('online', () => { renderNet(); sync(); });
addEventListener('offline', renderNet);
document.addEventListener('visibilitychange', () => { if (!document.hidden) sync(); });
setInterval(() => { if (navigator.onLine && S.queue.length) sync(); }, 60000);

/* ---------- Login ---------- */
function renderLogin() {
  const drivers = (S.boot && S.boot.drivers) || [];
  $('#loginDriver').innerHTML = '<option value="">— เลือกชื่อ —</option>' + drivers.map(d => '<option value="' + esc(d.id) + '">' + esc(d.name) + '</option>').join('');
  $('#loginHint').textContent = drivers.length ? '' : 'ยังโหลดรายชื่อไม่ได้ — ต้องมีสัญญาณอินเทอร์เน็ตในการเข้าสู่ระบบครั้งแรก';
  show('scrLogin');
}
$('#btnLogin').onclick = async () => {
  const id = $('#loginDriver').value, pin = $('#loginPin').value.trim();
  if (!id || !pin) return toast('เลือกชื่อและใส่ PIN');
  busy(true);
  try {
    const r = await api('login', {driver_id: id, pin: pin});
    S.token = r.token; S.driver = r.driver;
    LS.set('token', S.token); LS.set('driver', S.driver);
    $('#loginPin').value = '';
    await refreshHand();
    goHome();
    sync();
  } catch (e) { toast(e.message); }
  finally { busy(false); }
};

function logout(keepQueue) {
  S.token = null; LS.del('token');
  if (!keepQueue) { S.driver = null; LS.del('driver'); S.serverHand = []; LS.del('hand'); }
  renderLogin();
}
$('#btnLogout').onclick = async () => {
  await loadQueue();
  if (S.queue.some(q => q.driver_id === S.driver.id)) return toast('ยังมีรายการรอส่งขึ้นระบบ — ออกจากระบบไม่ได้');
  if (confirm('ออกจากระบบ?')) logout(false);
};

/* ---------- Home ---------- */
function goHome() { renderHome(); show('scrHome'); }
function renderHome() {
  if (!S.driver) return;
  $('#meName').textContent = S.driver.name;
  if (S.boot) $('#appName').textContent = S.boot.app_name;
  const mine = S.queue.filter(q => q.driver_id === S.driver.id);
  const pending = mine.filter(q => !q.failed), failed = mine.filter(q => q.failed);
  $('#queueCard').hidden = !pending.length;
  $('#queueCount').textContent = pending.length;
  $('#failCard').hidden = !failed.length;
  $('#failCard').innerHTML = failed.map(q =>
    '<div><b>' + (q.action === 'pickup' ? 'รับซอง ' + esc(q.meta.dept_name) : 'ส่งเข้ากล่อง ' + q.payload.envelope_ids.length + ' ซอง') +
    '</b> — ' + esc(q.error) + '<br><button class="btn small" data-retry="' + esc(q.client_id) + '">ลองใหม่</button> ' +
    '<button class="btn small" data-drop="' + esc(q.client_id) + '">ลบออกจากเครื่อง</button></div>').join('<hr>');

  const hand = handList();
  $('#handCount').textContent = hand.length;
  $('#goDeliver').disabled = !hand.length;
  $('#handList').innerHTML = hand.length ? hand.map(e =>
    '<li class="' + (e.local ? 'local' : '') + '"><div class="grow"><div class="name">' + esc(e.dept_name) + '</div>' +
    '<div class="sub">' + fmtTime(e.captured_at) + ' · ' + (e.sealed ? 'ปิดผนึก' : 'ไม่ปิดผนึก') +
    (e.local ? ' <span class="pill">' + icon('upload') + 'รอส่งขึ้นระบบ</span>' : '') + '</div></div>' +
    (e.can_void ? '<button class="btn small" data-void="' + esc(e.id) + '">ยกเลิก</button>' : '') + '</li>').join('')
    : '<li class="empty">ยังไม่มีซองในมือ</li>';
}
$('#btnSync').onclick = () => { if (!navigator.onLine) return toast('ยังไม่มีสัญญาณ'); sync(); };
document.addEventListener('click', async ev => {
  const t = ev.target;
  if (t.dataset.retry) {
    const it = S.queue.find(q => q.client_id === t.dataset.retry);
    if (it) { delete it.failed; delete it.error; await DB.put(it); sync(); }
  } else if (t.dataset.drop) {
    if (!confirm('ลบรายการนี้ออกจากเครื่อง? (รายการนี้ยังไม่เคยขึ้นระบบ)')) return;
    await DB.del(t.dataset.drop); await loadQueue(); renderHome();
  } else if (t.dataset.void) {
    const reason = prompt('เหตุผลที่ยกเลิก เช่น กดผิดหน่วยงาน');
    if (!reason) return;
    busy(true);
    try { await api('voidEnvelope', {token: S.token, envelope_id: t.dataset.void, reason: reason}); await refreshHand(); renderHome(); toast('ยกเลิกแล้ว'); }
    catch (e) { toast(e.message); }
    finally { busy(false); }
  } else if (t.closest('[data-back]')) {
    goHome();
  }
});

/* ---------- Camera ---------- */
let stream = null, camResolve = null;

/* slot = {label, need[]} — need คือสิ่งที่ต้องเห็นในรูป แสดงบนหน้ากล้อง */
async function takePhoto(slot, count) {
  const label = slot.label;
  try {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('no camera api');
    stream = await navigator.mediaDevices.getUserMedia({video: {facingMode: {ideal: 'environment'}, width: {ideal: 1920}, height: {ideal: 1440}}, audio: false});
  } catch (e) {
    return filePhoto(label); // fallback: ถูกติดธงฝั่ง backend
  }
  const v = $('#camVideo');
  v.srcObject = stream;
  $('#camLabel').innerHTML = '<b>' + esc(label) + (slot.need ? ' · ต้องเห็นในรูป' : '') + '</b>' +
    (slot.need || []).map((n, i) => '<span class="need-item"><span class="mark m' + i + '"></span>' + esc(n) + '</span>').join('');
  $('#camCount').textContent = count || '';
  $('#cam').hidden = false;
  return new Promise(ok => { camResolve = ok; });
}
function stopCam() {
  if (stream) stream.getTracks().forEach(t => t.stop());
  stream = null; $('#cam').hidden = true; $('#camVideo').srcObject = null;
}
$('#camCancel').onclick = () => { stopCam(); if (camResolve) camResolve(null); camResolve = null; };
$('#camShot').onclick = () => {
  const v = $('#camVideo');
  if (!v.videoWidth) return;
  const at = Date.now();
  const data = encode(v, v.videoWidth, v.videoHeight, at);
  stopCam();
  if (camResolve) camResolve({data: data, source: 'camera', at: at});
  camResolve = null;
};

function filePhoto(label) {
  toast('เปิดกล้องในแอปไม่ได้ — ใช้กล้องของเครื่องแทน (' + label + ')');
  return new Promise(ok => {
    const inp = $('#fileFallback');
    inp.value = '';
    inp.onchange = () => {
      const f = inp.files && inp.files[0];
      if (!f) return ok(null);
      const img = new Image();
      img.onload = () => { const at = Date.now(); ok({data: encode(img, img.naturalWidth, img.naturalHeight, at), source: 'file', at: at}); URL.revokeObjectURL(img.src); };
      img.onerror = () => { toast('อ่านรูปไม่ได้'); ok(null); };
      img.src = URL.createObjectURL(f);
    };
    inp.click();
  });
}

/* ย่อรูป + ประทับเวลาเครื่อง (แสดงผลเท่านั้น หลักฐานเวลาจริงคือ server_at) */
function encode(src, w, h, at) {
  const k = Math.min(1, CFG.MAX_SIDE / Math.max(w, h));
  const cw = Math.round(w * k), ch = Math.round(h * k);
  const c = document.createElement('canvas'); c.width = cw; c.height = ch;
  const g = c.getContext('2d');
  g.drawImage(src, 0, 0, cw, ch);
  const txt = new Date(at).toLocaleString('th-TH', {timeZone: 'Asia/Bangkok'}) + ' · ' + (S.driver ? S.driver.name : '');
  const fs = Math.max(16, Math.round(cw / 40));
  g.font = '600 ' + fs + 'px sans-serif';
  const pad = fs * 0.5, tw = g.measureText(txt).width;
  g.fillStyle = 'rgba(0,0,0,.55)'; g.fillRect(0, ch - fs - pad * 2, tw + pad * 2, fs + pad * 2);
  g.fillStyle = '#fff'; g.textBaseline = 'middle'; g.fillText(txt, pad, ch - (fs + pad * 2) / 2);
  let q = CFG.JPEG_QUALITY, out = c.toDataURL('image/jpeg', q);
  while (out.length * 0.75 > CFG.MAX_BYTES && q > 0.35) { q -= 0.1; out = c.toDataURL('image/jpeg', q); }
  return out;
}

function renderShots(el, slots, photos, onChange) {
  el.innerHTML = slots.map((s, i) => photos[i]
    ? '<div class="shot"><img src="' + photos[i].data + '" alt="' + esc(s.label) + '"><button class="x" data-i="' + i + '" aria-label="ลบรูป">' + icon('x') + '</button>' +
      '<span class="shot-cap">' + icon('check') + esc(s.label) + '</span></div>'
    : '<button type="button" class="shot ' + (s.req ? 'req' : '') + '" data-i="' + i + '"><span class="ico">' + icon(s.req ? 'camera' : 'plus') + '</span>' +
      '<span class="shot-label">' + esc(s.label) + '</span><span class="hint">' + (s.req ? 'แตะเพื่อถ่าย' : '(ถ้ามี)') + '</span></button>').join('');
  el.onclick = async ev => {
    const x = ev.target.closest('.x'), shot = ev.target.closest('.shot');
    if (x) { photos.splice(Number(x.dataset.i), 1); return onChange(); }
    if (shot && shot.dataset.i != null && !photos[Number(shot.dataset.i)]) {
      if (Number(shot.dataset.i) !== photos.length) return toast('ถ่ายรูปช่องแรกก่อน');
      const p = await takePhoto(slots[Number(shot.dataset.i)], (slots[0].max || slots.length) > 1 ? (photos.length + 1) + ' / ' + (slots[0].max || slots.length) : '');
      if (p) { photos.push(p); onChange(); }
    }
  };
}

/* ---------- Pickup ---------- */
$('#goPickup').onclick = () => {
  const deps = (S.boot && S.boot.departments) || [];
  if (!deps.length) return toast('ยังไม่มีรายชื่อหน่วยงาน — ต้องมีสัญญาณครั้งแรก');
  $('#pkDept').innerHTML = '<option value="">— เลือกหน่วยงาน —</option>' + deps.map(d => '<option value="' + esc(d.id) + '">' + esc(d.name) + '</option>').join('');
  document.querySelector('input[name=pkSealed][value="1"]').checked = true;
  S.pk = {photos: []};
  renderPickup();
  show('scrPickup');
};
document.querySelectorAll('input[name=pkSealed]').forEach(r => r.onchange = renderPickup);
$('#pkDept').onchange = renderPickup;
function pkSealed() { return document.querySelector('input[name=pkSealed]:checked').value === '1'; }
function renderPickup() {
  const sealed = pkSealed();
  const slots = [{label: 'หน้าซอง', req: true, need: ['หน้าซอง เห็นชื่อหน่วยงาน']}];
  if (!sealed) slots.push({label: 'หน้าแรกเอกสาร', req: true, need: ['หน้าแรกของเอกสาร อ่านหัวเรื่องได้']});
  if (S.pk.photos.length > slots.length) S.pk.photos.length = slots.length;
  renderShots($('#pkShots'), slots, S.pk.photos, renderPickup);
  const left = slots.length - S.pk.photos.length;
  $('#pkSave').disabled = !$('#pkDept').value || left > 0;
  $('#pkNeed').textContent = !$('#pkDept').value ? 'เลือกหน่วยงานก่อน' + (left > 0 ? ' แล้วถ่ายรูป' : '')
    : left > 0 ? 'ถ่ายอีก ' + left + ' รูปจึงบันทึกได้' : '';
}
$('#pkSave').onclick = async () => {
  const dept = S.boot.departments.find(d => d.id === $('#pkDept').value);
  const item = {
    client_id: uid(), action: 'pickup', driver_id: S.driver.id, created: Date.now(),
    meta: {dept_name: dept.name},
    payload: {
      dept_id: dept.id, sealed: pkSealed(), captured_at: S.pk.photos[0].at,
      photos: S.pk.photos.map(p => ({data: p.data, source: p.source})),
    },
  };
  item.payload.client_id = item.client_id;
  await DB.put(item);
  await loadQueue();
  done('รับซองแล้ว', dept.name + ' · ' + fmtClock(Date.now()));
  sync();
};

/* ---------- Deliver ---------- */
$('#goDeliver').onclick = () => {
  const hand = handList();
  if (!hand.length) return;
  S.dv = {photos: [], selected: new Set(hand.map(e => e.id))};
  const boxes = (S.boot && S.boot.boxes) || [];
  $('#dvBoxWrap').hidden = boxes.length < 2;
  $('#dvBox').innerHTML = boxes.map(b => '<option value="' + esc(b.id) + '">' + esc(b.name) + '</option>').join('');
  renderDeliver();
  show('scrDeliver');
};
function renderDeliver() {
  const hand = handList();
  $('#dvList').innerHTML = hand.map(e =>
    '<li data-id="' + esc(e.id) + '" class="' + (e.local ? 'local ' : '') + (S.dv.selected.has(e.id) ? 'on' : '') + '"><input type="checkbox" ' + (S.dv.selected.has(e.id) ? 'checked' : '') + ' aria-label="' + esc(e.dept_name) + '">' +
    '<div class="grow"><div class="name">' + esc(e.dept_name) + '</div><div class="sub">' + fmtTime(e.captured_at) + (e.local ? ' · รอส่งขึ้นระบบ' : '') + '</div></div></li>').join('');
  $('#dvSelInfo').textContent = 'เลือก ' + S.dv.selected.size + ' / ' + hand.length + ' ซอง';
  const need = ['ป้ายกล่องบัญชี', 'หน้าซองทุกซอง'];
  const slots = [{label: 'รูปที่ 1', req: true, need: need, max: CFG.MAX_PHOTOS}];
  for (let i = 1; i < Math.min(CFG.MAX_PHOTOS, S.dv.photos.length + 1); i++) slots.push({label: 'รูปที่ ' + (i + 1), req: false, need: need});
  renderShots($('#dvShots'), slots, S.dv.photos, renderDeliver);
  $('#dvSave').disabled = !S.dv.selected.size || !S.dv.photos.length;
  $('#dvSaveTxt').textContent = S.dv.selected.size ? 'ยืนยันส่ง ' + S.dv.selected.size + ' ซองเข้ากล่อง' : 'เลือกซองอย่างน้อย 1 ซอง';
}
$('#dvList').onclick = ev => {
  const li = ev.target.closest('li[data-id]');
  if (!li) return;
  const id = li.dataset.id;
  S.dv.selected.has(id) ? S.dv.selected.delete(id) : S.dv.selected.add(id);
  renderDeliver();
};
$('#dvSave').onclick = async () => {
  const hand = handList();
  const ids = hand.filter(e => S.dv.selected.has(e.id)).map(e => e.id);
  const left = hand.length - ids.length;
  if (left && !confirm('ยังเหลือซองในมือ ' + left + ' ซองที่ไม่ได้ส่งรอบนี้ — ยืนยัน?')) return;
  const item = {
    client_id: uid(), action: 'deliver', driver_id: S.driver.id, created: Date.now(), meta: {},
    payload: {
      envelope_ids: ids, box_id: $('#dvBox').value || '', captured_at: S.dv.photos[0].at,
      photos: S.dv.photos.map(p => ({data: p.data, source: p.source})),
    },
  };
  item.payload.client_id = item.client_id;
  await DB.put(item);
  await loadQueue();
  done('ส่งเข้ากล่องแล้ว', ids.length + ' ซอง · ' + fmtClock(Date.now()), navigator.onLine ? 'ระบบกำลังส่งขึ้นระบบ และจะอีเมลแจ้งหัวหน้าอัตโนมัติ' : 'ระบบจะส่งขึ้นระบบและอีเมลแจ้งหัวหน้าให้เองเมื่อมีสัญญาณ ไม่ต้องทำซ้ำ');
  sync();
};

/* ---------- Done ---------- */
function done(title, text, wait) {
  $('#doneTitle').textContent = title;
  $('#doneText').textContent = text;
  $('#doneWait').hidden = navigator.onLine && !wait;
  $('#doneWait').lastElementChild.textContent = wait || 'ระบบจะส่งขึ้นระบบให้เองเมื่อมีสัญญาณ ไม่ต้องทำซ้ำ';
  show('scrDone');
}
$('#doneOk').onclick = goHome;

/* ---------- Boot ---------- */
(async () => {
  renderNet();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) {}
  await loadQueue();
  if (S.boot) $('#appName').textContent = S.boot.app_name;
  if (S.token && S.driver) { goHome(); refreshBoot(); sync(); }
  else { if (navigator.onLine) await refreshBoot(); renderLogin(); }
})();
})();
