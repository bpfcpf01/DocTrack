# HANDOFF — ส่งถึง (DocDrop)

เอกสารนี้สำหรับส่งต่อให้ **Claude Design** (ปรับหน้าตา) และ **Claude Code** (พัฒนาต่อ/ทดสอบ/deploy)
โค้ดเฟส 1 ใช้งานได้ครบแล้ว — งานต่อคือปรับดีไซน์และทดสอบบนมือถือจริง ไม่ใช่เขียนใหม่

## 1. ปัญหาและเป้าหมาย
- พขร. (พนักงานขับรถ) รับซองเอกสารจาก **หลายหน่วยงาน** แล้วไปวางใน **กล่องรับเอกสารของแผนกบัญชี** (ไม่มีคนรับ)
- บัญชีชอบอ้างว่า "ไม่เห็นในกล่อง" / หน่วยงานอ้างว่า "ฝากไปแล้ว"
- **บัญชีจะไม่ร่วมใช้ระบบ** → เป้าหมายคือหลักฐานฝั่งเดียวที่น่าเชื่อถือพอจะป้องกัน พขร.
- ไม่มี CCTV, ไม่มี QR, พขร. ใช้ **มือถือส่วนตัว**, admin มีคนเดียวผ่าน **Gmail ธุรการกลาง**

## 2. Flow
1. **รับซอง** (ทุกซอง): เลือกหน่วยงาน → ปิดผนึก/ไม่ปิดผนึก → ถ่ายรูปหน้าซอง (+ หน้าแรกเอกสาร ถ้าไม่ปิดผนึก) → บันทึก → ซองอยู่สถานะ "ในมือ"
2. **ส่งเข้ากล่อง** (ครั้งเดียวต่อรอบ): ติ๊กซองในมือ (ค่าเริ่มต้นเลือกทั้งหมด) → ถ่าย 1–6 รูปให้เห็นป้ายกล่อง + หน้าซอง → ยืนยัน → อีเมลพร้อมรูปถึงผู้รับทันที
3. **Admin**: จัดการหน่วยงาน/พขร./อีเมล/กล่อง/ตั้งค่า, ค้นหา, ยกเลิก (ไม่ลบ), หมายเหตุ, ส่งอีเมลซ้ำ, CSV, พิมพ์, AuditLog

## 3. กฎที่ห้ามทำลาย (invariants)
| กฎ | เหตุผล | อยู่ที่ |
|---|---|---|
| เวลาอ้างอิง = `server_at`; เก็บ `captured_at` คู่ และติดธงเมื่อห่างเกิน `flag_gap_min` | เวลาเครื่องแก้ได้ | `timeInfo_` |
| ไม่มีการลบ — ยกเลิกเป็น `VOID` + เหตุผล | ความน่าเชื่อถือของหลักฐาน | `adminVoid`, `API.voidEnvelope` |
| admin แก้เวลา/รูป/ผู้บันทึกไม่ได้ | เหมือนข้างบน | ไม่มีฟังก์ชันแก้ — ห้ามเพิ่ม |
| ทุก action ลง `AuditLog` | ตรวจสอบย้อนหลัง | `audit_` |
| `client_id` สร้างในเครื่อง, backend idempotent | คิวออฟไลน์ส่งซ้ำได้ | `pickup`, `deliver` |
| คิว sync แบบ FIFO; deliver ล้มเหลว = หยุดคิว | deliver อ้างถึงซองที่ต้องขึ้นระบบก่อน | `sync()` ใน app.js |
| รูปที่ไม่ได้มาจากกล้องสด → ธง `NOT_LIVE_CAMERA` (ไม่บล็อก) | บางเครื่องเปิด getUserMedia ไม่ได้ | `sourceOf_`, `filePhoto` |
| ไม่เก็บรูปลงแกลเลอรีเครื่อง พขร. | ข้อมูลบริษัทบนมือถือส่วนตัว | ถ่ายผ่าน canvas เท่านั้น |
| token ผูกกับ PIN hash → รีเซ็ต PIN = token เก่าใช้ไม่ได้ | ถอนสิทธิ์ได้ทันที | `makeToken_`, `verifyToken_` |
| admin functions ตรวจ `requireAdmin_()` ทุกตัว | Driver API เป็น Anyone | `Code.gs` ส่วน Admin |

## 4. สถาปัตยกรรม
```
[มือถือ พขร. — PWA บน GitHub Pages]
   IndexedDB queue ──fetch POST text/plain──▶ [GAS Web App #1: Anyone → doPost]
                                                   │  Sheets (บัญชีกลาง)  Drive (รูป)  MailApp
[เบราว์เซอร์ admin] ──google.script.run──▶ [GAS Web App #2: Only myself → doGet Admin.html]
```
- ส่ง `Content-Type: text/plain` เพื่อเลี่ยง CORS preflight (GAS ไม่รองรับ OPTIONS)
- Service Worker แคชเฉพาะไฟล์แอป (same-origin GET) ไม่แตะ API

## 5. Data model (Google Sheets — แต่ละชีตแถวแรกเป็น header)
- `Departments` / `Boxes`: id, name, active, created_at
- `Drivers`: id, name, pin_hash, active, created_at
- `Recipients`: email, type (`to`|`cc`), active, created_at
- `Settings`: key, value — `app_name`, `flag_gap_min`, `driver_void_window_min`, `driver_app_url`
- `Envelopes`: id, driver_id, driver_name, dept_id, dept_name, sealed, photo_ids, photo_source, captured_at, server_at, time_gap_min, flag, status (`IN_HAND`|`DELIVERED`|`VOID`), delivery_id, delivered_at, void_reason, note
- `Deliveries`: id, driver_id, driver_name, box_id, box_name, envelope_ids, envelope_count, photo_ids, photo_source, captured_at, server_at, time_gap_min, flag, status (`OK`|`VOID`), email_status, void_reason, note
- `AuditLog`: ts, actor, action, target, detail
- เก็บชื่อ (driver_name, dept_name) ซ้ำในรายการโดยตั้งใจ → เปลี่ยนชื่อภายหลังไม่กระทบหลักฐานเก่า

## 6. Driver API (POST `{action, ...}` → `{ok, data}` หรือ `{ok:false, code, error}`)
| action | input | output |
|---|---|---|
| `ping` | – | version, server_time |
| `bootstrap` | – | app_name, departments[], drivers[], boxes[] (เฉพาะ active) |
| `login` | driver_id, pin | token, driver — ผิด 5 ครั้งล็อก 15 นาที |
| `inHand` | token | ซอง IN_HAND ของตัวเอง + `can_void` |
| `pickup` | token, client_id, dept_id, sealed, captured_at(ms), photos[{data:dataURL, source}] | id, server_at |
| `deliver` | token, client_id, envelope_ids[], box_id, captured_at, photos[] | id, server_at, email_status |
| `voidEnvelope` | token, envelope_id, reason | id — เฉพาะซองในมือ ภายใน `driver_void_window_min` |

Error codes: `AUTH` (ต้องล็อกอินใหม่ — คิวยังอยู่), `BAD_PIN`, `LOCKED`, `BAD`, `NOT_FOUND`, `FORBIDDEN`, `SETUP`

## 7. Brief สำหรับ Claude Design
**ผู้ใช้**: พขร. อายุหลากหลาย ใช้มือถือ Android ราคาประหยัดเป็นส่วนใหญ่ ใช้ขณะยืนถือซอง บางครั้งกลางแดดหรือในโกดังแสงน้อย
**หลักการ**
- ปุ่มใหญ่ (≥56px) ข้อความไทยตัวใหญ่ ใช้มือเดียว ไม่มีศัพท์เทคนิค
- หน้าหลักมีแค่ 2 การกระทำ: **รับซอง** / **ส่งเข้ากล่อง** + รายการซองในมือ
- สถานะออนไลน์/ออฟไลน์ และ "รอส่งขึ้นระบบ" ต้องเห็นชัดแต่ไม่น่ากลัว — ออฟไลน์เป็นเรื่องปกติ
- หน้ากล้องต้องบอกว่าต้องเห็นอะไรในรูป (ป้ายกล่อง + หน้าซอง)
- หน้าสำเร็จต้องชัดว่า "บันทึกแล้ว" ทันที แม้ยังออฟไลน์
- คอนทราสต์สูง (WCAG AA), ไม่พึ่งสีอย่างเดียว
- ฟอนต์แนะนำ: Sarabun / Noto Sans Thai

**ห้ามเปลี่ยน**: `id` ทุกตัวใน `index.html` และ class `screen`, `shot`, `x`, `req`, `local`, `empty`, `on`, `off`, attribute `data-*` — `app.js` อ้างถึง
**ปรับได้อิสระ**: `styles.css` ทั้งไฟล์, ไอคอน, สี, layout ภายในแต่ละ screen, ข้อความ UI
**หน้า admin** (`Admin.html`): ใช้บนคอมพิวเตอร์เป็นหลัก — ตาราง, ตัวกรอง, รูป thumbnail; ความสวยงามสำคัญน้อยกว่าความชัดเจน

## 8. งานสำหรับ Claude Code
**ก่อนใช้งานจริง (ต้องทำ)**
1. Deploy ตาม README และทดสอบเช็กลิสต์ใน README บนมือถือจริง
2. ยืนยันว่า `getUserMedia` ทำงานบน GitHub Pages กับมือถือของ พขร. ทุกรุ่น
3. ทดสอบ iOS: Safari อาจล้าง IndexedDB ของ PWA ที่ไม่ได้เปิดนาน — คิวต้อง sync ก่อน (ปกติภายในวัน)
4. ทดสอบ concurrency: 2 เครื่องส่งพร้อมกัน (มี `LockService` แล้ว)

**ช่องโหว่ที่รู้แล้ว / ปรับปรุงได้**
- `readAll_` อ่านทั้งชีตทุกคำขอ — พอสำหรับหลักหมื่นแถว ถ้าโตกว่านั้นให้แยกชีตรายปี หรือ cache
- อีเมลส่งภายนอก lock; ถ้า quota MailApp เต็ม (บัญชีฟรี ~100 ผู้รับ/วัน) → `email_status` = ERROR และกด "ส่งอีเมลซ้ำ" ในหน้า admin ได้
- PIN 4–6 หลัก + ล็อกหลังผิด 5 ครั้ง (ใน CacheService — เคลียร์ได้ถ้า cache หาย)
- thumbnail ในหน้า admin ใช้ `drive.google.com/thumbnail` ซึ่งต้องล็อกอินบัญชีกลางในเบราว์เซอร์เดียวกัน

**เฟส 2 (ยังไม่ทำ)**
- อีเมลแจ้งหน่วยงานต้นทางเมื่อซองของเขาถึงกล่อง (ต้องเพิ่มคอลัมน์ email ใน Departments)
- อีเมลสรุปรายวัน + แจ้งเตือนซองค้างในมือเกิน X ชม. (time-driven trigger)
- Export PDF รายการเดียวพร้อมรูปสำหรับใช้ตอนมีข้อโต้แย้ง
- เก็บข้อมูลเกิน 1 ปีไปชีต/โฟลเดอร์ archive

## 9. นโยบายองค์กร
- ระบบเป็น rule-based ล้วน ไม่มี AI → ไม่เข้าข่ายนโยบาย AI ของ CPF
- ข้อมูลอยู่ในบัญชีธุรการกลางเท่านั้น ไม่ส่งไปบริการภายนอกอื่น
- รูปหน้าซองอาจมีข้อมูลส่วนบุคคล → โฟลเดอร์ Drive ต้องเป็นส่วนตัว
