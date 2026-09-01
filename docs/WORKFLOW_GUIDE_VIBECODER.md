# ADNzalo - Hướng dẫn Workflow cho Vibecoder (Win11)

> Dành cho người không rành code, chỉ cần kéo-thả. Đã test trên ADNzalo 1.0.0 (clone ADNzalo-base (deplao), giữ Zalo+CRM+Campaign+AI).

### 1. Workflow là gì?
Tự động hoá: **Khi có sự kiện -> Làm gì đó**. Ví dụ: `Khách nhắn "giá"` -> `AI trả lời` -> `Gắn nhãn "quan tâm giá"` -> `Ghi Google Sheet`.

### 2. Mở Workflow ở đâu?
ADNzalo -> Sidebar icon **Công cụ (Tools)** -> **Workflow (n8n)** -> Bấm **Tạo Workflow** -> Đặt tên `Chăm TCX kẹt 44`.

### 3. Kéo 3 khối cơ bản (đủ xài 80%)

**Bước 1 - Trigger (Khi nào chạy):**
* Kéo `Trigger: Tin nhắn mới` vào canvas -> Cấu hình: `Từ khóa = TCX, kẹt, 44` + `Loại = Chat cá nhân`. Nghĩa là chỉ khi khách nhắn chứa 1 trong 3 từ đó mới chạy.

**Bước 2 - AI (Nói gì):**
* Kéo `AI -> Tạo nội dung` nối dây từ Trigger -> Chọn `Trợ lý: ADN Assistant - Huy` (đã set `gpt-5.6-luna` + `OPENAI_API_KEY`), Prompt ghi: `Viết tin nhắn chăm khách kẹt TCX giá 44, giữ placeholder <Xưng hô> <Tên Zalo người nhận>, ngắn 2-4 câu, có hỗ trợ 36.5 kháng cự 46.3`. Bật `Chèn ảnh` nếu muốn kèm `adn_dgw.png`.

**Bước 3 - Action (Gửi đi):**
* Kéo `Zalo -> Gửi tin nhắn` nối từ AI -> Chọn `Tài khoản gửi: Huy (chính)` hoặc `Clone 1` (nó tự lấy tên nick đó, không còn cố định Ngân) -> Nội dung để `{{ $ai.content }}` (kết quả AI) -> Bật `Gõ đang nhập + delay 3-5s` cho tự nhiên.

Xong bấm **Bật** (toggle xanh) -> Workflow chạy nền 24/7, kể cả khi bạn đóng cửa sổ Workflow (miễn app còn mở).

### 4. Mẫu 2 workflow anh cần luôn

**A. Sale DNSE high margin (khi khách im 3 ngày):**
Trigger `Lịch Cron: mỗi 3 ngày 09:00` -> `IF nhãn = quan tâm margin` -> `Gửi tin nhắn`: `Anh/chị <Tên> ơi, DNSE cho sức mua x2-x3... Anh muốn nghiên cứu thêm không em gửi tài liệu cho mình ạ. Link: https://hdsd.dnse.com.vn/` -> `Gắn nhãn: đã gửi DNSE`

**B. Chăm ADN tool (khi khách đã kết bạn):**
Trigger `Sự kiện: Được chấp nhận kết bạn` -> `Gửi tin nhắn` + `Gửi ảnh` (chọn 1 trong 4 ảnh `adn_mbs_pet.png`) -> `Gắn nhãn: thích tool`

### 5. Test trước khi bật thật
Trong canvas bấm **Chạy thử** (nút Play) -> Gửi tin nhắn test `kẹt TCX 44` từ nick khác -> Xem `Lịch sử chạy` bên phải, nếu thấy `Đã gửi` là ok. Sai thì xem log đỏ ở đó.

### 6. Lưu ý cho Zalo (để nick 3579 không bị khóa)
* Delay giữa các tin trong Workflow để `3-5 phút` (đã set trong `CampaignCreateModal: DELAY_PRESETS 3-5m`), đừng để 0s.
* Mỗi Trigger nên lọc `chỉ 1 nhãn` hoặc `1 từ khóa` để không spam nhầm.
* Luôn có `IF đã gửi trong 24h thì dừng` nếu chạy Cron.

### 7. Xuất file cài
Đã build sẵn: `dist-electron-build/ADNzalo-Setup-1.0.0.exe` (Win11 x64). Gửi file này cho nhân viên cài là chạy, đăng nhập QR Zalo là xong. Boss bật `WAN` trong `Cài đặt -> Workspace -> Relay AutoStart` để nhân viên ở nhà vào được.

---
*Hỏi thêm: Cài đặt -> Trợ lý AI để đổi `API Key` và `Model gpt-5.6-luna` bất cứ lúc nào.*
