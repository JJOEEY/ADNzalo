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
```

### 2. Cấu hình
Tạo `.env`:
```env
SECRET_KEY=fb7457b7a39bdc9e742f08b657a8059a5e6a8fda6e32bfe0bfecf37eadf519eb
PORT=3000
```
> `SECRET_KEY` phải trùng với `src/ui/lib/backendService.ts:17`.

### 3. Chạy
```bash
SECRET_KEY=... PORT=3000 node server.js
```

### 4. Nginx reverse proxy
```nginx
server {
    listen 443 ssl;
    server_name adncapital.com.vn;

    location /api/ {
        proxy_pass http://127.0.0.1:3000/api/;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }

    # Các route khác (web, landing) để nguyên hoặc proxy khác
}
```

### 5. Health check
```bash
curl https://adncapital.com.vn/health
# → {"ok": true}
```

### 6. Test quét ẩn
```bash
curl -X POST https://adncapital.com.vn/api/scan/group \
  -H "Content-Type: application/json" \
  -H "x-api-key: fb7457b7a39bdc9e742f08b657a8059a5e6a8fda6e32bfe0bfecf37eadf519eb" \
  -d '{"page_id":"YOUR_PAGE_ID","body":"<AES_ENCRYPTED_PAYLOAD>"}'
```

---

## 🔄 Dual-backend fallback (hiện tại)

`src/ui/lib/backendService.ts` sử dụng 2 domain:
- **PRIMARY**: `https://adncapital.com.vn` (backend ADN — mục tiêu chính)
- **FALLBACK**: `https://deplaoapp.com` (server Deplao — dùng tạm khi ADN chưa deploy)

Khi ADN backend đã deploy hoạt động, fallback tự động ngưng được sử dụng.

---

## 🛡️ Bảo mật

1. **SECRET_KEY** — không commit, không chia sẻ. File `.env` và `backendService.ts` phải trùng.
2. **x-api-key** — mọi request backend phải có header này, giá trị = `SECRET_KEY`.
3. **Rate limit** — 60 req/phút/IP.
4. **Cookie/IMEI** — chỉ truyền qua AES-128-CBC mã hóa, không lưu trữ vĩnh viễn.
5. **Nginx** — chỉ proxy `/api/`, không mở port 3000 ra internet.

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
3. Deploy backend → `server/adn-scan-backend/` → nginx → test `curl /health`
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
A: Có — `getGroupInfo` cục bộ chỉ trả trưởng/phó. Backend dùng `zca-js` paginate `getGroupLinkInfo` mới lấy được full.

**Q: Khác gì với dự án Deplao?**
A: ADNzalo fork từ deplao-builder nhưng đã đổi hoàn toàn domain, palette, chức năng. Deplao chỉ là upstream để sync, không ảnh hưởng.
