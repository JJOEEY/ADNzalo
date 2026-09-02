import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import { Zalo } from 'zca-js';
import 'dotenv/config';

const app = express();
app.set('trust proxy', 1);
app.use(cors({ origin: true }));
app.use(express.json({ limit: '1mb' }));

const SECRET_KEY = process.env.SECRET_KEY || '';
const PORT = Number(process.env.PORT || 3100);
const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

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
  try {
    const key = Buffer.from(SECRET_KEY, 'hex').slice(0, 16);
    const iv = Buffer.alloc(16, 0);
    const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
    let dec = decipher.update(encryptedB64, 'base64', 'utf8');
    dec += decipher.final('utf8');
    return JSON.parse(dec);
  } catch {
    // Plain base64 is opt-in for local development only.
    if (process.env.ALLOW_PLAIN_PAYLOAD !== '1') return null;
    try { return JSON.parse(Buffer.from(encryptedB64, 'base64').toString('utf8')); } catch { return null; }
  }
}

function requireApiKey(req, res, next) {
  const supplied = String(req.headers['x-api-key'] || '');
  const expected = Buffer.from(SECRET_KEY);
  const actual = Buffer.from(supplied);
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
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
  return [...new Set(rawIds.map((id) => String(id).replace(/_0$/, '').trim()).filter((id) => /^\d+$/.test(id)))];
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

async function scanGroupMembers({ groupId, cookie, imei, userAgent }) {
  const zalo = new Zalo({ checkUpdate: false, logging: false });
  const api = await zalo.login({
    cookie: parseCookieJar(cookie),
    imei,
    userAgent: userAgent || DEFAULT_USER_AGENT,
    language: 'vi',
  });

  // 1) Thử qua invite link nếu có (paginate currentMems) — không tự bật link
  try {
    const linkDetail = await api.getGroupLinkDetail(groupId);
    const link = linkDetail?.link;
    if (link) {
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
      if (members.length > 2) return members;
      // Nếu link chỉ trả 1-2 người (chỉ admin) thì coi như thất bại và xuống fallback
      if (members.length > 0 && members.length <= 2) {
        console.warn(`[scan] link scan only ${members.length} members for ${groupId}, falling back to getGroupInfo`);
      } else if (members.length > 0) {
        return members;
      }
    }
  } catch (e) {
    console.warn(`[scan] link scan failed for ${groupId}: ${e.message}`);
  }

  // 2) Fallback cho nhóm ẩn + không link: getGroupInfo memVerList/memberIds (backend, không phụ thuộc link)
  const infoRes = await api.getGroupInfo(groupId);
  const gridMap = infoRes?.gridInfoMap ?? infoRes?.response?.gridInfoMap ?? {};
  const gData = gridMap[groupId] ?? Object.values(gridMap)[0];
  if (!gData) throw new Error('Cannot fetch group info');

  const creatorId = String(gData.creatorId || '').replace(/_0$/, '');
  const adminIds = (gData.adminIds || []).map((a) => String(a).replace(/_0$/, ''));
  const adminSet = new Set([creatorId, ...adminIds].filter(Boolean));
  const memberIds = extractIdsFromGroupInfo(gData);
  if (memberIds.length === 0) throw new Error('Empty member list from getGroupInfo');

  // Nếu Zalo chỉ trả trưởng/phó (<=2) và totalMember báo lớn hơn thì đây là giới hạn quyền, báo rõ
  const totalReported = Number(gData.totalMember || 0);
  if (memberIds.length <= 2 && totalReported > memberIds.length) {
    console.warn(`[scan] getGroupInfo limited to ${memberIds.length}/${totalReported} for ${groupId} (lockViewMember?)`);
  }

  const enriched = await enrichMembers(api, memberIds);
  // Gắn role
  return enriched.map((m) => ({
    ...m,
    type: m.type,
    // role suy ra để FE hiển thị, nhưng backend trả theo type
  }));
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

  try {
    const members = await scanGroupMembers({
      groupId,
      cookie,
      imei,
      userAgent: payload.userAgent,
    });
    return res.json({ success: true, groupId, totalMembers: members.length, members });
  } catch (e) {
    console.error('[scan/group] error:', e.message);
    return res.json({ success: false, groupId, totalMembers: 0, members: [], error: 'Zalo scan failed' });
  }
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
