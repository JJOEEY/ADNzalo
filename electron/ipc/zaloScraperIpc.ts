import { BrowserWindow, ipcMain, session } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

// ── DOM scraper cho nhóm ẩn (lockViewMember) ───────────────────────────────
// Web chat.zalo.me hiển thị danh sách thành viên theo quyền riêng của phiên
// web, có thể nhiều hơn API mobile trả về. Mỗi tài khoản Zalo dùng 1 partition
// riêng; lần đầu chưa có phiên web → hiện cửa sổ cho user quét QR một lần,
// phiên được giữ lại cho các lần quét sau.

let scraperWindow: BrowserWindow | null = null;
let scraperPartition = '';

const LOGIN_WAIT_MS = 180_000; // chờ user quét QR tối đa 3 phút
const LOGIN_POLL_MS = 3_000;

function ensureScraperWindow(partition: string, userAgent?: string): BrowserWindow {
  if (scraperWindow && !scraperWindow.isDestroyed() && scraperPartition !== partition) {
    scraperWindow.destroy();
    scraperWindow = null;
  }
  if (scraperWindow && !scraperWindow.isDestroyed()) {
    if (userAgent) scraperWindow.webContents.setUserAgent(userAgent);
    return scraperWindow;
  }
  scraperWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    webPreferences: {
      partition,
      nodeIntegration: false,
      contextIsolation: true,
    },
  });
  scraperPartition = partition;
  if (userAgent) scraperWindow.webContents.setUserAgent(userAgent);
  scraperWindow.on('closed', () => { scraperWindow = null; });
  return scraperWindow;
}

function parseCookiesForElectron(cookiesJson: string): Array<{ url: string; name: string; value: string; domain?: string; path?: string; expirationDate?: number; secure?: boolean; httpOnly?: boolean }> {
  try {
    const jar = JSON.parse(cookiesJson);
    const cookies = Array.isArray(jar) ? jar : jar.cookies;
    if (!Array.isArray(cookies)) return [];
    return cookies.map((c: any) => ({
      url: `https://${(c.domain || 'chat.zalo.me').replace(/^\./, '')}${c.path || '/'}`,
      name: c.key || c.name,
      value: c.value,
      domain: c.domain?.replace(/^\./, ''),
      path: c.path || '/',
      expirationDate: c.expires ? new Date(c.expires).getTime() / 1000 : c.expirationDate,
      secure: c.secure,
      httpOnly: c.httpOnly,
    })).filter((c) => c.name && c.value);
  } catch {
    return [];
  }
}

async function setZaloCookies(partition: string, cookiesJson: string) {
  const ses = session.fromPartition(partition);
  const cookies = parseCookiesForElectron(cookiesJson);
  for (const c of cookies) {
    try {
      await ses.cookies.set({
        url: c.url,
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
        expirationDate: c.expirationDate,
        secure: c.secure,
        httpOnly: c.httpOnly,
      });
    } catch {}
  }
}

/** Kiểm tra trạng thái đăng nhập của chat.zalo.me trong cửa sổ scraper */
async function checkLoginState(win: BrowserWindow): Promise<{ isLogin: boolean; url: string; title: string }> {
  try {
    return await win.webContents.executeJavaScript(`
      (() => {
        const title = document.title || '';
        const body = document.body?.innerText || '';
        const loginMarkers = title.includes('Đăng nhập') || body.includes('Quét mã QR') || body.includes('Đăng nhập tài khoản Zalo');
        const hasApp = !!document.querySelector('#app, [class*="conversation"], [class*="chat-item"], [class*="sidebar"]');
        return { isLogin: loginMarkers || (!hasApp && body.trim().length < 200), url: location.href, title };
      })()
    `);
  } catch {
    return { isLogin: true, url: '', title: '' };
  }
}

export function registerZaloScraperIpc() {
  ipcMain.handle('zalo:scrapeGroupMembers', async (_event, params: { auth: { cookies: string; imei: string; userAgent: string }; accountKey?: string; groupId: string }) => {
    const { auth, groupId } = params;
    if (!auth?.cookies || !groupId) return { success: false, members: [], error: 'Missing auth/groupId' };
    // groupId được chèn vào URL và script executeJavaScript bên dưới — bắt buộc
    // numeric để caller lạ không thể inject JS vào cửa sổ có phiên Zalo Web
    if (!/^\d+$/.test(groupId)) return { success: false, members: [], error: 'Invalid groupId' };

    // Partition theo tài khoản: giữ phiên web riêng cho từng nick
    const accountKey = params.accountKey || auth.imei || 'default';
    const partition = `persist:zalo-scraper-${accountKey}`;
    const win = ensureScraperWindow(partition, auth.userAgent);

    try {
      await setZaloCookies(partition, auth.cookies);
      await win.loadURL(`https://chat.zalo.me/?gid=${groupId}`);
      await new Promise((r) => setTimeout(r, 6000));

      // Chưa có phiên web → hiện cửa sổ cho user quét QR, chờ tới khi đăng nhập xong
      let state = await checkLoginState(win);
      if (state.isLogin) {
        try { await win.loadURL('https://chat.zalo.me/'); await new Promise((r) => setTimeout(r, 3000)); } catch {}
        state = await checkLoginState(win);
        if (state.isLogin) {
          if (!win.isVisible()) win.show();
          win.focus();
          const deadline = Date.now() + LOGIN_WAIT_MS;
          let loggedIn = false;
          while (Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, LOGIN_POLL_MS));
            if (scraperWindow !== win || win.isDestroyed()) {
              return { success: false, members: [], error: 'Đã đóng cửa sổ đăng nhập Zalo Web' };
            }
            const s = await checkLoginState(win);
            if (!s.isLogin) { loggedIn = true; break; }
          }
          if (!loggedIn) {
            return { success: false, members: [], needsWebLogin: true, error: 'Chưa đăng nhập Zalo Web — cửa sổ đăng nhập vẫn mở, quét QR rồi thử lại' };
          }
          if (win.isVisible()) win.hide();
        }
      }

      // Đảm bảo đang mở đúng nhóm
      const currentUrl = win.webContents.getURL();
      if (!currentUrl.includes(groupId)) {
        await win.loadURL(`https://chat.zalo.me/?gid=${groupId}`);
        await new Promise((r) => setTimeout(r, 5000));
      }

      // Thu hoạch danh sách thành viên từ DOM
      const result = await win.webContents.executeJavaScript(`
        (async () => {
          const sleep = (ms) => new Promise(r => setTimeout(r, ms));
          const gid = '${groupId}';
          // 1) Mở hội thoại nhóm nếu chưa mở
          if (!location.href.includes(gid)) {
            const els = document.querySelectorAll('[data-id]');
            for (const el of els) {
              if ((el.getAttribute('data-id') || '').includes(gid)) { el.click(); break; }
            }
          }
          await sleep(2500);
          // 2) Mở panel thông tin nhóm
          const tryClick = (sel) => { const el = document.querySelector(sel); if (el) { el.click(); return true; } return false; };
          const clickByText = (re) => {
            const el = Array.from(document.querySelectorAll('a, button, span, div[role="button"], div[title]'))
              .find(el => re.test((el.textContent || '').trim()) && (el.offsetWidth || el.offsetHeight));
            if (el) { el.click(); return true; }
            return false;
          };
          tryClick('[data-translate*="info"]');
          tryClick('[title*="Thông tin"]');
          tryClick('[title*="Group info"]');
          tryClick('[class*="group-info"]');
          await sleep(1800);
          // 3) Mở danh sách thành viên (nút số lượng thành viên / "Xem tất cả")
          clickByText(/\\d+\\s*thành viên|Xem tất cả|Thành viên\\s*\\(|View members/i);
          await sleep(2000);
          // 4) Vét danh sách thành viên + scroll qua list ảo
          const selectors = ['[class*="member"]', '[class*="Member"]', '[data-id*="member"]', '.user-item', '[class*="kt-item"]', '[class*="person"]'];
          const members = [];
          const seenIds = new Set();
          const seenNames = new Set();
          const grab = () => {
            // 4a) Theo selector + data-id
            for (const sel of selectors) {
              for (const el of document.querySelectorAll(sel)) {
                const name = (el.textContent || '').trim().split('\\n')[0].trim();
                const id = el.getAttribute('data-id') || el.getAttribute('data-uid') || el.getAttribute('data-userid') || '';
                const hasAvatar = el.innerHTML.includes('avatar') || !!el.querySelector('img');
                const key = id || name;
                if (name && name.length > 1 && name.length < 60 && hasAvatar && !seenNames.has(key)) {
                  seenNames.add(key);
                  members.push({ name, id: /^\\d{6,}$/.test(id) ? id : '' });
                }
              }
            }
            // 4b) Quét mọi phần tử data-id là UID Zalo (số dài) — bắt cả hàng ảo chưa render tên
            for (const el of document.querySelectorAll('[data-id]')) {
              const id = el.getAttribute('data-id') || '';
              if (!/^\\d{10,}$/.test(id) || seenIds.has(id)) continue;
              const name = (el.textContent || '').trim().split('\\n')[0].trim();
              seenIds.add(id);
              if (name && name.length > 1 && name.length < 60) members.push({ name, id });
            }
          };
          const scrollEl = document.querySelector('[class*="member-list"]')
            || document.querySelector('[class*="member"] [class*="scroll"]')
            || document.querySelector('[role="dialog"] [class*="scroll"]')
            || document.querySelector('.ReactVirtualized__Grid');
          let stableRounds = 0;
          let lastCount = 0;
          for (let iter = 0; iter < 40; iter++) {
            grab();
            if (scrollEl) scrollEl.scrollTop = scrollEl.scrollHeight;
            else window.scrollTo(0, document.body.scrollHeight);
            await sleep(600);
            grab();
            if (members.length === lastCount) { stableRounds++; if (stableRounds >= 4) break; }
            else stableRounds = 0;
            lastCount = members.length;
            if (members.length >= 1500) break;
          }
          return { foundGroup: true, members, url: location.href };
        })()
      `);
      const harvested = (result as any).members || [];

      // Lưu HTML để debug selector nếu thu hoạch kém
      try {
        const html = await win.webContents.executeJavaScript('document.documentElement.outerHTML');
        const outPath = path.join(os.tmpdir(), `adnzalo-scrape-${groupId}.html`);
        fs.writeFileSync(outPath, String(html).slice(0, 2_000_000), 'utf8');
        (result as any).debugHtmlPath = outPath;
      } catch {}

      const members = harvested
        .map((m: any) => ({ name: m.name, id: String(m.id || '') }))
        .filter((m: any) => m.name);
      return {
        success: true,
        members,
        debug: { url: (result as any).url, count: members.length },
        error: members.length ? undefined : 'DOM scrape found 0 members — xem debugHtmlPath để tinh chỉnh selector',
      };
    } catch (e: any) {
      return { success: false, members: [], error: e.message };
    }
  });

  ipcMain.handle('zalo:closeScraper', async () => {
    if (scraperWindow && !scraperWindow.isDestroyed()) {
      scraperWindow.close();
      scraperWindow = null;
    }
    return { success: true };
  });
}
