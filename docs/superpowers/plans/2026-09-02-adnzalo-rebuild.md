# ADNzalo Independent Rebuild Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Giữ nền tảng vận hành của Deplao làm base kỹ thuật, nhưng phát hành ADNzalo như một repo độc lập với identity ADN, palette ADN, landing mới, backend ADN và quét thành viên ẩn chủ động theo từng tài khoản.

**Architecture:** Thực hiện theo bốn phase có thể kiểm tra riêng. Core app vẫn giữ Electron/React/Vite, Zustand, SQLite WAL, zca-js và relay Boss/Employee. Branding được gom về identity/token tập trung; tính năng quét dùng engine hiện có, chạy tuần tự theo account để giữ partition dữ liệu và giới hạn tải.

**Tech Stack:** Electron 41, React 18, Vite 6, TypeScript 5, Tailwind 3, Zustand, better-sqlite3, zca-js 2.1.2, Socket.IO, GitHub Actions.

---

## Decisions

- Repository chính: `JJOEEY/ADNZalo`.
- Backend/API branding: `https://adncapital.com.vn`; không còn gọi `deplaoapp.com`.
- Visual direction: ADN cobalt `#0b3b8f`, electric blue `#1261d6`, cyan signal `#16b8c4`, ink/slate neutrals; không dùng Deplao purple/navy identity.
- Git history: tạo nhánh `main` orphan mới và commit duy nhất chứa trạng thái ADNzalo đã hoàn thiện; các bản cập nhật sau có thể commit bình thường.
- Landing: giữ và rebuild toàn bộ nội dung, metadata, assets path, download links và GitHub links theo ADNzalo.
- Compatibility: chỉ giữ migration có lý do dữ liệu cũ (localStorage/workflow export); không giữ branding Deplao trong UI, docs, runtime, publish hoặc external links.

## Phase A: Independent Repository

1. Cập nhật identity Electron, protocol `adnzalo://`, user-data/database fallback, package metadata, scripts và GitHub Actions.
2. Cập nhật GitHub release/update URLs và publish target.
3. Tạo orphan `main` sau khi toàn bộ phase A-D đã kiểm tra, không đưa lịch sử Deplao lên remote ADNZalo.

## Phase B: ADN Product Identity

1. Đổi backend/tracking/integration source sang ADN endpoint.
2. Tạo semantic design tokens cho light/dark mode và thay lớp màu Deplao trong app chrome, navigation, surfaces, controls, focus states và status colors.
3. Giữ hành vi và route cũ để không phá các module Zalo, CRM, workflow, AI, relay.

## Phase C: Active Hidden-Member Scan

1. Nút `Quét tất cả` trên tab scan phải gọi thật, theo account đang chọn.
2. Quét tuần tự từng group bằng backend scan ADN, lưu `page_group_member` với `owner_zalo_id` đúng account.
3. Có progress tổng, nút dừng, lỗi từng nhóm không làm hỏng cả batch, fallback local sync nếu API scan lỗi.
4. Dùng dữ liệu đã lưu làm nguồn cho TargetSelector và CRMQueue để gửi DM đến UID thành viên ẩn.

## Phase D: Landing Rebuild

1. Thay toàn bộ copy, logo alt, metadata, canonical, OG/Twitter paths, download filenames và legal/support links.
2. Dùng palette ADN, typography/spacing nhất quán, responsive mobile, trạng thái CTA rõ ràng.
3. Loại bỏ mọi tham chiếu user-visible đến Deplao và `babyvibe/deplao-builder`.

## Verification

- `npm run build:electron`
- `npm run build:renderer`
- `npm --prefix landing run build` hoặc lệnh build tương ứng của landing
- Grep case-insensitive `deplao|babyvibe/deplao-builder|deplaoapp.com` ngoài `node_modules`, build output và migration compatibility có chú thích.
- Kiểm tra `git log --oneline -1` sau orphan và `git remote -v` trỏ tới `JJOEEY/ADNZalo`.
- Manual smoke: mở app, đổi theme, vào CRM → Quét thành viên, quét một account có nhóm, tạo campaign từ members, kiểm tra relay/landing links.
