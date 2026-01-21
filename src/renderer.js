const apiKeyInput = document.getElementById('apiKey');
const steamIdInput = document.getElementById('steamId');
const appIdInput = document.getElementById('appId');
const workshopPathInput = document.getElementById('workshopPath');
const loginBtn = document.getElementById('loginBtn');
const loginStatus = document.getElementById('loginStatus');
const selectPathBtn = document.getElementById('selectPathBtn');
const scanBtn = document.getElementById('scanBtn');
const resultsTableBody = document.querySelector('#resultsTable tbody');
const emptyState = document.getElementById('emptyState');
const itemCountSpan = document.getElementById('itemCount');
const totalSizeSpan = document.getElementById('totalSize');
const selectAllCheckbox = document.getElementById('selectAll');
const selectedCountSpan = document.getElementById('selectedCount');
const selectedSizeSpan = document.getElementById('selectedSize');
const deleteBtn = document.getElementById('deleteBtn');
const loadingOverlay = document.getElementById('loadingOverlay');
const loadingText = document.getElementById('loadingText');

let currentUnsubscribedItems = [];
let selectedItemIds = new Set();

// Load Config on Start
async function loadConfig() {
    const config = await window.electronAPI.loadConfig();
    if (config.apiKey) apiKeyInput.value = config.apiKey;
    if (config.steamId) steamIdInput.value = config.steamId;
    if (config.appId) appIdInput.value = config.appId;
    if (config.workshopPath) workshopPathInput.value = config.workshopPath;
}

loadConfig();

// Save Config Helper
async function saveConfig() {
    await window.electronAPI.saveConfig({
        apiKey: apiKeyInput.value.trim(),
        steamId: steamIdInput.value.trim(),
        appId: appIdInput.value.trim(),
        workshopPath: workshopPathInput.value.trim()
    });
}

// Login Steam
loginBtn.addEventListener('click', async () => {
    loginBtn.disabled = true;
    loginStatus.textContent = '正在打开登录窗口...';

    const isLoggedIn = await window.electronAPI.loginSteam();

    if (isLoggedIn) {
        loginStatus.textContent = '已登录';
        loginStatus.style.color = '#4caf50';
        loginBtn.textContent = '重新登录';
    } else {
        loginStatus.textContent = '登录取消或失败';
        loginStatus.style.color = '#e94560';
    }
    loginBtn.disabled = false;
});

// Select Folder
selectPathBtn.addEventListener('click', async () => {
    const path = await window.electronAPI.selectFolder();
    if (path) {
        workshopPathInput.value = path;
        saveConfig();
    }
});

// Scan & Compare
scanBtn.addEventListener('click', async () => {
    // const apiKey = apiKeyInput.value.trim(); // Deprecated
    const steamId = steamIdInput.value.trim();
    const appId = appIdInput.value.trim();
    const path = workshopPathInput.value.trim();

    if (!steamId || !appId || !path) {
        alert('请填写 Steam ID、App ID 和 Workshop 路径');
        return;
    }

    // Check if logged in (optional, but good UX)
    if (loginStatus.textContent !== '已登录') {
        if (!confirm('尚未检测到 Steam 登录状态，扫描可能会失败（返回 0 项）。\n建议先点击“登录 Steam”按钮。\n\n是否继续强制扫描？')) {
            return;
        }
    }

    showLoading(true, '正在获取 Steam 订阅列表...');
    saveConfig();

    try {
        // 1. Fetch Subscriptions (API Key is ignored now, appId is used)
        const subscriptionIds = await window.electronAPI.fetchSubscriptions('', steamId, appId);
        console.log(`Fetched ${subscriptionIds.length} subscriptions`);

        // 2. Scan Local Files
        showLoading(true, '正在扫描本地文件...');
        const localItems = await window.electronAPI.scanLocalFiles(path);
        console.log(`Found ${localItems.length} local items`);

        // 3. Compare
        showLoading(true, '正在对比分析...');

        // Ensure IDs are strings for comparison
        const subSet = new Set(subscriptionIds.map(id => String(id)));
        console.log('Subscription Set has', subSet.size, 'items');

        currentUnsubscribedItems = localItems.filter(item => {
            const isSubscribed = subSet.has(String(item.id));
            if (!isSubscribed && currentUnsubscribedItems.length < 5) {
                console.log(`Item ${item.id} is NOT in subscription list`);
            }
            return !isSubscribed;
        });

        renderTable(currentUnsubscribedItems);

    } catch (error) {
        console.error('Scan Error:', error);
        alert('扫描失败: ' + error.message + '\n请检查 VS Code 终端获取详细日志');
    } finally {
        showLoading(false);
    }
});

// Render Table
function renderTable(items) {
    resultsTableBody.innerHTML = '';
    selectedItemIds.clear();
    updateSelectionStats();
    selectAllCheckbox.checked = false;

    if (items.length === 0) {
        emptyState.style.display = 'block';
        itemCountSpan.textContent = '0 项';
        totalSizeSpan.textContent = '0 MB';
        return;
    }

    emptyState.style.display = 'none';

    let totalBytes = 0;

    items.forEach(item => {
        totalBytes += item.size;
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td><input type="checkbox" class="item-checkbox" data-id="${item.path}" data-size="${item.size}"></td>
            <td>${item.id}</td>
            <td>${escapeHtml(item.title)}</td>
            <td>${formatSize(item.size)}</td>
            <td title="${escapeHtml(item.path)}">${escapeHtml(item.path)}</td>
        `;
        resultsTableBody.appendChild(tr);
    });

    itemCountSpan.textContent = `${items.length} 项`;
    totalSizeSpan.textContent = formatSize(totalBytes);

    // Re-attach event listeners for checkboxes
    const checkboxes = document.querySelectorAll('.item-checkbox');
    checkboxes.forEach(cb => {
        cb.addEventListener('change', (e) => {
            const path = e.target.dataset.id;
            const size = parseInt(e.target.dataset.size);
            if (e.target.checked) {
                selectedItemIds.add({ path, size });
            } else {
                // Need to find the object in Set to delete it properly or use path as key
                // Simplified: iterate and delete
                for (const item of selectedItemIds) {
                    if (item.path === path) {
                        selectedItemIds.delete(item);
                        break;
                    }
                }
            }
            updateSelectionStats();
        });
    });
}

// Select All
selectAllCheckbox.addEventListener('change', (e) => {
    const isChecked = e.target.checked;
    const checkboxes = document.querySelectorAll('.item-checkbox');
    selectedItemIds.clear();

    checkboxes.forEach(cb => {
        cb.checked = isChecked;
        if (isChecked) {
            selectedItemIds.add({
                path: cb.dataset.id,
                size: parseInt(cb.dataset.size)
            });
        }
    });
    updateSelectionStats();
});

// Update Stats
function updateSelectionStats() {
    const count = selectedItemIds.size;
    let size = 0;
    for (const item of selectedItemIds) {
        size += item.size;
    }

    selectedCountSpan.textContent = count;
    selectedSizeSpan.textContent = formatSize(size);
    deleteBtn.disabled = count === 0;
}

// Delete Files
deleteBtn.addEventListener('click', async () => {
    if (selectedItemIds.size === 0) return;

    if (!confirm(`确定要删除选中的 ${selectedItemIds.size} 个项目吗？\n此操作不可恢复！`)) {
        return;
    }

    showLoading(true, '正在删除文件...');

    const pathsToDelete = Array.from(selectedItemIds).map(i => i.path);

    try {
        const result = await window.electronAPI.deleteFiles(pathsToDelete);
        alert(`删除完成\n成功: ${result.success}\n失败: ${result.failed}`);

        // Refresh list
        // Remove deleted items from currentUnsubscribedItems
        const deletedPaths = new Set(pathsToDelete); // Assuming all success for UI update or re-scan
        // Ideally re-scan, but for speed we can just remove from UI
        // Let's trigger a re-scan of the local folder only? No, just filter the list

        currentUnsubscribedItems = currentUnsubscribedItems.filter(item => !deletedPaths.has(item.path));
        renderTable(currentUnsubscribedItems);

    } catch (error) {
        alert('删除出错: ' + error.message);
    } finally {
        showLoading(false);
    }
});

// Utils
function formatSize(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function escapeHtml(text) {
    if (!text) return '';
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

function showLoading(show, text = 'Loading...') {
    if (show) {
        loadingText.textContent = text;
        loadingOverlay.classList.remove('hidden');
    } else {
        loadingOverlay.classList.add('hidden');
    }
}
