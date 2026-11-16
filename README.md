# LMS Backend (wanthai-logistic-node)

API ของระบบ LMS (Logistics Management System) ของวันไทย: จัดการ PO ตั้งแต่ลงแผนรถจนรถออกจากโรงงาน, ประตูโหลด, ผู้ใช้และสิทธิ์
Node.js + Express + SQL Server + Socket.IO (แจ้งหน้าเว็บทุกเครื่องเมื่อข้อมูลเปลี่ยน)

หน้าเว็บอยู่ที่ [`../wanthai-logistics-react`](../wanthai-logistics-react)

---

## เริ่มต้นใช้งาน

```bash
npm install
cp .env.example .env      # แล้วใส่ค่าจริง (ดูหัวข้อ "ค่าที่ต้องตั้ง")
npm start                 # รัน server ที่ port 5000 (ตั้งใน PORT)
npx nodemon server.js     # รันแบบ restart เองเมื่อแก้โค้ด (npm run dev ยังใช้ไม่ได้ เพราะยังไม่ได้ติดตั้ง nodemon ในโปรเจค)
npm test                  # unit test (ไม่ต้องใช้ฐานข้อมูล)
```

ตอน start ระบบจะสร้าง/อัปเดตตารางที่ขาดให้เอง (`initializeDatabase` ใน `src/config/db.js`)

### ค่าที่ต้องตั้งใน `.env` (ดูคำอธิบายครบใน `.env.example`)

| ค่า | จำเป็น | หมายเหตุ |
|---|---|---|
| `DB_USER`, `DB_PASSWORD`, `DB_SERVER`, `DB_NAME`, `DB_INSTANCE` | ✓ | SQL Server |
| `JWT_SECRET` | ✓ | สุ่มยาว ≥ 32 ตัว ถ้าไม่ตั้ง ทุกคนต้อง login ใหม่ทุกครั้งที่ restart |
| `MFA_ENCRYPTION_KEY` | ✓ | base64 32 byte ไม่ตั้ง = server ไม่ start **ห้ามเปลี่ยนหลังใช้งานจริง** (ทุกคนต้องผูก MFA ใหม่) |
| `CORS_ORIGINS` | ✓ | URL ของหน้าเว็บที่อนุญาต |
| `SMTP_*`, `MAIL_FROM`, `APP_PUBLIC_URL` | สำหรับอีเมล | ใช้ส่งลิงก์ตั้งรหัสผ่าน / เปิดใช้งานบัญชี |
| `SSL_KEY_FILE`, `SSL_CERT_FILE` | แนะนำ | ไม่ตั้ง = HTTP (รหัสผ่านไม่ถูกเข้ารหัสระหว่างทาง) |
| `LOG_LEVEL` | – | `debug` / `info` / `warn` / `error` |

**ห้าม commit `.env`** (มีรหัสผ่านฐานข้อมูลและ key) — `.gitignore` กันไว้แล้ว

---

## โครงสร้างโฟลเดอร์

```
server.js                 จุดเริ่ม: express, socket.io, middleware, start server
src/
  routes/                 กำหนด URL + สิทธิ์ที่ต้องมี (can('canXxx')) + audit log ของแต่ละ endpoint
    index.js              รวม router, ตรวจ token ทุก request ยกเว้น PUBLIC_ROUTES
    poRoutes.js           /api/register-car, /api/truck-arrival, ... (ขั้นตอนของ PO)
    masterRoutes.js       ประตู, สิทธิ์, ผู้ใช้, login, audit log
  controllers/            รับ request → SQL → ตอบ response
    poController.js       ทุกขั้นของ PO
    userController.js     ผู้ใช้, login, MFA, รีเซ็ตรหัสผ่าน, ล็อคบัญชี
    masterController.js   ลูกค้า, สถานที่ส่ง, ประตู, คลัง, ประเภทรถ
    permissionController.js  สิทธิ์ของแต่ละ role (ตาราง Role_permission)
    auditLogController.js    อ่านประวัติการบันทึก
  services/
    auditService.js       เขียน audit log (auditRoute middleware)
    auditEvents.js        ข้อความ audit ของแต่ละ endpoint
    settingsService.js    ค่าตั้งด้านความปลอดภัยจากตาราง Setting
    mfaService.js         TOTP, เข้ารหัส secret, นับรหัสผิด
    mailService.js        ส่งอีเมล (SMTP)
    permissionService.js  คำนวณสิทธิ์จริงของ role
  middleware/             ตรวจ token/สิทธิ์ (auth.js), จำกัดการ login ต่อ IP, ซ่อน error 500
  config/                 การเชื่อมต่อ DB + สร้างตาราง, ชื่อตาราง, ค่า lockout/MFA/token
  utils/logger.js         level log
scripts/                  สคริปต์ใช้มือบน server (ดูด้านล่าง)
sql/                      migration ที่เคยรันมือ — เก็บไว้เป็นประวัติ ตอนนี้ระบบเพิ่มคอลัมน์/ตารางที่ขาดให้เองตอน start
test/                     unit test + integration test
```

---

## Flow ของ PO

```
ลงข้อมูล PO (office) → ลงแผนรถเข้า (Yusen) → LC ส่งตั๋ว → เลือกประตูโหลด
→ รถเข้าโรงงาน (Yusen) → ออกตั๋ว → หยิบสินค้า → โหลดสินค้า → รถออก (ปลดล็อคประตู)
```

- แต่ละขั้นเป็น endpoint แยกใน `src/routes/poRoutes.js` และต้องมีสิทธิ์ของขั้นนั้น (เช่น `canEditCarPlan`, `canActionTruckArrival`)
- ยกเลิก / เลื่อนแผนรถ / ส่งด่วน ทำได้หลายรายการพร้อมกัน
- `processStage` ของ PO คำนวณใหม่ทุกครั้งที่อ่าน (`getPos` ใน `poController.js`) จากเวลาที่บันทึกไว้
- สถานะยกเลิกในฐานข้อมูลสะกด `'CANCLE'` (ของเดิม) — โค้ดเช็คทั้ง `'CANCLE'` และ `'CANCEL'`

---

## สิทธิ์ (Permissions)

- สิทธิ์ของแต่ละ role เก็บในตาราง `Role_permission` (JSON) แก้ได้จากหน้า "กำหนดสิทธิ์" บนเว็บ
- ทุก route ตรวจด้วย `can('canXxx', ...)` = ต้องมีอย่างน้อย 1 สิทธิ์ในรายการ
- `ADMIN_SYSTEM` ผ่านทุกสิทธิ์
- `PERMISSION_MODE=report` = ไม่บล็อก แค่ log ว่าจะถูกปฏิเสธ (ใช้ตอนทดลอง)

## Login และความปลอดภัย

- **Login:** รหัสผ่าน → MFA (รหัส 6 หลักจากแอป Authenticator) → ได้ token
- **ล็อคบัญชี:** กรอกรหัสผิดครบจำนวนครั้ง ระบบจะล็อคบัญชีชั่วคราว และจำกัดจำนวนครั้งต่อ IP ด้วย
- **ข้อความ error:** บัญชีที่ไม่มีอยู่, ถูกปิด หรือยังไม่มีรหัสผ่าน จะได้ข้อความเดียวกับรหัสผิด ไม่บอกว่าบัญชีมีอยู่จริงหรือไม่
- **ค่าตัวเลข** เช่น จำนวนครั้งที่ผิดได้ก่อนล็อค หรือเวลาล็อค **เก็บในตาราง `Setting`**
  - แก้ในตารางได้เลย มีผลภายใน 1 นาที ไม่ต้อง restart
  - ค่าใน `.env` ใช้แค่ตอนสร้างตารางครั้งแรก
  - `min_value` / `max_value` คือช่วงที่ยอมรับ ค่านอกช่วงจะถูกตัดให้อยู่ในช่วง ส่วนค่าที่ไม่ใช่ตัวเลขจะใช้ค่าสำรอง

```sql
UPDATE [Setting] SET setting_value = '3', updated_at = GETDATE()
WHERE setting_key = 'ACCOUNT_LOCKOUT_MAX_FAILS';
```

## Log 2 แบบ

| | Audit log | Level log |
|---|---|---|
| คือ | ประวัติว่าใครทำอะไรกับ PO ไหน เมื่อไหร่ | log ของระบบสำหรับ dev/IT |
| เก็บที่ | ตาราง `Transaction_log` (หน้า "ประวัติการบันทึก") | stdout/stderr ของ server |
| เขียนโดย | `auditRoute(...)` ใน routes — **backend เท่านั้น** หน้าเว็บเขียนเองไม่ได้ | `logger.debug/info/warn/error` (`src/utils/logger.js`) |

- **เพิ่ม endpoint ใหม่ที่เปลี่ยนข้อมูล:** ต้องใส่ `audit(...)` ใน route และเพิ่มข้อความใน `src/services/auditEvents.js`
- **ห้ามใส่ข้อมูลลับใน log ทั้ง 2 แบบ:** รหัสผ่าน, token, MFA secret, ลิงก์รีเซ็ต
- **request id:** ทุก request มี id ของตัวเอง (header `X-Request-Id`) log ทุกบรรทัดของ request เดียวกันจะมี id เดียวกัน ใช้ค้นหาตอนมีปัญหา

---

## สคริปต์ (`scripts/`)

| คำสั่ง | ใช้เมื่อ |
|---|---|
| `node scripts/reset-mfa.js <username>` | Admin ทุกคนเข้าระบบไม่ได้ (เช่น โทรศัพท์หาย) — ล้าง MFA ให้ผูกใหม่ |
| `node scripts/normalize-role-permissions.js [--apply]` | ทำ JSON สิทธิ์ทุก role ให้มี key ครบ (ไม่ใส่ `--apply` = ดูก่อน) |
| `node scripts/check-user-group.js` | ดูค่า `user_group` ของผู้ใช้ 5 คนแรก |

## Test

```bash
npm test                                   # unit test (ไม่ต้องใช้ฐานข้อมูล)
$env:TEST_DB_NAME='LMS_TEST'; npm test     # รวม integration test (PowerShell) — ต้องเป็นฐานข้อมูลทดสอบ ห้ามใช้ฐานจริง
```

ทุกครั้งที่แก้ bug ให้เพิ่ม test ที่จับ bug นั้นใน `test/`
