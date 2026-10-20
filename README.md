# ส่งถึง (DocDrop) — ระบบบันทึกการส่งเอกสาร พขร. → กล่องบัญชี

หลักฐานฝั่งเดียวสำหรับป้องกันตัวเอง: พขร. ถ่ายรูปตอนรับซองจากหน่วยงาน และตอนวางซองเข้ากล่องบัญชี
ระบบเก็บเวลาเซิร์ฟเวอร์ + รูปใน Drive + ส่งอีเมลแจ้งหัวหน้าทันที บัญชีไม่ต้องทำอะไร

```
DocTrack/
├── backend/            → วางใน Google Apps Script (บัญชีธุรการกลาง)
│   ├── Code.gs         API ของ พขร. (doPost) + ฟังก์ชัน admin
│   ├── Admin.html      หน้า admin (doGet)
│   └── appsscript.json
├── frontend/           → อัปขึ้น GitHub Pages (แอป พขร. แบบ PWA)
│   ├── index.html  app.js  styles.css  config.js
│   ├── sw.js  manifest.webmanifest  icon.svg  icon-192.png  icon-512.png
├── .github/workflows/pages.yml  คัดลอก frontend/ ไป branch gh-pages (GitHub Pages)
├── README.md           ← ไฟล์นี้: วิธีติดตั้ง
└── HANDOFF.md          สเปกสำหรับ Claude Design / Claude Code
```

## ติดตั้ง (ประมาณ 20 นาที)

### 1. Backend — Apps Script
1. ล็อกอิน **Gmail ธุรการกลาง** → https://script.google.com → New project ตั้งชื่อ `ส่งถึง`
2. Project Settings → ติ๊ก *Show "appsscript.json"* แล้ววางเนื้อหา `backend/appsscript.json`
3. วาง `Code.gs` ทับไฟล์ Code.gs เดิม, สร้างไฟล์ HTML ชื่อ `Admin` แล้ววาง `Admin.html`
4. เลือกฟังก์ชัน `setup` → Run → อนุญาตสิทธิ์ (Sheets, Drive, Gmail ส่งเมล)
   ระบบจะสร้าง Google Sheet `ส่งถึง - ฐานข้อมูล` และโฟลเดอร์ `ส่งถึง - รูปหลักฐาน` ให้อัตโนมัติ
5. **Deploy ครั้งที่ 1 (Driver API)**: Deploy → New deployment → Web app
   - Execute as: **Me** · Who has access: **Anyone**
   - คัดลอก URL `…/exec` ไว้ใส่ใน `config.js`
6. **Deploy ครั้งที่ 2 (Admin)**: New deployment → Web app
   - Execute as: **Me** · Who has access: **Only myself**
   - URL นี้คือหน้า admin — บุ๊กมาร์กไว้ ห้ามแจกใคร

> แก้โค้ดแล้วต้อง Deploy → Manage deployments → แก้ทั้ง 2 deployment → Version: New version (URL เดิมไม่เปลี่ยน)

### 2. Frontend — GitHub Pages
1. ใส่ URL จากข้อ 5 ใน `frontend/config.js` → `API_URL`
2. push เข้า `main` → workflow `.github/workflows/pages.yml` จะคัดลอกโฟลเดอร์ `frontend/` ไปไว้ที่ branch `gh-pages` ให้อัตโนมัติ
3. Settings → Pages → Source: **Deploy from a branch** · Branch: `gh-pages` / `(root)` (ถ้า GitHub ยังไม่ได้ตั้งให้เอง)
   (แก้ไฟล์หน้าเว็บแล้วอย่าลืมเปลี่ยน `VERSION` ใน `sw.js` ไม่งั้นเครื่อง พขร. จะใช้แคชเก่า)
4. ได้ลิงก์ `https://<user>.github.io/<repo>/` → ใส่ในหน้า admin › ตั้งค่า › ลิงก์แอป พขร.

### 3. ตั้งค่าในหน้า admin
เปิดหน้า admin → ทำตามกล่องสีส้มให้ครบ: หน่วยงาน → พขร. + PIN → อีเมลรับแจ้ง → ชื่อกล่อง

### 4. แจก พขร.
ส่งลิงก์ทาง LINE → เปิดใน **Chrome (Android)** หรือ **Safari (iPhone)** → เมนู → *เพิ่มไปยังหน้าจอหลัก*
→ ล็อกอินครั้งแรกต้องมีสัญญาณ หลังจากนั้นใช้ออฟไลน์ได้

### 5. ป้ายที่กล่อง (สำคัญ)
ติดป้าย A4 ตัวใหญ่ข้อความเดียวกับ "ชื่อกล่อง" ในระบบ — ป้ายนี้คือสิ่งที่ยืนยันในรูปว่าวางที่กล่องจริง

## ก่อนใช้งานจริง — ทดสอบกับมือถือจริงทุกรุ่นที่ พขร. ใช้
- [ ] เปิดกล้องสดในแอปได้ (ถ้าไม่ได้ จะไปใช้กล้องเครื่องแทน และรายการจะถูกติดธง `NOT_LIVE_CAMERA`)
- [ ] ปิดเน็ต → รับซอง 2 ซอง → ส่งเข้ากล่อง → เปิดเน็ต → ข้อมูลขึ้นครบ ลำดับถูก และติดธง `TIME_GAP` ถ้าค้างเกิน 15 นาที
- [ ] ปิดแอปตอนออฟไลน์ แล้วเปิดใหม่ → รายการในคิวยังอยู่
- [ ] อีเมลถึงหัวหน้าพร้อมรูป
- [ ] รีเซ็ต PIN ในหน้า admin → เครื่องที่ล็อกอินอยู่ถูกให้เข้าใหม่
- [ ] เปิดลิงก์ admin จากเบราว์เซอร์ที่ไม่ได้ล็อกอินบัญชีกลาง → ต้องเข้าไม่ได้

## ข้อจำกัดที่ควรรู้
- หลักฐานพิสูจน์ "วางซองที่กล่องเวลาใด" ไม่ได้พิสูจน์ว่าบัญชีหยิบไป
- เวลาที่ใช้อ้างอิงคือ `server_at` — เวลาที่ประทับบนรูปเป็นเวลาเครื่อง (แสดงผลเท่านั้น)
- เจ้าของบัญชีกลางแก้ Sheet ตรงได้ แต่ Version history ของ Sheet และอีเมลที่ส่งออกไปแล้วแก้ย้อนหลังไม่ได้
- รูปเก็บในโฟลเดอร์ส่วนตัวของบัญชีกลาง ห้ามตั้งแชร์ "Anyone with the link"
