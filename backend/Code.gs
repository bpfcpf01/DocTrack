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
  VERSION: '1.1.0',
  TZ: 'Asia/Bangkok',
  TOKEN_DAYS: 90,
  PIN_MAX_FAIL: 5,
  PIN_LOCK_MIN: 15,
  MAX_PHOTOS: 6,
  MAX_PHOTO_BYTES: 1.5 * 1024 * 1024,
  SEARCH_LIMIT: 500,
};

const SHEETS = {
  Departments: ['id', 'name', 'active', 'created_at', 'email'],
  Drivers: ['id', 'name', 'pin_hash', 'active', 'created_at'],
  Boxes: ['id', 'name', 'active', 'created_at'],
  Recipients: ['email', 'type', 'active', 'created_at'],
  Settings: ['key', 'value'],
  Envelopes: ['id', 'driver_id', 'driver_name', 'dept_id', 'dept_name', 'sealed', 'photo_ids', 'photo_source',
    'captured_at', 'server_at', 'time_gap_min', 'flag', 'status', 'delivery_id', 'delivered_at', 'void_reason', 'note'],
  Deliveries: ['id', 'driver_id', 'driver_name', 'box_id', 'box_name', 'envelope_ids', 'envelope_count', 'photo_ids',
    'photo_source', 'captured_at', 'server_at', 'time_gap_min', 'flag', 'status', 'email_status', 'void_reason', 'note',
    'dept_email_status'],
  AuditLog: ['ts', 'actor', 'action', 'target', 'detail'],
};

const DEFAULT_SETTINGS = {
  app_name: 'ส่งถึง',
  flag_gap_min: '15',            // เวลาเครื่องกับเซิร์ฟเวอร์ห่างเกินกี่นาทีให้ติดธง
  driver_void_window_min: '30',  // พขร. ยกเลิกรายการตัวเองได้ภายในกี่นาที
  driver_app_url: '',            // ลิงก์แอป พขร. (GitHub Pages) ไว้แจก
  daily_summary_hour: '17',      // ส่งอีเมลสรุปรายวันตอนกี่โมง (0–23) — ว่าง = ปิด
  stale_hours: '8',              // แจ้งเตือนเมื่อซองค้างในมือเกินกี่ชั่วโมง — 0 = ปิด
};

/**
 * Google Sheet ที่ใช้เป็นฐานข้อมูล — ว่าง = ให้ setup() สร้างไฟล์ใหม่ให้
 * บัญชีที่รัน Apps Script ต้องมีสิทธิ์แก้ไขชีตนี้
 */
const PRESET_SHEET_ID = '1ZdlxDI2bNskQr4g3EVW7egjsJNY51D_oSeXYphsY05Q';

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
    ss = PRESET_SHEET_ID ? SpreadsheetApp.openById(PRESET_SHEET_ID) : SpreadsheetApp.create('ส่งถึง - ฐานข้อมูล');
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
    } else {
      // เวอร์ชันใหม่เพิ่มคอลัมน์ต่อท้ายเท่านั้น → เติม header ที่ขาด (ข้อมูลเดิมไม่ขยับ)
      const head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
      const want = SHEETS[name];
      if (head.length < want.length && head.every((h, i) => h === want[i])) {
        sh.getRange(1, head.length + 1, 1, want.length - head.length).setValues([want.slice(head.length)]).setFontWeight('bold');
      }
    }
  });
  ['Sheet1', 'ชีต1'].forEach(n => {
    const s = ss.getSheetByName(n);
    if (s && s.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(s); // ลบเฉพาะชีตเปล่าที่ติดมากับไฟล์
  });

  if (!p.getProperty('TOKEN_SECRET')) p.setProperty('TOKEN_SECRET', Utilities.getUuid() + Utilities.getUuid());
  if (!p.getProperty('FOLDER_ID')) p.setProperty('FOLDER_ID', DriveApp.createFolder('ส่งถึง - รูปหลักฐาน').getId());

  const have = {};
  readAll_('Settings').forEach(r => { have[r.key] = true; });
  Object.keys(DEFAULT_SETTINGS).forEach(k => { if (!have[k]) sheet_('Settings').appendRow([k, DEFAULT_SETTINGS[k]]); });

  if (readAll_('Boxes').length === 0) {
    append_('Boxes', { id: newId_('BOX'), name: 'กล่องรับเอกสาร แผนกบัญชี', active: true, created_at: new Date() });
  }
  ensureTriggers_();
  return true;
}

/** ตั้ง time-driven trigger รายชั่วโมง (สรุปรายวัน + แจ้งซองค้าง) ครั้งเดียว */
function ensureTriggers_() {
  if (ScriptApp.getProjectTriggers().some(t => t.getHandlerFunction() === 'hourlyJob')) return;
  ScriptApp.newTrigger('hourlyJob').timeBased().everyHours(1).create();
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
    const deptStatus = sendDeptEmails_(result.del, result.envs, result.photoIds);
    lockRun_(() => {
      const row = findBy_('Deliveries', 'id', id);
      if (row) updateRow_('Deliveries', row._row, { email_status: status, dept_email_status: deptStatus });
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
    const rcp = recipients_();
    const to = rcp.to, cc = rcp.cc;
    if (!to) return 'NO_RECIPIENT';
    const s = readSettings_();
    const subject = '[' + s.app_name + '] ' + del.driver_name + ' ส่ง ' + envs.length + ' ซอง เข้า' + del.box_name + ' ' + fmt_(del.server_at);
    const rows = envs.map((e, i) =>
      '<tr><td>' + (i + 1) + '</td><td>' + esc_(e.dept_name) + '</td><td>' + (isTrue_(e.sealed) ? 'ปิดผนึก' : 'ไม่ปิดผนึก') +
      '</td><td>' + fmt_(e.server_at) + '</td><td>' + esc_(e.id.slice(0, 8)) + '</td></tr>').join('');
    const inline = {};
    const imgs = photoImgs_(photoIds, inline, 'p');
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

function recipients_() {
  const rec = readAll_('Recipients').filter(r => isTrue_(r.active) && r.email);
  return {
    to: rec.filter(r => r.type !== 'cc').map(r => r.email).join(','),
    cc: rec.filter(r => r.type === 'cc').map(r => r.email).join(','),
  };
}

function photoImgs_(photoIds, inline, prefix) {
  return photoIds.map((pid, i) => {
    inline[prefix + i] = DriveApp.getFileById(pid).getBlob();
    return '<img src="cid:' + prefix + i + '" style="max-width:100%;margin:6px 0;border:1px solid #ccc">';
  }).join('');
}

/**
 * แจ้งหน่วยงานต้นทางว่าซองของเขาถึงกล่องแล้ว (เฉพาะหน่วยงานที่ใส่อีเมลไว้)
 * คืน 'NONE' | 'SENT:<จำนวนหน่วยงาน>' | 'ERROR: …' (ส่งได้บางส่วนจะรวมไว้ในข้อความ)
 */
function sendDeptEmails_(del, envs, photoIds) {
  try {
    const depts = readAll_('Departments').filter(d => isTrue_(d.active) && String(d.email || '').trim());
    const groups = {};
    envs.forEach(e => {
      const dep = depts.find(d => d.id === e.dept_id);
      if (dep) (groups[dep.id] = groups[dep.id] || { dep: dep, envs: [] }).envs.push(e);
    });
    const list = Object.keys(groups).map(k => groups[k]);
    if (!list.length) return 'NONE';
    const s = readSettings_();
    const errors = [];
    let sent = 0;
    list.forEach(g => {
      try {
        const inline = {};
        const rows = g.envs.map((e, i) =>
          '<tr><td>' + (i + 1) + '</td><td>' + (isTrue_(e.sealed) ? 'ปิดผนึก' : 'ไม่ปิดผนึก') + '</td><td>' + fmt_(e.server_at) +
          '</td><td>' + esc_(e.id.slice(0, 8)) + '</td></tr>').join('');
        const html =
          '<div style="font-family:Tahoma,sans-serif;font-size:14px">' +
          '<p>เรียน ' + esc_(g.dep.name) + '</p>' +
          '<p>ซองเอกสารจากหน่วยงานของท่าน <b>' + g.envs.length + ' ซอง</b> ถูกนำเข้า<b>' + esc_(del.box_name) + '</b> แล้ว<br>' +
          '<b>เวลา (เซิร์ฟเวอร์):</b> ' + fmt_(del.server_at, 'dd/MM/yyyy HH:mm:ss') + '<br><b>พขร.:</b> ' + esc_(del.driver_name) +
          '<br><b>เลขรายการ:</b> ' + esc_(del.id) + '</p>' +
          '<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse">' +
          '<tr><th>#</th><th>สภาพซอง</th><th>เวลารับซอง</th><th>รหัส</th></tr>' + rows + '</table>' +
          '<p><b>รูปตอนส่งเข้ากล่อง</b></p>' + photoImgs_(photoIds, inline, 'p') +
          '<p style="color:#666;font-size:12px">อีเมลนี้ส่งอัตโนมัติจากระบบ ' + esc_(s.app_name) + ' ไม่ต้องตอบกลับ</p></div>';
        MailApp.sendEmail({
          to: String(g.dep.email).trim(), name: s.app_name, htmlBody: html, inlineImages: inline,
          subject: '[' + s.app_name + '] ซองจาก ' + g.dep.name + ' ' + g.envs.length + ' ซอง ถึง' + del.box_name + ' แล้ว ' + fmt_(del.server_at),
        });
        sent++;
      } catch (e) {
        errors.push(g.dep.name + ': ' + e.message);
      }
    });
    return errors.length ? 'ERROR: ' + errors.join(' | ') + (sent ? ' (ส่งได้ ' + sent + ')' : '') : 'SENT:' + sent;
  } catch (e) {
    return 'ERROR: ' + e.message;
  }
}

/* =========================================================
 * งานตามเวลา (trigger รายชั่วโมง ตั้งโดย setup → ensureTriggers_)
 * ======================================================= */
function hourlyJob() {
  const s = readSettings_();
  const now = new Date();
  const hour = Number(fmt_(now, 'H'));
  if (s.daily_summary_hour !== '' && Number(s.daily_summary_hour) === hour) {
    const today = fmt_(now, 'yyyy-MM-dd');
    if (props_().getProperty('SUMMARY_SENT') !== today) {
      const r = sendDailySummary_(now);
      props_().setProperty('SUMMARY_SENT', today);
      audit_('system', 'DAILY_SUMMARY', today, r);
    }
  }
  if (Number(s.stale_hours) > 0) staleAlert_(now, Number(s.stale_hours));
}

/** สรุปของวันนี้ (ตามเวลาไทย) ส่งถึงผู้รับแจ้งทุกคน — ไม่มีความเคลื่อนไหวและไม่มีซองค้าง = ไม่ส่ง */
function sendDailySummary_(now) {
  const day = fmt_(now, 'yyyy-MM-dd');
  const isToday = d => d && fmt_(d, 'yyyy-MM-dd') === day;
  const envs = readAll_('Envelopes');
  const picked = envs.filter(e => isToday(e.server_at));
  const dels = readAll_('Deliveries').filter(d => isToday(d.server_at) && d.status !== STATUS.VOID);
  const inHand = envs.filter(e => e.status === STATUS.IN_HAND);
  const flagged = picked.filter(e => e.flag).length + dels.filter(d => d.flag).length;
  const mailErr = dels.filter(d => d.email_status !== 'SENT').length;
  if (!picked.length && !dels.length && !inHand.length) return 'SKIP_EMPTY';
  const rcp = recipients_();
  if (!rcp.to) return 'NO_RECIPIENT';
  const s = readSettings_();
  const byDriver = {};
  inHand.forEach(e => { (byDriver[e.driver_name] = byDriver[e.driver_name] || []).push(e); });
  const handRows = Object.keys(byDriver).map(n =>
    '<tr><td>' + esc_(n) + '</td><td>' + byDriver[n].length + '</td><td>' +
    byDriver[n].map(e => esc_(e.dept_name) + ' (' + fmt_(e.server_at, 'dd/MM HH:mm') + ')').join(', ') + '</td></tr>').join('');
  const delRows = dels.map(d =>
    '<tr><td>' + fmt_(d.server_at, 'HH:mm') + '</td><td>' + esc_(d.driver_name) + '</td><td>' + esc_(d.box_name) +
    '</td><td>' + d.envelope_count + '</td><td>' + esc_(d.email_status) + (d.flag ? ' · ' + esc_(d.flag) : '') + '</td></tr>').join('');
  const tbl = (head, body) => '<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse"><tr>' +
    head.map(h => '<th>' + h + '</th>').join('') + '</tr>' + body + '</table>';
  const html =
    '<div style="font-family:Tahoma,sans-serif;font-size:14px">' +
    '<p><b>สรุปวันที่ ' + fmt_(now, 'dd/MM/yyyy') + '</b></p>' +
    '<p>รับซอง ' + picked.length + ' ซอง · ส่งเข้ากล่อง ' + dels.length + ' รอบ (' +
    dels.reduce((n, d) => n + Number(d.envelope_count || 0), 0) + ' ซอง) · ค้างในมือ ' + inHand.length + ' ซอง' +
    (flagged ? ' · ติดธง ' + flagged + ' รายการ' : '') + (mailErr ? ' · <b style="color:#b45309">อีเมลส่งไม่สำเร็จ ' + mailErr + ' รอบ</b>' : '') + '</p>' +
    (dels.length ? '<p><b>รอบส่งเข้ากล่องวันนี้</b></p>' + tbl(['เวลา', 'พขร.', 'กล่อง', 'ซอง', 'อีเมล/ธง'], delRows) : '') +
    (inHand.length ? '<p><b>ซองที่ยังอยู่ในมือ</b></p>' + tbl(['พขร.', 'จำนวน', 'หน่วยงาน (เวลารับ)'], handRows) : '') +
    '<p style="color:#666;font-size:12px">อีเมลนี้ส่งอัตโนมัติจากระบบ ' + esc_(s.app_name) + ' · ดูรายละเอียดในหน้า admin</p></div>';
  const opt = { to: rcp.to, subject: '[' + s.app_name + '] สรุปประจำวัน ' + fmt_(now, 'dd/MM/yyyy'), htmlBody: html, name: s.app_name };
  if (rcp.cc) opt.cc = rcp.cc;
  try { MailApp.sendEmail(opt); return 'SENT'; } catch (e) { return 'ERROR: ' + e.message; }
}

/** แจ้งซองที่ค้างในมือเกินกำหนด — แต่ละซองแจ้งครั้งเดียว (จำไว้ใน Script Properties) */
function staleAlert_(now, hours) {
  const limit = hours * 3600000;
  const stale = readAll_('Envelopes').filter(e => e.status === STATUS.IN_HAND && now - new Date(e.server_at) > limit);
  let seen = [];
  try { seen = JSON.parse(props_().getProperty('STALE_ALERTED') || '[]'); } catch (e) { seen = []; }
  const fresh = stale.filter(e => seen.indexOf(e.id) < 0);
  const keep = stale.map(e => e.id); // ซองที่ส่งแล้ว/ยกเลิกแล้วหลุดออกจากรายการจำ
  if (!fresh.length) { props_().setProperty('STALE_ALERTED', JSON.stringify(keep)); return 'NONE'; }
  const rcp = recipients_();
  if (!rcp.to) return 'NO_RECIPIENT';
  const s = readSettings_();
  const rows = fresh.map(e =>
    '<tr><td>' + esc_(e.driver_name) + '</td><td>' + esc_(e.dept_name) + '</td><td>' + fmt_(e.server_at) +
    '</td><td>' + Math.floor((now - new Date(e.server_at)) / 3600000) + ' ชม.</td><td>' + esc_(e.id.slice(0, 8)) + '</td></tr>').join('');
  const html =
    '<div style="font-family:Tahoma,sans-serif;font-size:14px">' +
    '<p>มีซองอยู่ในมือ พขร. เกิน ' + hours + ' ชั่วโมง ยังไม่ได้บันทึกส่งเข้ากล่อง</p>' +
    '<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse">' +
    '<tr><th>พขร.</th><th>หน่วยงาน</th><th>รับซอง</th><th>ค้างมา</th><th>รหัส</th></tr>' + rows + '</table>' +
    '<p style="color:#666;font-size:12px">อีเมลนี้ส่งอัตโนมัติจากระบบ ' + esc_(s.app_name) + ' · แต่ละซองแจ้งครั้งเดียว</p></div>';
  const opt = { to: rcp.to, subject: '[' + s.app_name + '] ซองค้างในมือเกิน ' + hours + ' ชม. ' + fresh.length + ' ซอง', htmlBody: html, name: s.app_name };
  if (rcp.cc) opt.cc = rcp.cc;
  try {
    MailApp.sendEmail(opt);
  } catch (e) {
    return 'ERROR: ' + e.message; // ไม่จำ → รอบหน้าลองใหม่
  }
  props_().setProperty('STALE_ALERTED', JSON.stringify(keep));
  audit_('system', 'STALE_ALERT', '', { count: fresh.length, ids: fresh.map(e => e.id) });
  return 'SENT';
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
    const before = { name: r.name, active: isTrue_(r.active) };
    Object.keys(extra || {}).forEach(k => { before[k] = r[k]; });
    audit_(adminActor_(), 'UPDATE_' + table, o.id, { before: before, after: Object.assign({ name: name, active: active }, extra || {}) });
    return o.id;
  }
  const id = newId_(MASTER_PREFIX[table]);
  append_(table, Object.assign({ id: id, name: name, active: active, created_at: new Date() }, extra || {}));
  audit_(adminActor_(), 'CREATE_' + table, id, Object.assign({ name: name }, extra || {}));
  return id;
}

function adminSaveDepartment(o) {
  requireAdmin_();
  lockRun_(() => {
    let extra;
    if (o.email !== undefined) {
      const email = String(o.email || '').trim().toLowerCase();
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('อีเมลหน่วยงานไม่ถูกต้อง');
      extra = { email: email };
    }
    saveMaster_('Departments', o, extra);
  });
  return adminState_();
}
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
      if ((k === 'flag_gap_min' || k === 'driver_void_window_min' || k === 'stale_hours') && !/^\d{1,4}$/.test(v)) throw new Error(k + ' ต้องเป็นตัวเลข');
      if (k === 'daily_summary_hour' && v !== '' && !(/^\d{1,2}$/.test(v) && Number(v) <= 23)) throw new Error('เวลาสรุปรายวันต้องเป็น 0–23 หรือเว้นว่าง');
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
  const upd = {};
  if (d.email_status !== 'SENT') upd.email_status = sendDeliveryEmail_(d, envs, splitIds_(d.photo_ids));
  if (String(d.dept_email_status || '').indexOf('ERROR') === 0) upd.dept_email_status = sendDeptEmails_(d, envs, splitIds_(d.photo_ids));
  if (!Object.keys(upd).length) return 'ส่งครบแล้ว';
  lockRun_(() => updateRow_('Deliveries', findBy_('Deliveries', 'id', deliveryId)._row, upd));
  audit_(adminActor_(), 'RESEND_EMAIL', deliveryId, upd);
  return Object.keys(upd).map(k => (k === 'email_status' ? 'ผู้รับแจ้ง: ' : 'หน่วยงาน: ') + upd[k]).join(' · ');
}

/**
 * PDF รายการเดียวพร้อมรูป + AuditLog ที่เกี่ยวข้อง สำหรับใช้ตอนมีข้อโต้แย้ง
 * o: {type:'envelope'|'delivery', id} → เก็บใน Drive โฟลเดอร์ exports แล้วคืนลิงก์
 */
function adminExportPdf(o) {
  requireAdmin_();
  const allEnv = readAll_('Envelopes');
  const allDel = readAll_('Deliveries');
  let del = null, envs = [];
  if (o.type === 'delivery') {
    del = allDel.find(d => d.id === o.id);
    if (!del) throw new Error('ไม่พบรายการ');
    const ids = splitIds_(del.envelope_ids);
    envs = allEnv.filter(e => ids.indexOf(e.id) >= 0);
  } else {
    const e = allEnv.find(x => x.id === o.id);
    if (!e) throw new Error('ไม่พบรายการ');
    envs = [e];
    if (e.delivery_id) del = allDel.find(d => d.id === e.delivery_id) || null;
  }
  const s = readSettings_();
  const img = id => {
    const b = DriveApp.getFileById(id).getBlob();
    return '<img src="data:' + b.getContentType() + ';base64,' + Utilities.base64Encode(b.getBytes()) + '" style="max-width:48%;max-height:420px;margin:4px;border:1px solid #999">';
  };
  const st = { IN_HAND: 'อยู่ในมือ', DELIVERED: 'ส่งเข้ากล่องแล้ว', VOID: 'ยกเลิก', OK: 'ปกติ' };
  const line = (k, v) => v === '' || v == null ? '' : '<tr><th style="text-align:left;width:34%">' + k + '</th><td>' + v + '</td></tr>';
  const kv = rows => '<table border="1" cellpadding="5" cellspacing="0" style="border-collapse:collapse;width:100%">' + rows.join('') + '</table>';
  const envHtml = envs.map(e => '<h3>ซอง ' + esc_(e.id) + '</h3>' + kv([
    line('หน่วยงาน', esc_(e.dept_name)), line('สภาพซอง', isTrue_(e.sealed) ? 'ปิดผนึก' : 'ไม่ปิดผนึก'),
    line('พขร.', esc_(e.driver_name)), line('เวลารับซอง (เซิร์ฟเวอร์)', fmt_(e.server_at, 'dd/MM/yyyy HH:mm:ss')),
    line('เวลาเครื่อง', e.captured_at ? fmt_(e.captured_at, 'dd/MM/yyyy HH:mm:ss') + ' (ห่าง ' + e.time_gap_min + ' นาที)' : ''),
    line('ที่มาของรูป', e.photo_source === 'camera' ? 'กล้องสดในแอป' : 'ไฟล์/กล้องของเครื่อง'),
    line('สถานะ', st[e.status] || esc_(e.status)), line('ธง', esc_(e.flag)), line('เหตุผลยกเลิก', esc_(e.void_reason)), line('หมายเหตุ', esc_(e.note)),
    line('รหัสไฟล์รูป', esc_(e.photo_ids)),
  ]) + '<div>' + splitIds_(e.photo_ids).map(img).join('') + '</div>').join('');
  const delHtml = del ? '<h2>รอบส่งเข้ากล่อง ' + esc_(del.id) + '</h2>' + kv([
    line('กล่อง', esc_(del.box_name)), line('พขร.', esc_(del.driver_name)),
    line('เวลาส่งเข้ากล่อง (เซิร์ฟเวอร์)', fmt_(del.server_at, 'dd/MM/yyyy HH:mm:ss')),
    line('เวลาเครื่อง', del.captured_at ? fmt_(del.captured_at, 'dd/MM/yyyy HH:mm:ss') + ' (ห่าง ' + del.time_gap_min + ' นาที)' : ''),
    line('จำนวนซอง', del.envelope_count), line('ที่มาของรูป', del.photo_source === 'camera' ? 'กล้องสดในแอป' : 'ไฟล์/กล้องของเครื่อง'),
    line('สถานะ', st[del.status] || esc_(del.status)), line('ธง', esc_(del.flag)),
    line('อีเมลผู้รับแจ้ง', esc_(del.email_status)), line('อีเมลหน่วยงาน', esc_(del.dept_email_status)),
    line('เหตุผลยกเลิก', esc_(del.void_reason)), line('รหัสไฟล์รูป', esc_(del.photo_ids)),
  ]) + '<div>' + splitIds_(del.photo_ids).map(img).join('') + '</div>' : '<p><i>ยังไม่ได้ส่งเข้ากล่อง</i></p>';
  const targets = envs.map(e => e.id).concat(del ? [del.id] : []);
  const logs = readAll_('AuditLog').filter(a => targets.indexOf(String(a.target)) >= 0 ||
    targets.some(t => String(a.detail).indexOf(t) >= 0));
  const logHtml = '<h2>ประวัติใน AuditLog</h2><table border="1" cellpadding="4" cellspacing="0" style="border-collapse:collapse;width:100%;font-size:11px">' +
    '<tr><th>เวลา</th><th>ผู้กระทำ</th><th>การกระทำ</th><th>รายการ</th><th>รายละเอียด</th></tr>' +
    logs.map(a => '<tr><td>' + fmt_(a.ts, 'dd/MM/yyyy HH:mm:ss') + '</td><td>' + esc_(a.actor) + '</td><td>' + esc_(a.action) +
      '</td><td>' + esc_(a.target) + '</td><td>' + esc_(a.detail) + '</td></tr>').join('') + '</table>';
  const now = new Date();
  const html = '<html><head><meta charset="utf-8"></head><body style="font-family:Tahoma,sans-serif;font-size:12px">' +
    '<h1 style="font-size:18px">' + esc_(s.app_name) + ' — หลักฐานการส่งเอกสาร</h1>' +
    '<p>ออกเอกสารเมื่อ ' + fmt_(now, 'dd/MM/yyyy HH:mm:ss') + ' โดย ' + esc_(Session.getActiveUser().getEmail()) +
    ' · เวลาอ้างอิงทั้งหมดเป็นเวลาเซิร์ฟเวอร์ (Asia/Bangkok)</p>' +
    delHtml + '<h2>ซองในรายการ</h2>' + envHtml + logHtml + '</body></html>';
  const name = 'หลักฐาน_' + (del ? del.id.slice(0, 8) : envs[0].id.slice(0, 8)) + '_' + fmt_(now, 'yyyyMMdd-HHmmss') + '.pdf';
  const pdf = Utilities.newBlob(html, 'text/html', 'x.html').getAs('application/pdf').setName(name);
  const root = DriveApp.getFolderById(props_().getProperty('FOLDER_ID'));
  const it = root.getFoldersByName('exports');
  const file = (it.hasNext() ? it.next() : root.createFolder('exports')).createFile(pdf);
  audit_(adminActor_(), 'EXPORT_PDF', o.id, { type: o.type, file: file.getId() });
  return file.getUrl();
}

function adminAudit(limit) {
  requireAdmin_();
  const rows = readAll_('AuditLog');
  return ser_(rows.slice(-Math.min(Number(limit) || 300, 2000)).reverse());
}
