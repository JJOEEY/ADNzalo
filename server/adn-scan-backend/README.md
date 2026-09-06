# ADN Scan Backend — Quét thành viên ẩn

Backend quét ẩn độc lập của `ADNzalo`, không phụ thuộc dịch vụ bên ngoài.

Ngoài quét live, backend còn **tự tích lũy kho thành viên** (`data/member-cache.json`, đổi đường dẫn qua `CACHE_DIR`): mỗi lần quét live thành công được lưu theo `groupId`; khi live bị `lockViewMember` giới hạn, backend hợp nhất (union) kho với kết quả live để trả tối đa số thành viên đã biết. Kho càng dùng càng đầy.

> **Quyền ghi:** service systemd chạy với `ProtectHome=read-only`, nên `deploy-vps.sh` tạo sẵn
> `data/` (owner `adnzalo-scan`) và unit đã khai báo `ReadWritePaths=-.../data`. Nếu deploy tay
> không qua script: `install -d -o adnzalo-scan -g adnzalo-scan /home/adncapital/app/adnzalo-scan-backend/data`.
> Đổi đường dẫn khác qua `CACHE_DIR` trong `.env` (nhớ thêm `ReadWritePaths` tương ứng).

## Deploy nhanh (VPS / Render / Railway)

```bash
cd server/adn-scan-backend
npm install
# Tạo file .env (file này không được commit)
SECRET_KEY=<SECRET_KEY>
PORT=3100
node server.js
# Đặt reverse proxy https://adncapital.com.vn/api -> http://localhost:3100
```

Trên VPS ADN hiện tại, web đã dùng port `3000`; scan backend phải dùng `3100`.
Các file `adnzalo-scan-backend.service` và `adnzalo-scan.nginx` là template để chạy độc lập.
Sau khi upload thư mục, chạy `bash deploy-vps.sh` bằng `root`; script cài service, kiểm tra health, backup nginx, kiểm tra cấu hình rồi reload.

Nginx:
```
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
```

## Endpoints
- `POST /api/scan/group` — body `{page_id, body: AES-128-CBC(base64 JSON {page_id, cookie, imei, groupId})}` + header `x-api-key`
  Trả `{success, groupId, totalMembers, members:[{userId,displayName,zaloName,avatar}]}` — chính xác contract `backendService.ts:24`.
- `GET /api/health` — health check.
- `POST /api/scan/premium-status` — ADNzalo bỏ check, luôn `{is_premium:true}`.
- Các API khác của `adncapital.com.vn` không thuộc backend này và phải tiếp tục do web/API hiện hữu xử lý.

## Bảo mật
- Rotate khóa: đặt `SECRET_KEY=<KHÓA_MỚI>` + `SECRET_KEY_LEGACY=<KHÓA_CŨ>` trong `.env`.
  Backend nhận **cả hai** để app cũ (≤1.0.0) không bị đứt; **xóa legacy** khi fleet đã nâng cấp.
  **Thứ tự deploy:** cập nhật `.env` + restart service TRƯỚC, rồi mới phát hành app build mới.
- Kiểm tra `x-api-key` khớp `SECRET_KEY` hoặc `SECRET_KEY_LEGACY` (timing-safe)
- Giải mã AES-128-CBC với 16 byte đầu của khóa hex, IV toàn số 0, base64
- Validate `page_id` trùng decrypted `page_id`
- Rate limit 60 req/phút/IP
- Không tự bật invite link; nhóm phải có link đang hoạt động để gọi `getGroupLinkInfo`
- Quyền của tài khoản Zalo vẫn được giữ nguyên: backend không thể vượt qua quyền admin hoặc chính sách riêng tư của nhóm
