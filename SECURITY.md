# Chính sách bảo mật — ADNzalo

## Báo cáo lỗ hổng

- Kênh chính: tạo **GitHub Security Advisory riêng tư** tại repo [JJOEEY/ADNzalo](https://github.com/JJOEEY/ADNzalo/security/advisories/new) (không tạo issue công khai cho lỗ hổng).
- Kênh dự phòng: email `contact@adncapital.com.vn` với tiêu đề `[SECURITY]`.
- Phản hồi trong vòng **7 ngày**. Vui lòng cho phép thời gian vá lỗi trước khi công bố.

## Phạm vi

- App desktop `ADNzalo` (Electron): main process, preload, IPC handlers, renderer.
- Backend quét ẩn `server/adn-scan-backend/` (API trên `adncapital.com.vn`).
- Nằm ngoài phạm vi: các dịch vụ bên thứ ba tích hợp (Zalo, Telegram, Google, KiotViet...), trang landing tĩnh.

## Nguyên tắc dữ liệu

- Dữ liệu người dùng (tin nhắn, CRM, cookie Zalo) lưu **cục bộ** trên máy; cookie được mã hóa bằng Electron `safeStorage`.
- Backend quét chỉ nhận cookie qua payload AES-128-CBC trong từng request, **không lưu trữ vĩnh viễn**; chỉ lưu kho thành viên (uid/tên/avatar) phục vụ tích lũy.
- Không tự thay đổi cài đặt nhóm Zalo của người khác (không gọi `enableGroupLink`).

## Biến môi trường backend

| Biến | Bắt buộc | Mô tả |
|---|---|---|
| `SECRET_KEY` | ✅ | Khóa hex ≥32 ký tự, dùng cho `x-api-key` + giải mã payload |
| `SECRET_KEY_LEGACY` | — | Khóa cũ chấp nhận trong giai đoạn chuyển tiếp client; xóa khi fleet đã nâng cấp |
| `ALLOW_PLAIN_PAYLOAD` | — | Chỉ đặt `1` để debug local; **cấm** trên production |
| `CACHE_DIR` | — | Đường dẫn kho thành viên (mặc định `<app>/data`) |
