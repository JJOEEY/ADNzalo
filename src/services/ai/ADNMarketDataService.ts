/**
 * ADNMarketDataService.ts
 *
 * Nguồn dữ liệu chứng khoán LIVE cho AI Assistant, lấy qua "MCP ADN":
 * cổng /api/cowork/* của app ADN Capital (repo D:\BOT\adn-ai-bot).
 *
 * Cổng này được thiết kế đúng nghĩa MCP: chỉ đọc, khoá bằng ADN_API_KEY
 * (header x-api-key hoặc Bearer), rate-limit 30 req/10s, fail-closed khi
 * thiếu key. Các endpoint:
 *   GET /api/cowork/market               → snapshot thị trường (chỉ số, breadth, dòng tiền, top tăng/giảm) + text
 *   GET /api/cowork/ticker?symbol=FPT    → kỹ thuật (MA/RSI/MACD/hỗ trợ-kháng cự) + cơ bản (P/E, P/B...) theo mã
 *   GET /api/cowork/brief?type=eod       → bối cảnh thị trường + tin phân loại (EOD/morning)
 *   GET /api/cowork/rank                 → danh sách mã dẫn dắt (RS rating)
 *
 * AI chỉ tự động gắn ngữ cảnh này khi tin nhắn có "dấu hiệu chứng khoán"
 * (mã $FPT, VNINDEX, "phân tích", "mua/bán"...) để không tốn token cho
 * hội thoại bán hàng thường.
 */

import DatabaseService from '../database/DatabaseService';
import Logger from '../../utils/Logger';
import { safeStorage } from 'electron';

// ─── API key protection (giống trợ lý AI: safeStorage, prefix 'enc:') ───────

function protectApiKey(key: string): string {
    if (!key) return '';
    if (key.startsWith('enc:')) return key;
    try {
        if (safeStorage.isEncryptionAvailable()) {
            return 'enc:' + safeStorage.encryptString(key).toString('base64');
        }
    } catch {}
    return key;
}

function unprotectApiKey(raw: string): string {
    if (!raw) return '';
    if (raw.startsWith('enc:')) {
        try {
            return safeStorage.decryptString(Buffer.from(raw.slice(4), 'base64'));
        } catch {}
    }
    return raw;
}

// ─── Config persisted trong DB settings ─────────────────────────────────────

export interface ADNMarketConfig {
    enabled: boolean;
    baseUrl: string;   // vd http://localhost:3000 (adn-ai-bot dev) hoặc https://adncapital.com.vn
    apiKey: string;    // = ADN_API_KEY đặt bên app ADN Capital
}

const SETTINGS_KEY = 'adn_market_mcp_config';

export const ADN_MARKET_DEFAULT_CONFIG: ADNMarketConfig = {
    enabled: false,
    baseUrl: 'http://localhost:3000',
    apiKey: '',
};

// ─── Stock-cue detection (mirror adn-ai-bot/src/lib/aiden/stock-v2-chat.ts) ──

const STOCK_CUE_PATTERN =
    /\b(phan tich|co phieu|chung khoan|ma|ticker|gia|mua|ban|target|ho tro|khang cu|ptkt|ptcb|ta|fa|chart|dinh gia|bao cao|bctc|vnindex|hnxindex|upcomindex|vn30|do rong|dong tien|tu doanh|ngoai te|khoi ngoai)\b/i;

function stripDiacritics(value: string): string {
    return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function hasStockCue(message: string): boolean {
    return STOCK_CUE_PATTERN.test(stripDiacritics(message).toLowerCase());
}

/** Trích mã chuyển đổi bằng cách quét các token kiểu ticker: $FPT, mã HOSE viết HOA... */
function collectTickerCandidates(message: string): string[] {
    const candidates = new Set<string>();
    for (const match of message.matchAll(/\$([A-Za-z0-9._-]{2,12})\b/g)) {
        candidates.add((match[1] ?? '').toUpperCase());
    }
    for (const match of message.matchAll(/\b([A-Z][A-Z0-9]{1,9})\b/g)) {
        const token = match[1] ?? '';
        // Loại token viết hoa thông dụng không phải mã CK
        if (!['ADN', 'UID', 'SMS', 'OTP', 'PDF', 'URL', 'API', 'ZALO', 'CHAT'].includes(token)) {
            candidates.add(token);
        }
    }
    // Mã gõ thường ("fpt hôm nay sao") — chỉ token 3 chữ cái, loại trừ từ tiếng Việt phổ biến
    const lowered = stripDiacritics(message).toLowerCase();
    for (const match of lowered.matchAll(/\b([a-z]{3})(?![a-z])/g)) {
        const token = match[1] ?? '';
        if (!VN_COMMON_WORDS.has(token)) candidates.add(token.toUpperCase());
    }
    return Array.from(candidates)
        .map(c => c.trim().toUpperCase())
        .filter(c => /^[A-Z][A-Z0-9._-]{1,11}$/.test(c))
        .slice(0, 3);
}

// Từ tiếng Việt 3 chữ cái thường gặp — không phải mã CK (đã strip dấu, lowercase)
const VN_COMMON_WORDS = new Set([
    'cho', 'mua', 'ban', 'gia', 'anh', 'chi', 'em', 'toi', 'may', 'ong', 'ba', 'co', 'chu', 'bac',
    'nay', 'hom', 'qua', 'mai', 'tuan', 'thang', 'nam', 'sang', 'chieu', 'toi', 'dem',
    'voi', 'cua', 'cai', 'nay', 'thi', 'la', 'va', 'hoac', 'mot', 'hai', 'con', 'bao', 'tin',
    'dau', 'cuoi', 'moi', 'cu', 'tot', 'xau', 'cao', 'thap', 'tang', 'giam', 'roi', 'chua', 'dang',
    'se', 'da', 'co', 'khong', 'nen', 'ma', 'gi', 'dong', 'tien', 'ty', 'trieu', 'tram', 'nghin',
    'phan', 'lai', 'lo', 'von', 'no', 'tai', 'khoan', 'phien', 'khop', 'lenh', 'dat', 'huy', 'sua',
    'xem', 'giup', 'minh', 'bao', 'cao', 'the', 'nao', 'sao', 'the', 'nao', 'khi', 'neu', 'vi', 'de',
    'do', 'bi', 'duoc', 'hay', 'rat', 'qua', 'lam', 'theo', 'tu', 'den', 'tren', 'duoi', 'trong',
    'ngoai', 'giua', 'nen', 'moi', 'hoi', 'voi', 'het', 'mac', 'nhu', 'vay', 'kia', 'day',
    'atc', 'ato',
]);

// ─── Formatting helpers ──────────────────────────────────────────────────────

function fmtNum(v: unknown, digits = 2): string {
    const n = Number(v);
    if (!Number.isFinite(n)) return 'N/A';
    return n.toLocaleString('vi-VN', { maximumFractionDigits: digits });
}

function fmtPct(v: unknown): string {
    const n = Number(v);
    if (!Number.isFinite(n)) return '';
    return `${n > 0 ? '+' : ''}${fmtNum(n)}%`;
}

/** Rút gọn snapshot thị trường thành đoạn text ngắn cho system prompt */
function formatMarketSnapshot(snap: any): string {
    const lines: string[] = [];
    const indices = Array.isArray(snap?.indices) ? snap.indices : [];
    for (const idx of indices) {
        const name = String(idx?.symbol ?? '').replace('INDEX', '');
        const pct = fmtPct(idx?.changePct);
        lines.push(`- ${name}: ${fmtNum(idx?.value, 2)}${pct ? ` (${pct})` : ''}`);
    }
    const breadth = snap?.breadth?.total;
    if (breadth && (breadth.up != null || breadth.down != null)) {
        lines.push(`- Độ rộng: ${breadth.up ?? '?'} tăng / ${breadth.down ?? '?'} giảm`);
    }
    const investor = snap?.investorTrading;
    if (investor?.foreignNet != null) {
        const nn = Number(investor.foreignNet);
        const tỷ = (nn / 1e9).toFixed(2);
        lines.push(`- Khối ngoại: ${nn >= 0 ? 'mua' : 'bán'} ròng ~${Math.abs(Number(tỷ))} tỷ đồng`);
    }
    const gainers = Array.isArray(snap?.topGainers) ? snap.topGainers.slice(0, 5) : [];
    const losers = Array.isArray(snap?.topLosers) ? snap.topLosers.slice(0, 5) : [];
    const topStr = (arr: any[]) => arr
        .map((t: any) => `${t?.symbol ?? t?.ticker ?? '?'}${t?.changePct != null ? ` ${fmtPct(t.changePct)}` : ''}`)
        .join(', ');
    if (gainers.length) lines.push(`- Top tăng: ${topStr(gainers)}`);
    if (losers.length) lines.push(`- Top giảm: ${topStr(losers)}`);
    return lines.join('\n');
}

/** Rút gọn dữ liệu 1 mã (kỹ thuật + cơ bản) thành đoạn text ngắn */
function formatTickerData(symbol: string, data: any): string {
    const lines: string[] = [`Mã ${symbol}:`];
    const ta = data?.technical ?? {};
    if (ta.price != null || ta.currentPrice != null) {
        const price = ta.price ?? ta.currentPrice;
        const pct = fmtPct(ta.changePct);
        lines.push(`- Giá: ${fmtNum(price)}${pct ? ` (${pct})` : ''}`);
    }
    const maParts: string[] = [];
    if (ta.ma20 != null) maParts.push(`MA20 ${fmtNum(ta.ma20)}`);
    if (ta.ma50 != null) maParts.push(`MA50 ${fmtNum(ta.ma50)}`);
    if (ta.ma200 != null) maParts.push(`MA200 ${fmtNum(ta.ma200)}`);
    if (maParts.length) lines.push(`- ${maParts.join(' | ')}`);
    if (ta.rsi != null) lines.push(`- RSI ${fmtNum(ta.rsi, 1)}`);
    if (ta.support != null || ta.resistance != null) {
        lines.push(`- Hỗ trợ ${ta.support != null ? fmtNum(ta.support) : '?'} / Kháng cự ${ta.resistance != null ? fmtNum(ta.resistance) : '?'}`);
    }
    const fa = data?.fundamental ?? {};
    const faParts: string[] = [];
    if (fa.pe != null) faParts.push(`P/E ${fmtNum(fa.pe, 1)}`);
    if (fa.pb != null) faParts.push(`P/B ${fmtNum(fa.pb, 1)}`);
    if (faParts.length) lines.push(`- ${faParts.join(' | ')}`);
    return lines.filter((l, i) => i === 0 || l.includes(': ') || l.startsWith('- ')).join('\n');
}

// ─── Service ─────────────────────────────────────────────────────────────────

class ADNMarketDataService {
    private static instance: ADNMarketDataService;

    public static getInstance(): ADNMarketDataService {
        if (!ADNMarketDataService.instance) ADNMarketDataService.instance = new ADNMarketDataService();
        return ADNMarketDataService.instance;
    }

    private constructor() {}

    // ─── Config CRUD ────────────────────────────────────────────────────────

    public getConfig(): ADNMarketConfig {
        try {
            const raw = DatabaseService.getInstance().getSetting(SETTINGS_KEY);
            if (!raw) return { ...ADN_MARKET_DEFAULT_CONFIG };
            const parsed = JSON.parse(raw);
            return {
                enabled: !!parsed.enabled,
                baseUrl: String(parsed.baseUrl || ADN_MARKET_DEFAULT_CONFIG.baseUrl).replace(/\/+$/, ''),
                apiKey: unprotectApiKey(String(parsed.apiKey || '')),
            };
        } catch {
            return { ...ADN_MARKET_DEFAULT_CONFIG };
        }
    }

    public saveConfig(config: Partial<ADNMarketConfig>): void {
        const merged = { ...this.getConfig(), ...config };
        merged.baseUrl = merged.baseUrl.replace(/\/+$/, '');
        merged.apiKey = protectApiKey(merged.apiKey);
        DatabaseService.getInstance().setSetting(SETTINGS_KEY, JSON.stringify(merged));
        DatabaseService.getInstance().save();
    }

    public isConfigured(): boolean {
        const c = this.getConfig();
        return c.enabled && !!c.baseUrl && !!c.apiKey;
    }

    // ─── HTTP client ────────────────────────────────────────────────────────

    private async fetchCowork(path: string, timeoutMs = 15000): Promise<any | null> {
        const { baseUrl, apiKey } = this.getConfig();
        if (!baseUrl || !apiKey) return null;
        try {
            const res = await fetch(`${baseUrl}${path}`, {
                signal: AbortSignal.timeout(timeoutMs),
                headers: { 'x-api-key': apiKey, Accept: 'application/json' },
            });
            if (!res.ok) {
                Logger.warn(`[ADNMarket] ${path} → HTTP ${res.status}`);
                return null;
            }
            const text = await res.text();
            if (!text?.trim()) return null;
            return JSON.parse(text);
        } catch (err: any) {
            Logger.warn(`[ADNMarket] ${path} failed: ${err?.message || err}`);
            return null;
        }
    }

    // ─── Public data fetchers ───────────────────────────────────────────────

    public async fetchMarket(): Promise<any | null> {
        return this.fetchCowork('/api/cowork/market');
    }

    public async fetchTicker(symbol: string): Promise<any | null> {
        const sym = symbol.trim().toUpperCase();
        if (!/^[A-Z0-9]{2,10}$/.test(sym)) return null;
        const res = await this.fetchCowork(`/api/cowork/ticker?symbol=${encodeURIComponent(sym)}`);
        return res?.data ?? null;
    }

    public async fetchRank(): Promise<any[] | null> {
        const res = await this.fetchCowork('/api/cowork/rank');
        return Array.isArray(res?.leaders) ? res.leaders : null;
    }

    /** Kiểm tra kết nối tới cổng MCP ADN (dùng cho nút Test trong UI) */
    public async testConnection(): Promise<{ success: boolean; message: string }> {
        const config = this.getConfig();
        if (!config.baseUrl || !config.apiKey) {
            return { success: false, message: '❌ Chưa nhập Base URL / API key của cổng ADN MCP' };
        }
        try {
            const res = await this.fetchCowork('/api/cowork/market', 15000);
            if (!res) {
                return { success: false, message: `❌ Không kết nối được ${config.baseUrl}/api/cowork/market (kiểm tra URL, API key và app ADN Capital đang chạy)` };
            }
            const indices = Array.isArray(res?.data?.indices) ? res.data.indices.length : 0;
            return { success: true, message: `✅ Kết nối OK — snapshot thị trường có ${indices} chỉ số${res?.text ? ' + bản tóm tắt' : ''}` };
        } catch (e: any) {
            return { success: false, message: `❌ Lỗi: ${e?.message || e}` };
        }
    }

    /**
     * Dựng khối ngữ cảnh chứng khoán cho system prompt.
     * Chỉ fetch khi tin nhắn có dấu hiệu chứng khoán — otherwise trả '' để tiết kiệm token/latency.
     */
    public async buildStockContext(userMessage: string, maxTickers = 2): Promise<string> {
        if (!this.isConfigured()) return '';
        if (!userMessage || !hasStockCue(userMessage)) return '';

        const parts: string[] = [];

        // 1. Snapshot thị trường (luôn lấy khi có cue)
        const market = await this.fetchMarket();
        const marketText = market?.text || formatMarketSnapshot(market?.data);
        if (marketText) parts.push(`Thị trường hiện tại:\n${marketText}`);

        // 2. Chi tiết từng mã được nhắc đến (tối đa maxTickers, chạy song song)
        const tickers = collectTickerCandidates(userMessage).slice(0, maxTickers);
        if (tickers.length > 0) {
            const details = await Promise.all(tickers.map(t => this.fetchTicker(t)));
            for (let i = 0; i < tickers.length; i++) {
                if (details[i]) parts.push(formatTickerData(tickers[i], details[i]));
            }
        }

        if (parts.length === 0) return '';
        return `\n\n[Dữ liệu chứng khoán LIVE từ ADN Capital — cập nhật ${new Date().toLocaleTimeString('vi-VN')}]\n${parts.join('\n\n')}\nDùng số liệu này để trả lời chính xác, KHÔNG tự bịa số.`;
    }
}

export default ADNMarketDataService;
