const { app, BrowserWindow, ipcMain, dialog, net, shell, session } = require('electron');
const path = require('path');
const fs = require('fs');
const Store = require('electron-store');

const store = new Store();
let mainWindow;
let steamCookies = ''; // Store cookies in memory

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1000,
        height: 750,
        minWidth: 800,
        minHeight: 600,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false
        },
        autoHideMenuBar: true,
        backgroundColor: '#1a1a2e',
        show: false // Show when ready
    });

    mainWindow.loadFile('src/index.html');

    mainWindow.once('ready-to-show', () => {
        mainWindow.show();
    });

    // Open external links in browser
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        if (url.includes('steamcommunity.com/login')) {
            return { action: 'allow' }; // Allow login in separate window if needed, but we use a dedicated one
        }
        shell.openExternal(url);
        return { action: 'deny' };
    });
}

app.whenReady().then(() => {
    createWindow();

    app.on('activate', function () {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', function () {
    if (process.platform !== 'darwin') app.quit();
});

// IPC Handlers

// 1. Select Folder
ipcMain.handle('select-folder', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openDirectory']
    });
    if (result.canceled) return null;
    return result.filePaths[0];
});

// 2. Config
ipcMain.handle('save-config', (event, config) => {
    store.set('config', config);
    return true;
});

ipcMain.handle('load-config', () => {
    return store.get('config', {});
});

// 3. Scan Local Files
ipcMain.handle('scan-local-files', async (event, dirPath) => {
    if (!dirPath || !fs.existsSync(dirPath)) {
        throw new Error('Invalid directory path');
    }

    const items = [];
    const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });

    for (const entry of entries) {
        if (entry.isDirectory() && /^\d+$/.test(entry.name)) {
            const itemPath = path.join(dirPath, entry.name);
            let title = 'Unknown Wallpaper';
            let size = 0;

            // Try to read project.json
            try {
                const projectJsonPath = path.join(itemPath, 'project.json');
                if (fs.existsSync(projectJsonPath)) {
                    const content = await fs.promises.readFile(projectJsonPath, 'utf-8');
                    // Handle potential BOM or malformed JSON
                    const json = JSON.parse(content.replace(/^\uFEFF/, ''));
                    if (json.title) title = json.title;
                }
            } catch (e) {
                console.error(`Error reading project.json for ${entry.name}:`, e);
            }

            // Calculate size
            try {
                size = await getDirSize(itemPath);
            } catch (e) {
                console.error(`Error calculating size for ${entry.name}:`, e);
            }

            items.push({
                id: entry.name,
                title: title,
                size: size,
                path: itemPath
            });
        }
    }
    return items;
});

// Helper to calculate directory size recursively
async function getDirSize(dirPath) {
    let size = 0;
    const files = await fs.promises.readdir(dirPath, { withFileTypes: true });

    for (const file of files) {
        const filePath = path.join(dirPath, file.name);
        if (file.isDirectory()) {
            size += await getDirSize(filePath);
        } else {
            const stats = await fs.promises.stat(filePath);
            size += stats.size;
        }
    }
    return size;
}

// 4. Delete Files
ipcMain.handle('delete-files', async (event, paths) => {
    let successCount = 0;
    let failCount = 0;

    for (const p of paths) {
        try {
            await fs.promises.rm(p, { recursive: true, force: true });
            successCount++;
        } catch (e) {
            console.error(`Failed to delete ${p}:`, e);
            failCount++;
        }
    }
    return { success: successCount, failed: failCount };
});

// 6. Login Steam
ipcMain.handle('login-steam', async () => {
    const loginWindow = new BrowserWindow({
        width: 800,
        height: 600,
        parent: mainWindow,
        modal: true,
        autoHideMenuBar: true,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true
        }
    });

    loginWindow.loadURL('https://steamcommunity.com/login/home/?goto=%2Fmy%2Fmyworkshopfiles%2F%3Fappid%3D431960%26browsefilter%3Dmysubscriptions');

    return new Promise((resolve) => {
        // Monitor cookies or URL changes to detect login
        const checkLogin = async () => {
            const cookies = await session.defaultSession.cookies.get({ domain: 'steamcommunity.com' });
            const sessionid = cookies.find(c => c.name === 'sessionid');
            const steamLoginSecure = cookies.find(c => c.name === 'steamLoginSecure');

            if (sessionid && steamLoginSecure) {
                steamCookies = cookies.map(c => `${c.name}=${c.value}`).join('; ');
                console.log('[Login] Steam login detected!');
                loginWindow.close();
                resolve(true);
            }
        };

        const interval = setInterval(checkLogin, 1000);

        loginWindow.on('closed', () => {
            clearInterval(interval);
            resolve(!!steamCookies);
        });
    });
});


// 5. Fetch Subscriptions (BrowserWindow Scraping)
ipcMain.handle('fetch-subscriptions', async (event, apiKey, steamId, appId) => {
    const subscriptions = new Set();
    let page = 1;
    let hasMore = true;
    const MAX_PAGES = 100;

    // Default to Wallpaper Engine if no appId provided
    const targetAppId = appId || '431960';

    // Determine profile URL type
    const isNumericId = /^\d+$/.test(steamId);
    const profilePath = isNumericId ? `profiles/${steamId}` : `id/${steamId}`;

    // Create a hidden window for scraping
    const scrapeWindow = new BrowserWindow({
        show: false, // Keep it hidden, but we will take screenshots
        width: 1024,
        height: 800,
        webPreferences: {
            offscreen: false, // Disable offscreen to ensure proper rendering
            contextIsolation: false,
            nodeIntegration: false
        }
    });

    try {
        while (hasMore && page <= MAX_PAGES) {
            console.log(`[Scraper] Fetching page ${page} for appId ${targetAppId}...`);
            const url = `https://steamcommunity.com/${profilePath}/myworkshopfiles/?appid=${targetAppId}&browsefilter=mysubscriptions&numperpage=30&p=${page}`;

            await scrapeWindow.loadURL(url);

            // Wait for page to render (Steam can be slow)
            await new Promise(r => setTimeout(r, 3000));

            // Debug: Log URL and Title
            const currentUrl = scrapeWindow.webContents.getURL();
            const title = scrapeWindow.getTitle();
            console.log(`[Scraper] Loaded: ${title} | URL: ${currentUrl}`);

            // Debug: Take a screenshot of the first page
            if (page === 1) {
                try {
                    const image = await scrapeWindow.capturePage();
                    const debugPath = path.join(app.getPath('userData'), 'debug_scraper.png');
                    // Also save to local project root for easier access by user
                    const localDebugPath = path.join(__dirname, 'debug_scraper.png');

                    fs.writeFileSync(localDebugPath, image.toPNG());
                    console.log(`[Scraper] Saved debug screenshot to: ${localDebugPath}`);
                } catch (e) {
                    console.error('[Scraper] Failed to save screenshot:', e);
                }
            }

            if (currentUrl.includes('/login/')) {
                throw new Error('需要登录 Steam 才能查看订阅列表 (检测到登录页面)');
            }

            // Execute JS to extract IDs
            const result = await scrapeWindow.webContents.executeJavaScript(`
                (function() {
                    const ids = new Set();
                    
                    // Method: Find all links to workshop items
                    // This is the most robust method as it doesn't rely on specific container classes/IDs
                    // which can vary between "Subscribed Items", "Published Items", etc.
                    const links = document.querySelectorAll('a[href*="filedetails/?id="]');
                    
                    links.forEach(link => {
                        const match = link.href.match(/id=(\\d+)/);
                        if (match) {
                            ids.add(match[1]);
                        }
                    });
                    
                    // Check for pagination
                    // Steam pagination: <a class="pagebtn" href="..."> &gt; </a>
                    const nextBtn = Array.from(document.querySelectorAll('.pagebtn')).find(el => el.textContent.includes('>') || el.innerText.includes('>'));
                    const hasNext = nextBtn && nextBtn.tagName === 'A' && !nextBtn.classList.contains('disabled');

                    // Check for "No items" message
                    const noItems = document.body.innerText.includes('No items to display') || document.body.innerText.includes('没有要显示的项目');

                    return { ids: Array.from(ids), hasNext, hasItems: ids.size > 0, noItems, bodyLength: document.body.innerHTML.length };
                })();
            `);

            console.log(`[Scraper] Page ${page} result:`, result);

            if (result.ids.length > 0) {
                result.ids.forEach(id => subscriptions.add(id));
            }

            if (!result.hasNext || result.noItems) {
                hasMore = false;
            } else {
                page++;
            }
        }
    } catch (error) {
        console.error('[Scraper] Error:', error);
        throw error;
    } finally {
        scrapeWindow.destroy();
    }

    return Array.from(subscriptions);
});
