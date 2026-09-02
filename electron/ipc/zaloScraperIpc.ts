import { BrowserWindow, ipcMain, session } from 'electron';
import * as path from 'path';
import * as fs from 'fs';

let scraperWindow: BrowserWindow | null = null;
let scraperSessionPartition = 'persist:zalo-scraper';

async function ensureScraperWindow(userAgent?: string): Promise<BrowserWindow> {
  if (scraperWindow && !scraperWindow.isDestroyed()) {
    if (userAgent) scraperWindow.webContents.setUserAgent(userAgent);
    return scraperWindow;
  }
  scraperWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    webPreferences: {
      partition: scraperSessionPartition,
      nodeIntegration: false,
      contextIsolation: true,
    },
  });
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

async function setZaloCookies(cookiesJson: string) {
  const ses = session.fromPartition(scraperSessionPartition);
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

export function registerZaloScraperIpc() {
  ipcMain.handle('zalo:scrapeGroupMembers', async (_event, params: { auth: { cookies: string; imei: string; userAgent: string }; groupId: string }) => {
    const { auth, groupId } = params;
    if (!auth?.cookies || !groupId) return { success: false, members: [], error: 'Missing auth/groupId' };
    const win = await ensureScraperWindow(auth.userAgent);
    try {
      await setZaloCookies(auth.cookies);
      // Load Zalo Web directly to group via gid param (tránh tìm DOM text)
      const targetUrl = `https://chat.zalo.me/?gid=${groupId}`;
      const currentUrl = win.webContents.getURL();
      if (!currentUrl.includes('chat.zalo.me')) {
        await win.loadURL(targetUrl);
        await new Promise((r) => setTimeout(r, 6000));
        const landed = await win.webContents.executeJavaScript(`
          (() => {
            const btn = Array.from(document.querySelectorAll('a, button')).find(el => el.textContent.includes('Dùng bản web'));
            if (btn) { btn.click(); return true; }
            return false;
          })()
        `);
        if (landed) await new Promise((r) => setTimeout(r, 6000));
      } else if (!currentUrl.includes(groupId)) {
        // Đã ở chat.zalo.me nhưng chưa đúng group -> navigate
        await win.loadURL(targetUrl);
        await new Promise((r) => setTimeout(r, 4000));
      }
      // Check if still on login/landing page
      const isLogin = await win.webContents.executeJavaScript(`document.body.innerText.includes('Đăng nhập') || document.body.innerText.includes('Quét mã QR')`);
      if (isLogin) {
        return { success: false, members: [], error: 'Scraper not authenticated - skip', debug: { url: win.webContents.getURL() } };
      }
      // Try to find and click the group in conversation list, then open member list
      const result = await win.webContents.executeJavaScript(`
        (async () => {
          const sleep = (ms) => new Promise(r => setTimeout(r, ms));
          // Thử click group qua URL hash nếu còn
          if (!location.href.includes('${groupId}')) {
            const all = document.querySelectorAll('[data-id]');
            for (const el of all) {
              if (el.getAttribute('data-id')?.includes('${groupId}')) { el.click(); break; }
            }
          }
          await sleep(2000);
          // Try to open group info / member list - thử nhiều selector
          const tryClick = (sel) => { const el = document.querySelector(sel); if (el) { el.click(); return true; } return false; };
          tryClick('[data-translate*="info"]');
          tryClick('[title*="Thông tin"]');
          tryClick('[class*="group-info"]');
          // Nút xem thành viên thường là "Xem tất cả" hoặc số thành viên
          const memberBtn = Array.from(document.querySelectorAll('a, button, span')).find(el => /\\d+\\s*thành viên|Xem tất cả/i.test(el.textContent));
          if (memberBtn) memberBtn.click();
          await sleep(2000);
          // Collect member elements - try multiple selectors + scroll vét ảo
          const selectors = [
            '[class*="member"]',
            '[class*="Member"]',
            '[data-id*="member"]',
            '.user-item',
            '[class*="user"]',
            '[class*="avatar"]',
          ];
          let members = [];
          const seenIds = new Set();
          const seenNames = new Set();
          const scrollEl = document.querySelector('[class*="member-list"]') || document.querySelector('[class*="scroll"]') || document.querySelector('[role="dialog"]') || document.querySelector('.ReactVirtualized__Grid');
          for (let iter = 0; iter < 25; iter++) {
            for (const sel of selectors) {
              const els = document.querySelectorAll(sel);
              for (const el of els) {
                const name = el.textContent?.trim()?.split('\\n')[0]?.trim() || '';
                const id = el.getAttribute('data-id') || el.getAttribute('data-uid') || el.getAttribute('data-userid') || '';
                const key = id || name;
                if (name && name.length > 1 && name.length < 50 && el.innerHTML.includes('avatar') && !seenNames.has(key)) {
                  seenNames.add(key);
                  members.push({ name, id, html: el.outerHTML.slice(0,500) });
                }
              }
            }
            if (scrollEl) (scrollEl as HTMLElement).scrollTop = (scrollEl as HTMLElement).scrollHeight;
            else window.scrollTo(0, document.body.scrollHeight);
            await sleep(600);
            if (members.length >= 650) break;
          }
          // Dump page HTML snippet for debugging
          const htmlLen = document.documentElement.outerHTML.length;
          const bodyText = document.body.innerText.slice(0,2000);
          return { foundGroup: true, members, htmlLen, bodyText, url: location.href };
        })()
      `);
      // Save HTML for debugging selectors
      try {
        const html = await win.webContents.executeJavaScript('document.documentElement.outerHTML');
        const outPath = path.join(require('os').tmpdir(), `adnzalo-scrape-${groupId}.html`);
        fs.writeFileSync(outPath, String(html).slice(0, 2000000), 'utf8');
        (result as any).debugHtmlPath = outPath;
      } catch {}
      // For now return scraped data (may be empty until selectors refined)
      // Also enrich via getGroupMembersInfo if we got ids
      return { success: true, members: (result as any).members || [], debug: result, error: (result as any).members?.length ? undefined : 'DOM scrape found 0 members - selectors need refinement' };
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
