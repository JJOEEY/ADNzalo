import { BrowserWindow, ipcMain, session } from 'electron';
import * as path from 'path';
import * as fs from 'fs';

let scraperWindow: BrowserWindow | null = null;
let scraperSessionPartition = 'persist:zalo-scraper';

async function ensureScraperWindow(): Promise<BrowserWindow> {
  if (scraperWindow && !scraperWindow.isDestroyed()) return scraperWindow;
  scraperWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    show: true,
    webPreferences: {
      partition: scraperSessionPartition,
      nodeIntegration: false,
      contextIsolation: true,
    },
  });
  scraperWindow.on('closed', () => { scraperWindow = null; });
  return scraperWindow;
}

function parseCookiesForElectron(cookiesJson: string): Array<{ url: string; name: string; value: string; domain?: string; path?: string }> {
  try {
    const jar = JSON.parse(cookiesJson);
    const cookies = Array.isArray(jar) ? jar : jar.cookies;
    if (!Array.isArray(cookies)) return [];
    return cookies.map((c: any) => ({
      url: `https://${(c.domain || 'chat.zalo.me').replace(/^\./, '')}${c.path || '/'}`,
      name: c.key || c.name,
      value: c.value,
      domain: c.domain,
      path: c.path || '/',
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
        domain: c.domain?.replace(/^\./, ''),
        path: c.path,
      });
    } catch {}
  }
}

export function registerZaloScraperIpc() {
  ipcMain.handle('zalo:scrapeGroupMembers', async (_event, params: { auth: { cookies: string; imei: string; userAgent: string }; groupId: string }) => {
    const { auth, groupId } = params;
    if (!auth?.cookies || !groupId) return { success: false, members: [], error: 'Missing auth/groupId' };
    const win = await ensureScraperWindow();
    try {
      await setZaloCookies(auth.cookies);
      // Load Zalo Web
      await win.loadURL('https://chat.zalo.me/');
      // Wait for app to load
      await new Promise((r) => setTimeout(r, 8000));
      // Try to find and click the group in conversation list, then open member list
      const result = await win.webContents.executeJavaScript(`
        (async () => {
          const sleep = (ms) => new Promise(r => setTimeout(r, ms));
          // Helper to find group element by groupId in DOM
          const findGroupEl = () => {
            const all = document.querySelectorAll('[data-id]');
            for (const el of all) {
              if (el.getAttribute('data-id')?.includes('${groupId}') || el.textContent?.includes('${groupId}')) return el;
            }
            return null;
          };
          let groupEl = findGroupEl();
          if (!groupEl) {
            // Fallback: search in conversation list items
            const items = document.querySelectorAll('.conv-item, [class*="conv"], [class*="thread"]');
            for (const it of items) {
              if (it.textContent?.includes('${groupId}')) { groupEl = it; break; }
            }
          }
          if (groupEl) groupEl.click();
          await sleep(3000);
          // Try to open group info / member list
          const infoBtn = document.querySelector('[data-translate*="info"], [title*="Thông tin"], [class*="group-info"], [class*="member"]');
          if (infoBtn) infoBtn.click();
          await sleep(3000);
          // Collect member elements - try multiple selectors
          const selectors = [
            '[class*="member"]',
            '[class*="Member"]',
            '[data-id*="member"]',
            '.user-item',
            '[class*="user"]',
          ];
          let members = [];
          for (const sel of selectors) {
            const els = document.querySelectorAll(sel);
            if (els.length > 5) {
              for (const el of els) {
                const name = el.textContent?.trim() || '';
                const id = el.getAttribute('data-id') || el.getAttribute('data-uid') || '';
                if (name && el.innerHTML.includes('avatar')) members.push({ name, id, html: el.outerHTML.slice(0,500) });
              }
              if (members.length > 0) break;
            }
          }
          // Dump page HTML snippet for debugging
          const htmlLen = document.documentElement.outerHTML.length;
          const bodyText = document.body.innerText.slice(0,2000);
          return { foundGroup: !!groupEl, members, htmlLen, bodyText, url: location.href };
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
