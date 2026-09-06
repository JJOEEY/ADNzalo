import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { Zalo } from 'zca-js';
import 'dotenv/config';

// package.json đặt "type": "module" → không có __dirname, tự suy ra từ import.meta.url
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.set('trust proxy', 1);
app.use(cors({ origin: true }));
app.use(express.json({ limit: '1mb' }));

// Security headers — API JSON thuần, không phục vụ trình duyệt trực tiếp
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'no-referrer');
  res.set('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  next();
});

const SECRET_KEY = process.env.SECRET_KEY || '';
// Khóa cũ thời kỳ trước rotate — chỉ để chấp nhận request từ app 1.0.0 chưa
// nâng cấp. Xóa biến này khỏi .env sau khi toàn bộ client đã lên bản mới.
const SECRET_KEY_LEGACY = process.env.SECRET_KEY_LEGACY || '';
const PORT = Number(process.env.PORT || 3100);
const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

const VALID_KEYS = [SECRET_KEY, SECRET_KEY_LEGACY].filter(
  (k) => /^[0-9a-fA-F]{32,}$/.test(k),
);
if (!/^[0-9a-fA-F]{32,}$/.test(SECRET_KEY)) {
  throw new Error('SECRET_KEY must be provided as a hexadecimal string');
}

const rateLimitState = new Map();
const RATE_LIMIT = 60;
const RATE_WINDOW_MS = 60 * 1000;

function rateLimit(req, res, next) {
  const now = Date.now();
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const previous = rateLimitState.get(ip);
  const state = !previous || now - previous.startedAt >= RATE_WINDOW_MS
    ? { startedAt: now, count: 0 }
    : previous;
  state.count += 1;
  rateLimitState.set(ip, state);
  if (state.count > RATE_LIMIT) {
    const retryAfter = Math.ceil((state.startedAt + RATE_WINDOW_MS - now) / 1000);
    res.set('Retry-After', String(retryAfter));
    return res.status(429).json({ success: false, error: 'Rate limit exceeded' });
  }
  return next();
}

setInterval(() => {
  const cutoff = Date.now() - RATE_WINDOW_MS;
  for (const [ip, state] of rateLimitState) {
    if (state.startedAt < cutoff) rateLimitState.delete(ip);
  }
}, RATE_WINDOW_MS).unref();

// ── AES decrypt giống backendService.ts:46 ──────────────────────────────────
function decryptBody(encryptedB64) {
  if (typeof encryptedB64 !== 'string' || encryptedB64.length === 0 || encryptedB64.length > 900_000) {
    return null;
  }
  // Thử khóa mới trước rồi khóa legacy — client cũ mã hóa bằng khóa cũ
  for (const key of VALID_KEYS) {
    try {
      const keyBuf = Buffer.from(key, 'hex').slice(0, 16);
      const iv = Buffer.alloc(16, 0);
      const decipher = crypto.createDecipheriv('aes-128-cbc', keyBuf, iv);
      let dec = decipher.update(encryptedB64, 'base64', 'utf8');
      dec += decipher.final('utf8');
      return JSON.parse(dec);
    } catch {}
  }
  // Plain base64 is opt-in for local development only.
  if (process.env.ALLOW_PLAIN_PAYLOAD !== '1') return null;
  try { return JSON.parse(Buffer.from(encryptedB64, 'base64').toString('utf8')); } catch { return null; }
}

function requireApiKey(req, res, next) {
  const supplied = String(req.headers['x-api-key'] || '');
  const actual = Buffer.from(supplied);
  const ok = VALID_KEYS.some((key) => {
    const expected = Buffer.from(key);
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  });
  if (!ok) {
    return res.status(401).json({ success: false, error: 'Invalid API key' });
  }
  return next();
}

function parseCookieJar(rawCookie) {
  const parsed = typeof rawCookie === 'string' ? JSON.parse(rawCookie) : rawCookie;
  const cookies = Array.isArray(parsed) ? parsed : parsed?.cookies;
  if (!Array.isArray(cookies) || cookies.length === 0) {
    throw new Error('Invalid Zalo cookie jar');
  }
  return parsed;
}

function normalizeMember(member) {
  const userId = String(member?.id || member?.userId || member?.uid || '').replace(/_0$/, '');
  return {
    userId,
    displayName: member?.dName || member?.displayName || member?.zaloName || '',
    zaloName: member?.zaloName || '',
    avatar: member?.avatar || member?.avatar_25 || '',
    accountStatus: Number(member?.accountStatus || 0),
    type: Number(member?.type || 0),
    id: userId,
  };
}

function extractIdsFromGroupInfo(gData) {
  const rawIds =
    (Array.isArray(gData.memberIds) && gData.memberIds.length > 0 ? gData.memberIds : null) ??
    (Array.isArray(gData.currentMems) && gData.currentMems.length > 0 ? gData.currentMems.map((m) => String(m.id || '')) : null) ??
    (Array.isArray(gData.memVerList) ? gData.memVerList : null) ??
    (gData.memVerList && typeof gData.memVerList === 'object' ? Object.keys(gData.memVerList) : null) ??
    [];
  const ids = [...rawIds];
  // Bổ sung: thành viên mới tham gia gần đây + danh sách admin (kèm profile)
  for (const m of gData.updateMems || []) {
    if (m?.id) ids.push(String(m.id));
    if (m?.memberId) ids.push(String(m.memberId));
  }
  for (const a of gData.admins || []) {
    if (a?.id) ids.push(String(a.id));
    if (typeof a === 'string') ids.push(a);
  }
  return [...new Set(ids.map((id) => String(id).replace(/_0$/, '').trim()).filter((id) => /^\d+$/.test(id)))];
}

async function enrichMembers(api, memberIds) {
  if (memberIds.length === 0) return [];
  // Thử getGroupMembersInfo trước (nhanh, batch theo Zalo)
  try {
    const res = await api.getGroupMembersInfo(memberIds);
    const map = res?.data ?? res?.memberInfoMap ?? res?.response ?? {};
    // zca-js getGroupMembersInfo trả về map {uid: profile}
    if (map && typeof map === 'object' && !Array.isArray(map)) {
      const out = [];
      for (const uid of memberIds) {
        const p = map[uid] ?? map[`${uid}_0`] ?? null;
        if (p) {
          out.push({
            userId: uid,
            displayName: p.displayName || p.zaloName || p.dName || '',
            zaloName: p.zaloName || '',
            avatar: p.avatar || p.avatar_25 || '',
            accountStatus: Number(p.accountStatus || 0),
            type: Number(p.type || 0),
            id: uid,
          });
        } else {
          out.push({ userId: uid, displayName: '', zaloName: '', avatar: '', accountStatus: 0, type: 0, id: uid });
        }
      }
      if (out.some((m) => m.displayName)) return out;
    }
  } catch {}
  // Fallback: getUserInfo batch 200 (đắt hơn nhưng chắc chắn có tên)
  const BATCH = 200;
  const enriched = [];
  for (let i = 0; i < memberIds.length; i += BATCH) {
    const batch = memberIds.slice(i, i + BATCH);
    try {
      const uRes = await api.getUserInfo(batch);
      const changed = uRes?.changed_profiles ?? uRes?.response?.changed_profiles ?? {};
      for (const uid of batch) {
        const p = changed[uid] ?? changed[`${uid}_0`] ?? null;
        if (p) {
          enriched.push({
            userId: uid,
            displayName: p.displayName || p.zaloName || p.dName || '',
            zaloName: p.zaloName || '',
            avatar: p.avatar || p.avatar_25 || '',
            accountStatus: Number(p.accountStatus || 0),
            type: Number(p.type || 0),
            id: uid,
          });
        } else {
          enriched.push({ userId: uid, displayName: '', zaloName: '', avatar: '', accountStatus: 0, type: 0, id: uid });
        }
      }
    } catch {
      for (const uid of batch) enriched.push({ userId: uid, displayName: '', zaloName: '', avatar: '', accountStatus: 0, type: 0, id: uid });
    }
    if (i + BATCH < memberIds.length) await new Promise((r) => setTimeout(r, 120));
  }
  return enriched;
}

const apiCache = new Map();
// Lỗi phiên/session Zalo — server phải login lại thay vì reuse cache
function isSessionError(e) {
  const msg = String(e?.message || e || '');
  return msg.includes('zpw_sek') || msg.includes('Đăng nhập') || msg.includes('đăng nhập');
}
async function getCachedApi(pageId, cookie, imei, userAgent, forceRefresh = false) {
  const key = `${pageId}:${imei}`;
  // Nếu cookie đổi (sau khi đăng nhập lại) thì xóa cache cũ.
  // Hash TOÀN BỘ cookie: cookie là JSON jar nên slice(0,64) luôn trùng prefix hằng.
  const cookieHash = crypto.createHash('sha256').update(String(cookie)).digest('hex');
  const cached = apiCache.get(key);
  if (!forceRefresh && cached && Date.now() - cached.ts < 5 * 60 * 1000 && cached.cookieHash === cookieHash) {
    console.warn(`[scan] reuse cached api for ${pageId}`);
    return cached.api;
  }
  if (cached && cached.cookieHash !== cookieHash) console.warn(`[scan] cookie changed for ${pageId}, refreshing login`);
  const zalo = new Zalo({ checkUpdate: false, logging: false, apiType: 30, apiVersion: 671 });
  const api = await zalo.login({ cookie: parseCookieJar(cookie), imei, userAgent: userAgent || DEFAULT_USER_AGENT, language: 'vi' });
  apiCache.set(key, { api, ts: Date.now(), cookieHash });
  console.warn(`[scan] login ok for ${pageId}`);
  return api;
}

// ── Kho cache thành viên ADN ────────────────────────────────────────────────
// Mỗi lần quét live thành công, kết quả được tích lũy theo groupId (atomic
// write, debounce 3s). Khi live bị lockViewMember giới hạn, hợp nhất (union)
// với kho để trả tối đa số thành viên đã biết — thay cho pool bên ngoài.
const CACHE_DIR = process.env.CACHE_DIR || path.join(__dirname, 'data');
const CACHE_FILE = path.join(CACHE_DIR, 'member-cache.json');
let memberCache = {};
let cacheSaveTimer = null;
try {
  if (fs.existsSync(CACHE_FILE)) {
    memberCache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  }
  console.warn(`[cache] loaded ${Object.keys(memberCache).length} groups from member cache`);
} catch (e) {
  console.warn(`[cache] load failed: ${e.message}`);
  memberCache = {};
}

function scheduleCacheSave() {
  if (cacheSaveTimer) return;
  cacheSaveTimer = setTimeout(() => {
    cacheSaveTimer = null;
    try {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
      const tmp = `${CACHE_FILE}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(memberCache));
      fs.renameSync(tmp, CACHE_FILE);
      console.warn(`[cache] saved ${Object.keys(memberCache).length} groups`);
    } catch (e) {
      console.warn(`[cache] save failed: ${e.message}`);
    }
  }, 3000);
  cacheSaveTimer.unref?.();
}

function cacheUpsertMembers(groupId, members) {
  if (!/^\d+$/.test(String(groupId)) || !Array.isArray(members) || members.length === 0) return;
  const bucket = memberCache[String(groupId)] || (memberCache[String(groupId)] = {});
  const now = Date.now();
  let added = 0;
  for (const m of members) {
    const uid = String(m?.userId || m?.id || '').replace(/_0$/, '');
    if (!/^\d+$/.test(uid)) continue;
    const prev = bucket[uid];
    if (!prev) added += 1;
    bucket[uid] = {
      displayName: m.displayName || m.name || prev?.displayName || '',
      zaloName: m.zaloName || prev?.zaloName || '',
      avatar: m.avatar || prev?.avatar || '',
      lastSeenAt: now,
    };
  }
  scheduleCacheSave();
  console.warn(`[cache] upsert ${groupId}: +${added} new, total ${Object.keys(bucket).length}`);
}

function cacheGetMembers(groupId) {
  const bucket = memberCache[String(groupId)];
  if (!bucket) return [];
  return Object.entries(bucket).map(([uid, p]) => ({
    userId: uid,
    id: uid,
    displayName: p.displayName || '',
    zaloName: p.zaloName || '',
    avatar: p.avatar || '',
    accountStatus: 0,
    type: 0,
    source: 'cache',
  }));
}

/** Hợp nhất cache vào danh sách live khi live bị giới hạn (ít hơn tổng báo cáo) */
function mergeWithCache(groupId, liveMembers, totalReported) {
  const total = Number(totalReported || 0);
  if (liveMembers.length >= total && total > 0) return { members: liveMembers, merged: 0 };
  const seen = new Set(liveMembers.map((m) => m.userId));
  const merged = [...liveMembers];
  for (const c of cacheGetMembers(groupId)) {
    if (!seen.has(c.userId)) {
      seen.add(c.userId);
      merged.push(c);
    }
  }
  if (merged.length > liveMembers.length) {
    console.warn(`[scan] cache merge ${groupId}: live=${liveMembers.length} +cache=${merged.length - liveMembers.length} (reported ${total})`);
  }
  return { members: merged, merged: merged.length - liveMembers.length };
}

async function scanGroupMembers({ groupId, cookie, imei, userAgent, pageId }) {
  const api = await getCachedApi(pageId || groupId, cookie, imei, userAgent);
  // Gom lỗi phiên Zalo từ các bước: mỗi bước catch riêng nên lỗi gốc
  // (zpw_sek/đăng nhập) phải được lan truyền ra ngoài để handler login lại,
  // thay vì bị nuốt thành 'Cannot fetch group info' generic.
  let sessionError = null;
  const markSession = (e) => { if (!sessionError && isSessionError(e)) sessionError = e; };

  // 1) Thử qua invite link nếu có (paginate currentMems)
  const scanViaLink = async (link) => {
    const members = [];
    const seen = new Set();
    for (let page = 1; page <= 100; page += 1) {
      const response = await api.getGroupLinkInfo({ link, memberPage: page });
      for (const rawMember of response?.currentMems || []) {
        const member = normalizeMember(rawMember);
        if (/^\d+$/.test(member.userId) && !seen.has(member.userId)) {
          seen.add(member.userId);
          members.push(member);
        }
      }
      if (!response?.hasMoreMember) break;
    }
    return members;
  };

  // 1a) Invite link hiện có
  try {
    const linkDetail = await api.getGroupLinkDetail(groupId);
    const link = linkDetail?.link;
    if (link) {
      const members = await scanViaLink(link);
      if (members.length > 2) return members;
      if (members.length > 0 && members.length <= 2) {
        console.warn(`[scan] link scan only ${members.length} members for ${groupId}, trying direct groupId`);
      } else if (members.length > 0) {
        return members;
      }
    } else {
      console.warn(`[scan] no invite link for ${groupId}, will try direct groupId + enable`);
    }
  } catch (e) {
    markSession(e);
    console.warn(`[scan] link scan failed for ${groupId}: ${e.message}`);
  }

  // 1b) Thử dùng groupId như link (nhiều tool/Deplao làm vậy cho nhóm ẩn)
  try {
    const members = await scanViaLink(groupId);
    if (members.length > 2) {
      console.warn(`[scan] direct groupId scan got ${members.length} members for ${groupId}`);
      return members;
    }
    if (members.length > 0) console.warn(`[scan] direct groupId scan only ${members.length} for ${groupId}`);
  } catch (e) {
    markSession(e);
    console.warn(`[scan] direct groupId scan failed for ${groupId}: ${e.message}`);
  }

  // 1c) Thử qua invite-box (api/group/inv-box/inv-info) — endpoint khác, nhiều group ẩn vẫn trả
  try {
    const members = [];
    const seen = new Set();
    for (let page = 1; page <= 20; page += 1) {
      const res = await api.getGroupInviteBoxInfo({ groupId, mcount: 100, mpage: page });
      const g = res?.groupInfo;
      if (!g) break;
      for (const m of g.currentMems || []) {
        const member = normalizeMember(m);
        if (/^\d+$/.test(member.userId) && !seen.has(member.userId)) { seen.add(member.userId); members.push(member); }
      }
      // Nếu không có phân trang riêng, dừng sau 1 trang
      if (!g.hasMoreMember) break;
    }
    if (members.length > 2) {
      console.warn(`[scan] invite-box scan got ${members.length} members for ${groupId}`);
      return members;
    }
    if (members.length > 0) console.warn(`[scan] invite-box scan only ${members.length} for ${groupId}`);
  } catch (e) {
    markSession(e);
    console.warn(`[scan] invite-box scan failed for ${groupId}: ${e.message}`);
  }

  // 1d) KHÔNG tự bật invite link (enableGroupLink) — không thay đổi cài đặt nhóm
  // của người khác; nếu nhóm tắt link và tài khoản không phải admin thì chuyển
  // sang fallback getGroupInfo + vét lịch sử chat + kho cache bên dưới.

  // 2) Fallback cho nhóm ẩn + không link: getGroupInfo memVerList/memberIds (backend, không phụ thuộc link)
  // Thử getGroupInfo với cả groupId và globalId nếu có
  let gData = null;
  let infoRes = null;
  const tryGetGroupInfo = async (gid, label) => {
    try {
      const res = await api.getGroupInfo(gid);
      const map = res?.gridInfoMap ?? res?.response?.gridInfoMap ?? {};
      const data = map[gid] ?? map[groupId] ?? Object.values(map)[0];
      if (data) {
        const mlen = Array.isArray(data.memVerList) ? data.memVerList.length : Object.keys(data.memVerList || {}).length;
        console.warn(`[scan] getGroupInfo ${label} for ${gid}: totalMember=${data.totalMember} memVerList=${mlen} memberIds=${(data.memberIds||[]).length} lockViewMember=${data.setting?.lockViewMember}`);
        return data;
      }
    } catch (e) { markSession(e); console.warn(`[scan] getGroupInfo ${label} failed for ${gid}: ${e.message}`); }
    return null;
  };
  gData = await tryGetGroupInfo(groupId, 'groupId');
  // Chỉ thử globalId khi có giá trị thật (tránh call rỗng gây log nhiễu)
  const globalIdForInfo = String(gData?.globalId || '');
  if ((!gData || extractIdsFromGroupInfo(gData).length <= 4) && globalIdForInfo && globalIdForInfo !== groupId) {
    const g2 = await tryGetGroupInfo(globalIdForInfo, 'globalId');
    if (g2 && extractIdsFromGroupInfo(g2).length > extractIdsFromGroupInfo(gData || {}).length) gData = g2;
  }
  infoRes = gData ? { gridInfoMap: { [groupId]: gData } } : null;
  // Ưu tiên lan truyền lỗi phiên để handler xóa cache + login lại,
  // thay vì lỗi generic khiến retry không bao giờ chạy.
  if (!gData) throw sessionError || new Error('Cannot fetch group info');

  console.warn(`[scan] getGroupInfo raw for ${groupId}: keys=${Object.keys(gData).join(',')} totalMember=${gData.totalMember} hasMoreMember=${gData.hasMoreMember} type=${gData.type} subType=${gData.subType} lockViewMember=${gData.setting?.lockViewMember} creatorId=${gData.creatorId} adminIds=${(gData.adminIds||[]).length} memberIds=${(gData.memberIds||[]).length} currentMems=${(gData.currentMems||[]).length} updateMems=${(gData.updateMems||[]).length} admins=${(gData.admins||[]).length} memVerList=${Array.isArray(gData.memVerList)?gData.memVerList.length:Object.keys(gData.memVerList||{}).length} globalId=${gData.globalId}`);

  const creatorId = String(gData.creatorId || '').replace(/_0$/, '');
  const adminIds = (gData.adminIds || []).map((a) => String(a).replace(/_0$/, ''));
  const adminSet = new Set([creatorId, ...adminIds].filter(Boolean));
  const memberIds = extractIdsFromGroupInfo(gData);
  if (memberIds.length === 0) throw new Error('Empty member list from getGroupInfo');

  // Nếu Zalo chỉ trả trưởng/phó (<=2) và totalMember báo lớn hơn thì đây là giới hạn quyền — thử vét lịch sử bằng mọi cách
  const totalReported = Number(gData.totalMember || 0);
  if (memberIds.length <= 10 && totalReported > memberIds.length) {
    console.warn(`[scan] getGroupInfo limited to ${memberIds.length}/${totalReported} for ${groupId} (lockViewMember=${gData.setting?.lockViewMember}), trying chat-history fallback`);
    const globalId = String(gData.globalId || '');
    const tryHistory = async (gid, label) => {
      const seen = new Set(memberIds);
      const collected = [];
      try {
        // zca-js getGroupChatHistory chỉ nhận (groupId, count) — hỏi 1000 tin,
        // server Zalo có thể trả ít hơn nhưng mình vẫn gom hết những gì nhận được
        const hist = await api.getGroupChatHistory(gid, 1000);
        const msgs = hist?.groupMsgs || hist?.data?.groupMsgs || [];
        for (const msg of msgs) {
          const uid = String(msg.senderId || msg.authorId || msg.uid || msg.fromId || msg.userId || '').replace(/_0$/, '');
          if (/^\d+$/.test(uid) && !seen.has(uid)) { seen.add(uid); collected.push(uid); }
          const mentions = msg.mentions || msg.atMembers || msg.mentionedIds || [];
          for (const m of mentions) { const mid = String(m.uid || m.id || m.userId || '').replace(/_0$/, ''); if (/^\d+$/.test(mid) && !seen.has(mid)) { seen.add(mid); collected.push(mid); } }
          // Một số bản zca-js trả sender trong data.userId
          const altUid = String(msg.data?.uid || msg.data?.senderId || '').replace(/_0$/, '');
          if (/^\d+$/.test(altUid) && !seen.has(altUid)) { seen.add(altUid); collected.push(altUid); }
        }
        console.warn(`[scan] chat-history ${label} collected ${collected.length} extra uids for ${groupId} (total ${seen.size}/${totalReported})`);
        if (collected.length > 0) return [...memberIds, ...collected];
      } catch (e) {
        markSession(e);
        console.warn(`[scan] chat-history ${label} failed for ${groupId}: ${e.message}`);
      }
      return null;
    };
    // Thử với groupId trước, rồi globalId nếu có
    let historyMembers = await tryHistory(groupId, 'groupId');
    if ((!historyMembers || historyMembers.length < 20) && globalId && globalId !== groupId) {
      const hist2 = await tryHistory(globalId, 'globalId');
      if (hist2 && hist2.length > (historyMembers?.length || 0)) historyMembers = hist2;
    }
    if (historyMembers && historyMembers.length > memberIds.length) {
      const enrichedHist = await enrichMembers(api, historyMembers);
      if (enrichedHist.length > memberIds.length) {
        console.warn(`[scan] using chat-history enriched ${enrichedHist.length} for ${groupId}`);
        return mergeWithCache(groupId, enrichedHist, totalReported).members;
      }
    }
    // Nếu vét lịch sử vẫn ít (nhóm ít chat), vẫn trả 4 nhưng log đã rõ — không thể vượt lockViewMember nếu là thành viên thường
    console.warn(`[scan] chat-history still limited for ${groupId}, Zalo lockViewMember blocks member list for non-admin`);
  }

  const enriched = await enrichMembers(api, memberIds);
  // Gắn role
  const finalMembers = enriched.map((m) => ({
    ...m,
    type: m.type,
    // role suy ra để FE hiển thị, nhưng backend trả theo type
  }));
  // Live bị giới hạn so với tổng báo cáo → hợp nhất với kho cache ADN
  return mergeWithCache(groupId, finalMembers, Number(gData.totalMember || 0)).members;
}

// ── POST /api/scan/group ───────────────────────────────────────────────────
app.post('/api/scan/group', rateLimit, requireApiKey, async (req, res) => {
  const { page_id, body } = req.body || {};
  const payload = decryptBody(body);
  if (!payload || typeof payload !== 'object') {
    return res.status(400).json({ success: false, groupId: '', totalMembers: 0, members: [], error: 'Invalid encrypted payload' });
  }
  if (!page_id || String(payload.page_id || '') !== String(page_id)) {
    return res.status(403).json({ success: false, groupId: '', totalMembers: 0, members: [], error: 'Page mismatch' });
  }
  const groupId = String(payload.groupId || payload.group_id || '').trim();
  const cookie = payload.cookie || '';
  const imei = payload.imei || '';

  if (!/^\d+$/.test(groupId) || !cookie || !imei) {
    return res.status(400).json({ success: false, groupId, totalMembers: 0, members: [], error: 'Missing or invalid groupId/cookie/imei' });
  }

  let members;
  try {
    members = await scanGroupMembers({
      groupId,
      cookie,
      imei,
      userAgent: payload.userAgent,
      pageId: page_id,
    });
  } catch (e) {
    const msg = String(e.message || '');
    if (isSessionError(e)) {
      console.warn(`[scan] clearing cache and retry once for ${page_id} due to ${msg}`);
      apiCache.delete(`${page_id}:${imei}`);
      try {
        members = await scanGroupMembers({ groupId, cookie, imei, userAgent: payload.userAgent, pageId: page_id });
      } catch (e2) {
        console.error('[scan/group] retry failed:', e2.message);
        // Retry vẫn lỗi phiên (kể cả zpw_sek) → cookie đã chết thật,
        // báo rõ để user đăng nhập lại nick trong ADNzalo thay vì lỗi chung chung.
        if (isSessionError(msg) || isSessionError(e2)) {
          return res.json({ success: false, groupId, totalMembers: 0, members: [], error: 'Phiên Zalo hết hạn, vui lòng đăng nhập lại nick này trong ADNzalo' });
        }
        // Live fail hoàn toàn → trả kho cache ADN nếu có dữ liệu
        const cached = cacheGetMembers(groupId);
        if (cached.length > 0) {
          console.warn(`[scan] live failed, returning cache-only ${cached.length} for ${groupId}`);
          return res.json({ success: true, groupId, totalMembers: cached.length, members: cached, source: 'cache' });
        }
        throw e2;
      }
    } else {
      // Live fail hoàn toàn → trả kho cache ADN nếu có dữ liệu
      const cached = cacheGetMembers(groupId);
      if (cached.length > 0) {
        console.warn(`[scan] live failed (${msg}), returning cache-only ${cached.length} for ${groupId}`);
        return res.json({ success: true, groupId, totalMembers: cached.length, members: cached, source: 'cache' });
      }
      console.error('[scan/group] error:', e.message);
      return res.json({ success: false, groupId, totalMembers: 0, members: [], error: 'Zalo scan failed' });
    }
  }
  // Tích lũy kết quả live vào kho cache ADN cho các lần quét sau
  try {
    cacheUpsertMembers(groupId, members.filter((m) => m.source !== 'cache'));
  } catch {}
  return res.json({ success: true, groupId, totalMembers: members.length, members });
});

app.post('/api/scan/premium-status', rateLimit, requireApiKey, (req, res) => {
  res.json({ is_premium: true, premium_expires_at: null });
});

app.get(['/health', '/api/health'], (req, res) => res.json({ ok: true }));

app.use((error, _req, res, _next) => {
  if (error instanceof SyntaxError && error.status === 400 && 'body' in error) {
    return res.status(400).json({ success: false, error: 'Invalid JSON body' });
  }
  console.error('[server] unhandled error:', error?.message || error);
  return res.status(500).json({ success: false, error: 'Internal server error' });
});

app.listen(PORT, '127.0.0.1', () => console.log(`[ADN scan backend] listening on 127.0.0.1:${PORT}`));
