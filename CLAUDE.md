# ADNzalo — Claude Rules & Deployment Guide

> Dự án phần mềm desktop quản lý tài khoản Zalo đa tài khoản (Electron + React + TypeScript).
> Vận hành tập trung cho ADN Capital: quét thành viên ẩn, CRM, Campaign, Workflow, AI Assistant.

---

## 📁 Cấu trúc repo chính

```
D:\BOT\ADNzalo\
├── src/               # React frontend + services
├── electron/          # Electron main process
├── server/adn-scan-backend/   # Backend quét ẩn (Node.js Express)
├── landing/           # Landing page Next.js
├── scripts/           # Build helpers
├── dist-electron-build/ # Installer output
└── package.json
```

---

## 🚀 Deploy — Dự án chính (ADNzalo app)

### Build renderer
```bash
npm run build:renderer
```

### Build Electron + Installer
```bash
npx tsc -p tsconfig.electron.prod.json && node scripts/strip-console.js && npx electron-builder --publish never
```
- Output: `dist-electron-build/ADNzalo-Setup-1.0.0.exe`
- Platform: Windows x64 (Electron 41.5.1)

### Lint & typecheck
```bash
npx tsc --noEmit        # typecheck
npm run lint            # ESLint
```

---

## 🖥️ Deploy — Backend quét ẩn (`server/adn-scan-backend/`)

Mục đích: quét thành viên ẩn trong nhóm Zalo thông qua `zca-js` phía server.

### Điều kiện tiên quyết
- VPS/Cloud có domain `adncapital.com.vn` (hoặc domain khác)
- Node.js 18+, nginx làm reverse proxy

### 1. Clone & cài đặt
```bash
cd server/adn-scan-backend
npm install
# copy .env.example thành .env rồi điền SECRET_KEY thật
```

### 2. Cấu hình
Tạo `.env`:
```env
SECRET_KEY=<SECRET_KEY>
PORT=3100
```
> Không commit khóa thật. `SECRET_KEY` phải trùng khóa cấu hình của app.
> `server.js` nạp `.env` qua `dotenv`; production nên đặt file env ngoài thư mục repo hoặc dùng `EnvironmentFile` của systemd.

### 3. Chạy
```bash
SECRET_KEY=... PORT=3100 node server.js
```

### 4. Nginx reverse proxy
```nginx
server {
    listen 443 ssl;
    server_name adncapital.com.vn;

    # Chỉ proxy các route của scan backend; không chiếm toàn bộ /api/ của ADN.
    location = /api/health {
        proxy_pass http://127.0.0.1:3100;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }

    location = /api/scan/group {
        proxy_pass http://127.0.0.1:3100;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }

    location = /api/scan/premium-status {
        proxy_pass http://127.0.0.1:3100;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }

    # Các route khác của web/landing/API ADN để nguyên.
}
```

### 5. Health check
```bash
curl https://adncapital.com.vn/api/health
# → {"ok": true}
```
> Vì domain đang có landing/web app, route health nên kiểm tra tại `https://adncapital.com.vn/api/health`.

### 6. Test quét ẩn
```bash
curl -X POST https://adncapital.com.vn/api/scan/group \
  -H "Content-Type: application/json" \
  -H "x-api-key: <SECRET_KEY>" \
  -d '{"page_id":"YOUR_PAGE_ID","body":"<AES_ENCRYPTED_PAYLOAD>"}'
```

---

## 🔄 Dual-backend fallback (hiện tại)

`src/ui/lib/backendService.ts` sử dụng 2 domain:
- **PRIMARY**: `https://adncapital.com.vn` (backend ADN — mục tiêu chính)
- **FALLBACK**: `https://deplaoapp.com` (server Deplao — dùng tạm khi ADN chưa deploy)

Khi ADN backend đã deploy hoạt động, fallback tự động ngưng được sử dụng.
Không xóa fallback trước khi `https://adncapital.com.vn/api/health` trả HTTP 200 và test scan bằng tài khoản thật thành công.

---

## 🛡️ Bảo mật

1. **SECRET_KEY** — không commit, không chia sẻ. File `.env` và `backendService.ts` phải trùng.
2. **x-api-key** — mọi request backend phải có header này, giá trị = `SECRET_KEY`.
3. **Rate limit** — 60 req/phút/IP.
4. **Cookie/IMEI** — chỉ truyền qua AES-128-CBC mã hóa, không lưu trữ vĩnh viễn.
5. **Nginx** — chỉ proxy các route scan cụ thể, không mở port 3100 ra internet.
6. **Quyền Zalo** — backend không nâng quyền tài khoản; danh sách đầy đủ chỉ trả được khi cookie đăng nhập có quyền và API Zalo cho phép.
7. **Không tự bật link nhóm** — nếu invite link bị tắt, báo giới hạn quyền thay vì thay đổi cài đặt nhóm.

---

## 🔧 Hạ tầng liên quan

| Component | Đường dẫn | Mô tả |
|-----------|-----------|-------|
| DB | `src/ui/lib/data/DataAccessor.ts` | `page_group_member`, `crm_contact`, `settings` |
| Zalo API | `src/services/zalo/ZaloService.ts` | zca-js wrapper |
| Quét ẩn | `server/adn-scan-backend/server.js` | Backend Node.js |
| UI Quét | `src/ui/components/crm/groups/GroupMembersTab.tsx` | CRM nhóm |
| Backend service | `src/ui/lib/backendService.ts` | Gọi API backend |
| Landing | `landing/` | Next.js landing page |

---

## 📝 Workflow phát triển

1. Thay đổi code → `npm run build:renderer` → test local
2. Build Electron → `electron-builder --publish never` → test `.exe`
3. Deploy backend → `server/adn-scan-backend/` → nginx → test `curl /api/health`
4. Commit → đẩy `origin/main` trên `JJOEEY/ADNzalo`
5. Đọc `CLAUDE.md` này trước khi deploy để đảm bảo đúng quy trình

---

## 🔗 Remote
- **origin**: `https://github.com/JJOEEY/ADNzalo` (chính)
- **upstream**: `https://github.com/babyvibe/deplao-builder` (chỉ sync, không push)

---

## ❓ FAQ

**Q: Tại sao 2 domain?**
A: `adncapital.com.vn` là backend ADN (mục tiêu), `deplaoapp.com` là fallback tạm khi ADN chưa deploy.

**Q: Quét ẩn có cần backend không?**
A: Backend chỉ giúp chạy API ngoài Electron và paginate `getGroupLinkInfo`; domain không tự cấp quyền. Nếu group link tắt hoặc tài khoản không có quyền xem danh sách, backend cũng không thể lấy thành viên bị Zalo giới hạn.

**Q: Khác gì với dự án Deplao?**
A: ADNzalo fork từ deplao-builder nhưng đã đổi hoàn toàn domain, palette, chức năng. Deplao chỉ là upstream để sync, không ảnh hưởng.
