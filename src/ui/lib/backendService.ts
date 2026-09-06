/**
 * Backend Service — Giao tiếp với Backend Server của ADNzalo
 *
 * Backend xử lý: quét nhóm ẩn + kho tích lũy thành viên.
 * App chỉ gọi API, không chứa logic business.
 *
 * API endpoints:
 *   POST https://adncapital.com.vn/api/scan/group → quét thành viên nhóm
 *   POST https://adncapital.com.vn/api/scan/premium-status → kiểm tra premium (legacy)
 */

const PRIMARY_BACKEND_URL = 'https://adncapital.com.vn';
/**
 * Khóa chia sẻ app ↔ backend (rotated). Lưu ý kiến trúc: khóa ship trong mỗi
 * installer nên chỉ coi là chặn lộ tầng 1 — bảo vệ thật nằm ở rate limit +
 * nginx route allowlist phía backend. Khóa cũ (các bản ≤1.0.0) bị backend
 * từ chối dần qua biến SECRET_KEY_LEGACY trên VPS.
 */
const SECRET_KEY = '27d2d008b03fda5234f013550dd39ca9de3f06fd79e45273ff7eefcfc04f6b36';

interface PremiumStatus {
  isPremium: boolean;
  expiresAt: string | null; // ISO date string
}

interface ScanGroupResult {
  success: boolean;
  groupId: string;
  totalMembers: number;
  members: Array<{
    userId: string;
    displayName: string;
    zaloName: string;
    avatar: string;
    accountStatus: number;
    type: number;
    lastUpdateTime: number;
    globalId: string;
    id: string;
  }>;
  error?: string;
}

/**
 * Mã hóa body bằng AES-128-CBC trước khi gửi lên backend.
 * Dùng Node crypto khi chạy trong Electron main/preload, fallback sang crypto-js
 * trong renderer (vite externalize 'crypto' nên import('crypto') sẽ fail).
 */
async function encryptBody(body: object): Promise<string> {
  const plain = JSON.stringify(body);
  // 1) Thử Node crypto (Electron main hoặc preload có window.require)
  try {
    const nodeCrypto: any = (window as any).require
      ? (window as any).require('crypto')
      : null;
    if (nodeCrypto?.createCipheriv) {
      const key = (globalThis as any).Buffer
        ? (globalThis as any).Buffer.from(SECRET_KEY, 'hex').slice(0, 16)
        : Buffer.from(SECRET_KEY, 'hex').slice(0, 16);
      const iv = (globalThis as any).Buffer
        ? (globalThis as any).Buffer.alloc(16, 0)
        : Buffer.alloc(16, 0);
      const cipher = nodeCrypto.createCipheriv('aes-128-cbc', key, iv);
      let encrypted = cipher.update(plain, 'utf8', 'base64');
      encrypted += cipher.final('base64');
      return encrypted;
    }
  } catch {}
  // 2) Fallback thuần JS bằng crypto-js (đã có sẵn trong dependencies)
  try {
    const CryptoJS: any = await import('crypto-js');
    const key = CryptoJS.enc.Hex.parse(SECRET_KEY.slice(0, 32));
    const iv = CryptoJS.enc.Hex.parse('00000000000000000000000000000000');
    const encrypted = CryptoJS.AES.encrypt(plain, key, {
      iv,
      mode: CryptoJS.mode.CBC,
      padding: CryptoJS.pad.Pkcs7,
    });
    // CryptoJS trả về base64 của ciphertext thuần (không có Salt), tương thích Node decipher
    return encrypted.ciphertext.toString(CryptoJS.enc.Base64);
  } catch (err) {
    // Không bao giờ gửi plaintext (body chứa cookie/imei) — fail cứng
    console.error('[backendService] encryptBody failed');
    throw new Error('Mã hóa dữ liệu quét thất bại — không gửi yêu cầu');
  }
}

async function callBackend<T>(endpoint: string, body: object): Promise<T> {
  const url = `${PRIMARY_BACKEND_URL}${endpoint}`;
  const encryptedBody = await encryptBody(body);
  const payload = { page_id: (body as any).page_id || '', body: encryptedBody };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': SECRET_KEY },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return data as T;
}

// ─── API Methods ────────────────────────────────────────────────────────────

/**
 * Lấy trạng thái Premium của page.
 * ADNzalo: luôn Premium để không chặn quét ẩn.
 */
export async function getPremiumStatus(_pageId: string): Promise<PremiumStatus> {
  return { isPremium: true, expiresAt: null };
}

/**
 * Quét thành viên nhóm qua backend.
 * Backend tự tích lũy kết quả vào kho thành viên ADN và hợp nhất khi bị
 * lockViewMember giới hạn. FE gọi khi user ấn "Quét".
 */
export async function scanGroupViaBackend(params: {
  pageId: string;
  cookie: string;
  imei: string;
  userAgent: string;
  groupId: string;
}): Promise<ScanGroupResult> {
  try {
    const res = await callBackend<ScanGroupResult>('/api/scan/group', {
      page_id: params.pageId,
      cookie: params.cookie,
      imei: params.imei,
      userAgent: params.userAgent,
      groupId: params.groupId,
    });
    return res;
  } catch (err: any) {
    console.error('[backendService] scanGroupViaBackend error:', err);
    return { success: false, groupId: params.groupId, totalMembers: 0, members: [], error: err.message || 'Lỗi kết nối backend' };
  }
}
