/**
 * ส่งถึง (DocDrop) — Backend
 * Google Apps Script + Google Sheets + Google Drive  (บัญชีธุรการกลาง)
 *
 * Deploy 2 ครั้งจากโปรเจคเดียวกัน (รายละเอียดใน README):
 *   1) Driver API : Execute as = Me, Who has access = Anyone        → doPost (แอป พขร. เรียก)
 *   2) Admin page : Execute as = Me, Who has access = Only myself   → doGet  (Admin.html)
 *
 * หลักการด้านหลักฐาน:
 *   - เวลาอ้างอิง = เวลาเซิร์ฟเวอร์ (server_at) เก็บเวลาเครื่องไว้คู่กัน (captured_at) ห่างเกินเกณฑ์ = ติดธง
 *   - ไม่มีการลบ มีแต่ยกเลิก (VOID) พร้อมเหตุผล
 *   - admin แก้เวลา/รูป/ผู้บันทึกไม่ได้ ทุกการกระทำลง AuditLog
 *   - ส่งเข้ากล่อง = อีเมลแจ้งผู้รับทันที (หลักฐานภายนอกที่แก้ย้อนหลังไม่ได้)
 */

const APP = {
  VERSION: '1.0.0',
  TZ: 'Asia/Bangkok',
  TOKEN_DAYS: 90,
  PIN_MAX_FAIL: 5,
  PIN_LOCK_MIN: 15,
  MAX_PHOTOS: 6,
  MAX_PHOTO_BYTES: 1.5 * 1024 * 1024,
  SEARCH_LIMIT: 500,
};

const SHEETS = {
  Departments: ['id', 'name', 'active', 'created_at'],
  Drivers: ['id', 'name', 'pin_hash', 'active', 'created_at'],
  Boxes: ['id', 'name', 'active', 'created_at'],
  Recipients: ['email', 'type', 'active', 'created_at'],
  Settings: ['key', 'value'],
  Envelopes: ['id', 'driver_id', 'driver_name', 'dept_id', 'dept_name', 'sealed', 'photo_ids', 'photo_source',
    'captured_at', 'server_at', 'time_gap_min', 'flag', 'status', 'delivery_id', 'delivered_at', 'void_reason', 'note'],
  Deliveries: ['id', 'driver_id', 'driver_name', 'box_id', 'box_name', 'envelope_ids', 'envelope_count', 'photo_ids',
    'photo_source', 'captured_at', 'server_at', 'time_gap_min', 'flag', 'status', 'email_status', 'void_reason', 'note'],
  AuditLog: ['ts', 'actor', 'action', 'target', 'detail'],
};

const DEFAULT_SETTINGS = {
  app_name: 'ส่งถึง',
  flag_gap_min: '15',            // เวลาเครื่องกับเซิร์ฟเวอร์ห่างเกินกี่นาทีให้ติดธง
  driver_void_window_min: '30',  // พขร. ยกเลิกรายการตัวเองได้ภายในกี่นาที
  driver_app_url: '',            // ลิงก์แอป พขร. (GitHub Pages) ไว้แจก
};

const MASTER_PREFIX = { Departments: 'DEP', Drivers: 'DRV', Boxes: 'BOX' };
const STATUS = { IN_HAND: 'IN_HAND', DELIVERED: 'DELIVERED', VOID: 'VOID', OK: 'OK' };

/* =========================================================
 * Infra
 * ======================================================= */
function props_() { return PropertiesService.getScriptProperties(); }

function ss_() {
  const id = props_().getProperty('SHEET_ID');
  if (!id) throw err_('SETUP', 'ระบบยังไม่ได้ตั้งค่า — ให้ admin เปิดหน้า admin ก่อน');
  return SpreadsheetApp.openById(id);
}

function sheet_(name) {
  const sh = ss_().getSheetByName(name);
  if (!sh) throw err_('SETUP', 'ไม่พบชีต ' + name + ' — ให้ admin เปิดหน้า admin เพื่อตั้งค่า');
  return sh;
}

function err_(code, msg) { const e = new Error(msg || code); e.code = code; return e; }
function isTrue_(v) { return v === true || String(v).toUpperCase() === 'TRUE'; }
function safe_(v) { return (typeof v === 'string' && /^[=+\-@]/.test(v)) ? "'" + v : v; } // กันสูตรใน Sheet
function esc_(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function newId_(prefix) { return prefix + '-' + Utilities.getUuid().slice(0, 8).toUpperCase(); }
function splitIds_(s) { return String(s || '').split(',').map(x => x.trim()).filter(Boolean); }
function fmt_(d, p) { return Utilities.formatDate(new Date(d), APP.TZ, p || 'dd/MM/yyyy HH:mm'); }

/** แปลง Date → ISO และตัด _row ออก (google.script.run / JSON ส่ง Date ไม่ได้) */
function ser_(v) {
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map(ser_);
  if (v && typeof v === 'object') {
    const o = {};
    Object.keys(v).forEach(k => { if (k !== '_row') o[k] = ser_(v[k]); });
    return o;
  }
  return v;
}

function readAll_(name) {
  const values = sheet_(name).getDataRange().getValues();
  const head = values.shift() || [];
  return values.map((r, i) => {
    const o = { _row: i + 2 };
    head.forEach((k, j) => { o[k] = r[j]; });
    return o;
  });
}

function findBy_(name, key, val) { return readAll_(name).find(r => String(r[key]) === String(val)) || null; }

function append_(name, obj) {
  const h = SHEETS[name];
  sheet_(name).appendRow(h.map(k => (obj[k] === undefined ? '' : safe_(obj[k]))));
}

function updateRow_(name, row, obj) {
  const h = SHEETS[name];
  const rng = sheet_(name).getRange(row, 1, 1, h.length);
  const cur = rng.getValues()[0];
  rng.setValues([h.map((k, i) => (Object.prototype.hasOwnProperty.call(obj, k) ? safe_(obj[k]) : cur[i]))]);
}

function lockRun_(fn) {
  const l = LockService.getScriptLock();
  l.waitLock(20000);
  try { return fn(); } finally { l.releaseLock(); }
}

function audit_(actor, action, target, detail) {
  append_('AuditLog', {
    ts: new Date(), actor: actor, action: action, target: target || '',
    detail: typeof detail === 'string' ? detail : JSON.stringify(detail || {}),
  });
}

function readSettings_() {
  const out = Object.assign({}, DEFAULT_SETTINGS);
  readAll_('Settings').forEach(r => { if (r.key) out[r.key] = String(r.value); });
  return out;
}

/* =========================================================
 * Setup (เรียกอัตโนมัติเมื่อ admin เปิดหน้า admin, หรือรันมือจาก editor)
 * ======================================================= */
function setup() {
  const p = props_();
  let ss;
  if (!p.getProperty('SHEET_ID')) {
    ss = SpreadsheetApp.create('ส่งถึง - ฐานข้อมูล');
    p.setProperty('SHEET_ID', ss.getId());
  } else {
    ss = SpreadsheetApp.openById(p.getProperty('SHEET_ID'));
  }
  ss.setSpreadsheetTimeZone(APP.TZ);

  Object.keys(SHEETS).forEach(name => {
    let sh = ss.getSheetByName(name);
    if (!sh) sh = ss.insertSheet(name);
    if (sh.getLastRow() === 0) {
      sh.appendRow(SHEETS[name]);
      sh.setFrozenRows(1);
      sh.getRange(1, 1, 1, SHEETS[name].length).setFontWeight('bold');
    }
  });
  ['Sheet1', 'ชีต1'].forEach(n => {
    const s = ss.getSheetByName(n);
    if (s && ss.getSheets().length > 1) ss.deleteSheet(s);
  });

  if (!p.getProperty('TOKEN_SECRET')) p.setProperty('TOKEN_SECRET', Utilities.getUuid() + Utilities.getUuid());
  if (!p.getProperty('FOLDER_ID')) p.setProperty('FOLDER_ID', DriveApp.createFolder('ส่งถึง - รูปหลักฐาน').getId());

  const have = {};
  readAll_('Settings').forEach(r => { have[r.key] = true; });
  Object.keys(DEFAULT_SETTINGS).forEach(k => { if (!have[k]) sheet_('Settings').appendRow([k, DEFAULT_SETTINGS[k]]); });

  if (readAll_('Boxes').length === 0) {
    append_('Boxes', { id: newId_('BOX'), name: 'กล่องรับเอกสาร แผนกบัญชี', active: true, created_at: new Date() });
  }
  return true;
}

/* =========================================================
 * Auth (พขร.)
 * ======================================================= */
function pinHash_(id, pin) {
  const raw = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,
    props_().getProperty('TOKEN_SECRET') + '|' + id + '|' + pin, Utilities.Charset.UTF_8);
  return raw.map(b => ('0' + (b & 255).toString(16)).slice(-2)).join('');
}

function sign_(s) {
  return Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(s, props_().getProperty('TOKEN_SECRET')));
}

/** token ผูกกับ PIN ปัจจุบัน → admin รีเซ็ต PIN = token เก่าใช้ไม่ได้ทันที */
function makeToken_(d) {
  const payload = [d.id, Date.now() + APP.TOKEN_DAYS * 864e5, String(d.pin_hash).slice(0, 10)].join('|');
  return Utilities.base64EncodeWebSafe(payload) + '.' + sign_(payload);
}

function verifyToken_(t) {
  t = String(t || '');
  const i = t.indexOf('.');
  if (i < 0) throw err_('AUTH', 'กรุณาเข้าสู่ระบบ');
  let payload;
  try { payload = Utilities.newBlob(Utilities.base64DecodeWebSafe(t.slice(0, i))).getDataAsString(); }
  catch (e) { throw err_('AUTH', 'กรุณาเข้าสู่ระบบ'); }
  if (sign_(payload) !== t.slice(i + 1)) throw err_('AUTH', 'กรุณาเข้าสู่ระบบ');
  const parts = payload.split('|');
  if (Date.now() > Number(parts[1])) throw err_('AUTH', 'หมดอายุการเข้าสู่ระบบ');
  const d = readAll_('Drivers').find(x => x.id === parts[0]);
  if (!d || !isTrue_(d.active) || String(d.pin_hash).slice(0, 10) !== parts[2]) throw err_('AUTH', 'กรุณาเข้าสู่ระบบใหม่');
  return d;
}

/* =========================================================
 * Photos
 * ======================================================= */
function monthFolder_(d) {
  const root = DriveApp.getFolderById(props_().getProperty('FOLDER_ID'));
  const name = fmt_(d, 'yyyy-MM');
  const it = root.getFoldersByName(name);
  return it.hasNext() ? it.next() : root.createFolder(name);
}

function savePhotos_(photos, prefix, now) {
  if (!Array.isArray(photos) || photos.length < 1) throw err_('BAD', 'ต้องมีรูปอย่างน้อย 1 รูป');
  if (photos.length > APP.MAX_PHOTOS) throw err_('BAD', 'รูปเกิน ' + APP.MAX_PHOTOS + ' รูป');
  const folder = monthFolder_(now);
  return photos.map((p, i) => {
    const m = String(p && p.data || '').match(/^data:image\/(jpeg|png|webp);base64,(.+)$/);
    if (!m) throw err_('BAD', 'ไฟล์รูปไม่ถูกต้อง');
    const bytes = Utilities.base64Decode(m[2]);
    if (bytes.length > APP.MAX_PHOTO_BYTES) throw err_('BAD', 'รูปใหญ่เกินไป');
    const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
    return folder.createFile(Utilities.newBlob(bytes, 'image/' + m[1], prefix + '_' + (i + 1) + '.' + ext)).getId();
  });
}

function sourceOf_(photos) {
  return (photos || []).some(p => p && p.source !== 'camera') ? 'file' : 'camera';
}

function timeInfo_(capturedAt, now, source) {
  let cap = new Date(Number(capturedAt));
  const flags = [];
  if (isNaN(cap.getTime())) { cap = now; flags.push('NO_DEVICE_TIME'); }
  const gap = Math.round(Math.abs(now - cap) / 60000);
  if (gap > Number(readSettings_().flag_gap_min || 15)) flags.push('TIME_GAP');
  if (source !== 'camera') flags.push('NOT_LIVE_CAMERA');
  return { cap: cap, gap: gap, flag: flags.join(',') };
}

/* =========================================================
 * Driver API  (doPost, JSON ผ่าน text/plain เพื่อเลี่ยง CORS preflight)
 * ======================================================= */
function doPost(e) {
  let res;
  try {
    const req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const fn = API[req.action];
    if (!fn) throw err_('BAD_ACTION', 'ไม่รู้จักคำสั่ง');
    res = { ok: true, data: fn(req) };
  } catch (ex) {
    res = { ok: false, code: ex.code || 'ERROR', error: ex.message };
  }
  return ContentService.createTextOutput(JSON.stringify(ser_(res))).setMimeType(ContentService.MimeType.JSON);
}

const API = {
  ping() { return { version: APP.VERSION, server_time: new Date() }; },

  bootstrap() {
    const pick = r => ({ id: r.id, name: r.name });
    const act = r => isTrue_(r.active);
    return {
      app_name: readSettings_().app_name,
      departments: readAll_('Departments').filter(act).map(pick),
      drivers: readAll_('Drivers').filter(act).map(pick),
      boxes: readAll_('Boxes').filter(act).map(pick),
      server_time: new Date(),
    };
  },

  login(req) {
    const id = String(req.driver_id || '');
    const pin = String(req.pin || '');
    const cache = CacheService.getScriptCache();
    if (cache.get('lock_' + id)) throw err_('LOCKED', 'ใส่ PIN ผิดหลายครั้ง ลองใหม่ใน ' + APP.PIN_LOCK_MIN + ' นาที');
    const d = readAll_('Drivers').find(x => x.id === id && isTrue_(x.active));
    if (!d || !d.pin_hash || d.pin_hash !== pinHash_(id, pin)) {
      const n = Number(cache.get('fail_' + id) || 0) + 1;
      if (n >= APP.PIN_MAX_FAIL) {
        cache.put('lock_' + id, '1', APP.PIN_LOCK_MIN * 60);
        cache.remove('fail_' + id);
        audit_('system', 'PIN_LOCKED', id, '');
      } else {
        cache.put('fail_' + id, String(n), APP.PIN_LOCK_MIN * 60);
      }
      throw err_('BAD_PIN', 'PIN ไม่ถูกต้อง');
    }
    cache.remove('fail_' + id);
    audit_('driver:' + d.name, 'LOGIN', d.id, '');
    return { token: makeToken_(d), driver: { id: d.id, name: d.name } };
  },

  inHand(req) {
    const d = verifyToken_(req.token);
    const win = Number(readSettings_().driver_void_window_min || 30) * 60000;
    return readAll_('Envelopes')
      .filter(e => e.driver_id === d.id && e.status === STATUS.IN_HAND)
      .map(e => ({
        id: e.id, dept_id: e.dept_id, dept_name: e.dept_name, sealed: isTrue_(e.sealed),
        captured_at: e.captured_at, server_at: e.server_at,
        can_void: Date.now() - new Date(e.server_at).getTime() <= win,
      }));
  },

  /** รับซองจากหน่วยงาน — idempotent ด้วย client_id (คิวออฟไลน์ส่งซ้ำได้) */
  pickup(req) {
    const d = verifyToken_(req.token);
    const id = String(req.client_id || '');
    if (!/^[\w-]{8,64}$/.test(id)) throw err_('BAD', 'รหัสรายการไม่ถูกต้อง');
    return lockRun_(() => {
      if (findBy_('Envelopes', 'id', id)) return { id: id, duplicate: true };
      const dept = findBy_('Departments', 'id', req.dept_id);
      if (!dept) throw err_('BAD', 'ไม่พบหน่วยงาน');
      const sealed = !!req.sealed;
      const photos = req.photos || [];
      if (!sealed && photos.length < 2) throw err_('BAD', 'ซองไม่ปิดผนึก ต้องถ่ายรูปหน้าแรกของเอกสารเพิ่ม');
      const now = new Date();
      const src = sourceOf_(photos);
      const t = timeInfo_(req.captured_at, now, src);
      const photoIds = savePhotos_(photos, 'ENV_' + fmt_(now, 'yyyyMMdd-HHmmss') + '_' + id.slice(0, 8), now);
      append_('Envelopes', {
        id: id, driver_id: d.id, driver_name: d.name, dept_id: dept.id, dept_name: dept.name, sealed: sealed,
        photo_ids: photoIds.join(','), photo_source: src, captured_at: t.cap, server_at: now,
        time_gap_min: t.gap, flag: t.flag, status: STATUS.IN_HAND,
      });
      audit_('driver:' + d.name, 'PICKUP', id, { dept: dept.name, sealed: sealed, flag: t.flag });
      return { id: id, server_at: now };
    });
  },

  /** ส่งเข้ากล่อง — ผูกหลายซองกับรูปชุดเดียว แล้วอีเมลแจ้งทันที */
  deliver(req) {
    const d = verifyToken_(req.token);
    const id = String(req.client_id || '');
    if (!/^[\w-]{8,64}$/.test(id)) throw err_('BAD', 'รหัสรายการไม่ถูกต้อง');
    const result = lockRun_(() => {
      if (findBy_('Deliveries', 'id', id)) return { id: id, duplicate: true };
      const ids = (req.envelope_ids || []).map(String);
      if (!ids.length) throw err_('BAD', 'ยังไม่ได้เลือกซอง');
      const all = readAll_('Envelopes');
      const envs = ids.map(x => all.find(e => e.id === x));
      if (envs.some(x => !x)) throw err_('NOT_FOUND', 'มีซองที่ยังไม่อยู่ในระบบ (รายการรับซองอาจบันทึกไม่สำเร็จ)');
      if (envs.some(x => x.driver_id !== d.id)) throw err_('FORBIDDEN', 'มีซองที่ไม่ได้อยู่ในมือของคุณ');
      if (envs.some(x => x.status !== STATUS.IN_HAND)) throw err_('BAD', 'มีซองที่ส่งไปแล้วหรือถูกยกเลิก');
      const boxes = readAll_('Boxes');
      const box = boxes.find(b => b.id === req.box_id) || boxes.find(b => isTrue_(b.active));
      if (!box) throw err_('BAD', 'ยังไม่มีกล่องในระบบ');
      const now = new Date();
      const photos = req.photos || [];
      const src = sourceOf_(photos);
      const t = timeInfo_(req.captured_at, now, src);
      const photoIds = savePhotos_(photos, 'DEL_' + fmt_(now, 'yyyyMMdd-HHmmss') + '_' + id.slice(0, 8), now);
      const del = {
        id: id, driver_id: d.id, driver_name: d.name, box_id: box.id, box_name: box.name,
        envelope_ids: ids.join(','), envelope_count: ids.length, photo_ids: photoIds.join(','), photo_source: src,
        captured_at: t.cap, server_at: now, time_gap_min: t.gap, flag: t.flag, status: STATUS.OK, email_status: 'PENDING',
      };
      append_('Deliveries', del);
      envs.forEach(e => updateRow_('Envelopes', e._row, { status: STATUS.DELIVERED, delivery_id: id, delivered_at: now }));
      audit_('driver:' + d.name, 'DELIVER', id, { box: box.name, count: ids.length, flag: t.flag });
      return { id: id, server_at: now, del: del, envs: envs, photoIds: photoIds };
    });
    if (result.duplicate) return result;
    const status = sendDeliveryEmail_(result.del, result.envs, result.photoIds);
    lockRun_(() => {
      const row = findBy_('Deliveries', 'id', id);
      if (row) updateRow_('Deliveries', row._row, { email_status: status });
    });
    return { id: id, server_at: result.server_at, email_status: status };
  },

  /** พขร. ยกเลิกรายการรับซองของตัวเอง (เฉพาะที่ยังอยู่ในมือ และภายในเวลาที่กำหนด) */
  voidEnvelope(req) {
    const d = verifyToken_(req.token);
    const reason = String(req.reason || '').trim();
    if (reason.length < 3) throw err_('BAD', 'กรุณาระบุเหตุผล');
    return lockRun_(() => {
      const e = findBy_('Envelopes', 'id', req.envelope_id);
      if (!e || e.driver_id !== d.id) throw err_('NOT_FOUND', 'ไม่พบรายการ');
      if (e.status !== STATUS.IN_HAND) throw err_('BAD', 'ยกเลิกได้เฉพาะซองที่ยังอยู่ในมือ');
      const win = Number(readSettings_().driver_void_window_min || 30);
      if (Date.now() - new Date(e.server_at).getTime() > win * 60000) {
        throw err_('BAD', 'ยกเลิกได้ภายใน ' + win + ' นาทีหลังบันทึก — ติดต่อ admin');
      }
      updateRow_('Envelopes', e._row, { status: STATUS.VOID, void_reason: reason });
      audit_('driver:' + d.name, 'VOID_ENVELOPE', e.id, { reason: reason });
      return { id: e.id };
    });
  },
};

/* =========================================================
 * Email
 * ======================================================= */
function sendDeliveryEmail_(del, envs, photoIds) {
  try {
    const rec = readAll_('Recipients').filter(r => isTrue_(r.active) && r.email);
    const to = rec.filter(r => r.type !== 'cc').map(r => r.email).join(',');
    const cc = rec.filter(r => r.type === 'cc').map(r => r.email).join(',');
    if (!to) return 'NO_RECIPIENT';
    const s = readSettings_();
    const subject = '[' + s.app_name + '] ' + del.driver_name + ' ส่ง ' + envs.length + ' ซอง เข้า' + del.box_name + ' ' + fmt_(del.server_at);
    const rows = envs.map((e, i) =>
      '<tr><td>' + (i + 1) + '</td><td>' + esc_(e.dept_name) + '</td><td>' + (isTrue_(e.sealed) ? 'ปิดผนึก' : 'ไม่ปิดผนึก') +
      '</td><td>' + fmt_(e.server_at) + '</td><td>' + esc_(e.id.slice(0, 8)) + '</td></tr>').join('');
    const inline = {};
    const imgs = photoIds.map((pid, i) => {
      inline['p' + i] = DriveApp.getFileById(pid).getBlob();
      return '<img src="cid:p' + i + '" style="max-width:100%;margin:6px 0;border:1px solid #ccc">';
    }).join('');
    const warn = del.flag
      ? '<p style="color:#b45309"><b>หมายเหตุระบบ:</b> ' + esc_(del.flag) + ' (เวลาเครื่องห่างจากเวลาเซิร์ฟเวอร์ ' + del.time_gap_min + ' นาที)</p>'
      : '';
    const html =
      '<div style="font-family:Tahoma,sans-serif;font-size:14px">' +
      '<p>บันทึกการส่งเอกสารเข้ากล่อง</p>' +
      '<p><b>พขร.:</b> ' + esc_(del.driver_name) + '<br><b>กล่อง:</b> ' + esc_(del.box_name) +
      '<br><b>เวลา (เซิร์ฟเวอร์):</b> ' + fmt_(del.server_at, 'dd/MM/yyyy HH:mm:ss') +
      '<br><b>จำนวน:</b> ' + envs.length + ' ซอง<br><b>เลขรายการ:</b> ' + esc_(del.id) + '</p>' + warn +
      '<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse">' +
      '<tr><th>#</th><th>หน่วยงาน</th><th>สภาพซอง</th><th>เวลารับซอง</th><th>รหัส</th></tr>' + rows + '</table>' +
      '<p><b>รูปตอนส่งเข้ากล่อง</b></p>' + imgs +
      '<p style="color:#666;font-size:12px">อีเมลนี้ส่งอัตโนมัติจากระบบ ' + esc_(s.app_name) + '</p></div>';
    const opt = { to: to, subject: subject, htmlBody: html, inlineImages: inline, name: s.app_name };
    if (cc) opt.cc = cc;
    MailApp.sendEmail(opt);
    return 'SENT';
  } catch (e) {
    return 'ERROR: ' + e.message;
  }
}

/* =========================================================
 * Admin (หน้า Admin.html เรียกผ่าน google.script.run)
 * ======================================================= */
function doGet() {
  if (!isAdmin_()) {
    return HtmlService.createHtmlOutput('<p style="font-family:sans-serif;padding:24px">ไม่มีสิทธิ์เข้าถึงหน้านี้</p>');
  }
  return HtmlService.createHtmlOutputFromFile('Admin')
    .setTitle('ส่งถึง — Admin')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function isAdmin_() {
  const a = Session.getActiveUser().getEmail();
  return !!a && a === Session.getEffectiveUser().getEmail();
}
function requireAdmin_() { if (!isAdmin_()) throw new Error('ไม่มีสิทธิ์'); }
function adminActor_() { return 'admin:' + Session.getActiveUser().getEmail(); }

function adminState_() {
  const norm = r => Object.assign({}, r, { active: isTrue_(r.active) });
  return ser_({
    version: APP.VERSION,
    settings: readSettings_(),
    departments: readAll_('Departments').map(norm),
    drivers: readAll_('Drivers').map(d => ({ id: d.id, name: d.name, active: isTrue_(d.active), has_pin: !!d.pin_hash, created_at: d.created_at })),
    boxes: readAll_('Boxes').map(norm),
    recipients: readAll_('Recipients').map(norm),
    sheet_url: ss_().getUrl(),
    folder_url: DriveApp.getFolderById(props_().getProperty('FOLDER_ID')).getUrl(),
    admin: Session.getEffectiveUser().getEmail(),
  });
}

function adminInit() { requireAdmin_(); setup(); return adminState_(); }

function saveMaster_(table, o, extra) {
  const name = String(o.name || '').trim();
  if (!name) throw new Error('กรุณาใส่ชื่อ');
  const active = o.active !== false;
  const rows = readAll_(table);
  if (rows.some(r => r.id !== o.id && String(r.name).trim() === name && isTrue_(r.active))) throw new Error('ชื่อนี้มีอยู่แล้ว');
  if (o.id) {
    const r = rows.find(x => x.id === o.id);
    if (!r) throw new Error('ไม่พบรายการ');
    updateRow_(table, r._row, Object.assign({ name: name, active: active }, extra || {}));
    audit_(adminActor_(), 'UPDATE_' + table, o.id, { before: { name: r.name, active: isTrue_(r.active) }, after: { name: name, active: active } });
    return o.id;
  }
  const id = newId_(MASTER_PREFIX[table]);
  append_(table, Object.assign({ id: id, name: name, active: active, created_at: new Date() }, extra || {}));
  audit_(adminActor_(), 'CREATE_' + table, id, { name: name });
  return id;
}

function adminSaveDepartment(o) { requireAdmin_(); lockRun_(() => saveMaster_('Departments', o)); return adminState_(); }
function adminSaveBox(o) { requireAdmin_(); lockRun_(() => saveMaster_('Boxes', o)); return adminState_(); }

function adminSaveDriver(o) {
  requireAdmin_();
  lockRun_(() => {
    const pin = o.pin ? String(o.pin) : '';
    if (pin && !/^\d{4,6}$/.test(pin)) throw new Error('PIN ต้องเป็นตัวเลข 4–6 หลัก');
    if (!o.id && !pin) throw new Error('พขร. ใหม่ต้องตั้ง PIN');
    const id = saveMaster_('Drivers', o);
    if (pin) {
      const r = findBy_('Drivers', 'id', id);
      updateRow_('Drivers', r._row, { pin_hash: pinHash_(id, pin) });
      audit_(adminActor_(), 'SET_PIN', id, '');
    }
  });
  return adminState_();
}

function adminSaveRecipient(o) {
  requireAdmin_();
  lockRun_(() => {
    const email = String(o.email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('อีเมลไม่ถูกต้อง');
    const type = o.type === 'cc' ? 'cc' : 'to';
    const active = o.active !== false;
    const r = readAll_('Recipients').find(x => String(x.email).toLowerCase() === email);
    if (r) {
      updateRow_('Recipients', r._row, { type: type, active: active });
      audit_(adminActor_(), 'UPDATE_Recipients', email, { type: type, active: active });
    } else {
      append_('Recipients', { email: email, type: type, active: active, created_at: new Date() });
      audit_(adminActor_(), 'CREATE_Recipients', email, { type: type });
    }
  });
  return adminState_();
}

function adminSaveSettings(o) {
  requireAdmin_();
  lockRun_(() => {
    const rows = readAll_('Settings');
    Object.keys(DEFAULT_SETTINGS).forEach(k => {
      if (o[k] === undefined) return;
      let v = String(o[k]).trim();
      if ((k === 'flag_gap_min' || k === 'driver_void_window_min') && !/^\d{1,4}$/.test(v)) throw new Error(k + ' ต้องเป็นตัวเลข');
      if (k === 'app_name' && !v) v = DEFAULT_SETTINGS.app_name;
      const r = rows.find(x => x.key === k);
      if (r && String(r.value) === v) return;
      if (r) updateRow_('Settings', r._row, { value: v }); else append_('Settings', { key: k, value: v });
      audit_(adminActor_(), 'UPDATE_SETTING', k, { before: r ? r.value : '', after: v });
    });
  });
  return adminState_();
}

/** f: {from:'yyyy-MM-dd', to:'yyyy-MM-dd', dept_id, driver_id, status, flagged:bool} */
function adminSearch(f) {
  requireAdmin_();
  f = f || {};
  const from = f.from ? new Date(f.from + 'T00:00:00+07:00') : null;
  const to = f.to ? new Date(f.to + 'T23:59:59+07:00') : null;
  const dels = {};
  readAll_('Deliveries').forEach(d => { dels[d.id] = d; });
  let rows = readAll_('Envelopes').filter(e => {
    const t = new Date(e.server_at);
    if (from && t < from) return false;
    if (to && t > to) return false;
    if (f.dept_id && e.dept_id !== f.dept_id) return false;
    if (f.driver_id && e.driver_id !== f.driver_id) return false;
    if (f.status && e.status !== f.status) return false;
    if (f.flagged && !e.flag && !(dels[e.delivery_id] && dels[e.delivery_id].flag)) return false;
    return true;
  });
  rows.sort((a, b) => new Date(b.server_at) - new Date(a.server_at));
  const total = rows.length;
  rows = rows.slice(0, APP.SEARCH_LIMIT).map(e => {
    const d = e.delivery_id && dels[e.delivery_id];
    return Object.assign({}, e, {
      sealed: isTrue_(e.sealed),
      photo_ids: splitIds_(e.photo_ids),
      delivery: d ? Object.assign({}, d, { photo_ids: splitIds_(d.photo_ids), envelope_ids: splitIds_(d.envelope_ids) }) : null,
    });
  });
  return ser_({ total: total, limit: APP.SEARCH_LIMIT, rows: rows });
}

/** ยกเลิก (ไม่ลบ) — ยกเลิกรอบส่ง = ซองในรอบนั้นกลับเป็น "อยู่ในมือ" */
function adminVoid(o) {
  requireAdmin_();
  const reason = String(o.reason || '').trim();
  if (reason.length < 3) throw new Error('กรุณาระบุเหตุผล');
  lockRun_(() => {
    if (o.type === 'delivery') {
      const d = findBy_('Deliveries', 'id', o.id);
      if (!d || d.status === STATUS.VOID) throw new Error('ไม่พบรายการ หรือถูกยกเลิกแล้ว');
      updateRow_('Deliveries', d._row, { status: STATUS.VOID, void_reason: reason });
      readAll_('Envelopes').filter(e => e.delivery_id === d.id && e.status === STATUS.DELIVERED)
        .forEach(e => updateRow_('Envelopes', e._row, { status: STATUS.IN_HAND, delivery_id: '', delivered_at: '' }));
      audit_(adminActor_(), 'VOID_DELIVERY', d.id, { reason: reason, envelopes: d.envelope_ids });
    } else {
      const e = findBy_('Envelopes', 'id', o.id);
      if (!e || e.status === STATUS.VOID) throw new Error('ไม่พบรายการ หรือถูกยกเลิกแล้ว');
      updateRow_('Envelopes', e._row, { status: STATUS.VOID, void_reason: reason });
      audit_(adminActor_(), 'VOID_ENVELOPE', e.id, { reason: reason, before_status: e.status });
    }
  });
  return true;
}

function adminAddNote(o) {
  requireAdmin_();
  const note = String(o.note || '').trim();
  const table = o.type === 'delivery' ? 'Deliveries' : 'Envelopes';
  lockRun_(() => {
    const r = findBy_(table, 'id', o.id);
    if (!r) throw new Error('ไม่พบรายการ');
    updateRow_(table, r._row, { note: note });
    audit_(adminActor_(), 'NOTE_' + table, o.id, { before: r.note, after: note });
  });
  return true;
}

function adminResendEmail(deliveryId) {
  requireAdmin_();
  const d = findBy_('Deliveries', 'id', deliveryId);
  if (!d) throw new Error('ไม่พบรายการ');
  const ids = splitIds_(d.envelope_ids);
  const envs = readAll_('Envelopes').filter(e => ids.indexOf(e.id) >= 0);
  const status = sendDeliveryEmail_(d, envs, splitIds_(d.photo_ids));
  lockRun_(() => updateRow_('Deliveries', findBy_('Deliveries', 'id', deliveryId)._row, { email_status: status }));
  audit_(adminActor_(), 'RESEND_EMAIL', deliveryId, status);
  return status;
}

function adminAudit(limit) {
  requireAdmin_();
  const rows = readAll_('AuditLog');
  return ser_(rows.slice(-Math.min(Number(limit) || 300, 2000)).reverse());
}
