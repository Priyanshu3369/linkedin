/**
 * LinkedIn Outreach Dashboard - Frontend Application
 * Real-time workflow monitoring with automatic Google Sheets data display
 * Features: Pagination, Sorting, Search, WebSocket real-time updates
 */

// ========================================
// Configuration & State
// ========================================
const API_BASE = '';
let ws = null;
let workflowData = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;

// DataTable State
const dataTableState = {
    currentSheet: 'Aplify Testing',
    page: 1,
    limit: 20,
    sortBy: '',
    sortOrder: 'asc',
    search: '',
    headers: [],
    data: [],
    pagination: null,
    isLoading: false,
    searchTimeout: null
};

// DOM Elements
const elements = {
    connectionStatus: document.getElementById('connectionStatus'),
    triggerForm: document.getElementById('triggerForm'),
    triggerBtn: document.getElementById('triggerBtn'),
    executionStatus: document.getElementById('executionStatus'),
    nodeGroups: document.getElementById('nodeGroups'),
    nodeDetailsCard: document.getElementById('nodeDetailsCard'),
    detailsNodeName: document.getElementById('detailsNodeName'),
    inputData: document.getElementById('inputData'),
    outputData: document.getElementById('outputData'),
    executionsList: document.getElementById('executionsList'),
    sheetsLink: document.getElementById('sheetsLink'),
    // Data Table Elements
    sheetsDataContainer: document.getElementById('sheetsDataContainer'),
    sheetsSearch: document.getElementById('sheetsSearch'),
    paginationControls: document.getElementById('paginationControls'),
    paginationInfo: document.getElementById('paginationInfo'),
    prevPageBtn: document.getElementById('prevPageBtn'),
    nextPageBtn: document.getElementById('nextPageBtn'),
    pageNumbers: document.getElementById('pageNumbers'),
    rowsPerPage: document.getElementById('rowsPerPage'),
    // Stats
    totalNodes: document.getElementById('totalNodes'),
    linkedinNodes: document.getElementById('linkedinNodes'),
    sheetsNodes: document.getElementById('sheetsNodes'),
    aiNodes: document.getElementById('aiNodes'),
    // Dynamic Tabs Container
    sheetTabsContainer: document.getElementById('sheetTabsContainer')
};

// ========================================
// Initialization
// ========================================

document.addEventListener('DOMContentLoaded', async () => {
    await initializeDashboard();
    setupEventListeners();
    connectWebSocket();
});

async function initializeDashboard() {
    try {
        // Fetch workflow information
        const response = await fetch(`${API_BASE}/api/workflow`);
        const data = await response.json();

        if (data.success) {
            workflowData = data.workflow;
            renderWorkflowStats();
            renderNodeGroups();
        } else {
            showError('Failed to load workflow data');
        }

        // Setup sheets link
        await fetchSheetsInfo();

        // Get current execution status
        await fetchCurrentStatus();

        // Build dynamic sheet tabs and fetch initial data
        await buildSheetTabs();

    } catch (error) {
        console.error('Initialization error:', error);
        showError('Failed to connect to server');
    }

    await fetchExecutions();
}

// Build dynamic sheet tabs from available cached sheets
async function buildSheetTabs() {
    const container = elements.sheetTabsContainer;
    if (!container) return;

    try {
        const response = await fetch(`${API_BASE}/api/sheets/list`);
        const data = await response.json();

        if (data.success && data.sheets && data.sheets.length > 0) {
            container.innerHTML = '';

            data.sheets.forEach((sheetName, index) => {
                const btn = document.createElement('button');
                btn.className = 'sheet-tab' + (index === 0 ? ' active' : '');
                btn.dataset.sheet = sheetName;
                btn.textContent = formatSheetTabName(sheetName);
                container.appendChild(btn);
            });

            // Set initial sheet and setup listeners
            dataTableState.currentSheet = data.sheets[0];
            setupSheetTabListeners();

            // Fetch initial data
            await fetchSheetsData(data.sheets[0]);
        } else {
            container.innerHTML = '<span class="tabs-loading">No sheets available - trigger a workflow</span>';
        }
    } catch (error) {
        console.error('Failed to build sheet tabs:', error);
        container.innerHTML = '<span class="tabs-loading">Failed to load sheets</span>';
    }
}

// Format sheet name for display in tabs
function formatSheetTabName(name) {
    if (!name) return '';
    return name
        .replace(/_/g, ' ')
        .replace(/Google Sheets\d+/g, match => `Sheet ${match.replace('Google Sheets', '')}`)
        .replace(/Intelligence/g, 'Intel');
}

// Setup click listeners for sheet tabs
function setupSheetTabListeners() {
    const tabs = document.querySelectorAll('.sheet-tab');
    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            const newSheet = tab.dataset.sheet;
            console.log(`[UI] Switching to sheet: ${newSheet}`);

            // Update active state
            tabs.forEach(t => t.classList.remove('active'));
            tab.classList.add('active');

            // Reset table state for new sheet
            dataTableState.currentSheet = newSheet;
            dataTableState.page = 1;
            dataTableState.search = '';
            dataTableState.sortBy = '';
            dataTableState.sortOrder = 'asc';

            // Clear search input
            if (elements.sheetsSearch) elements.sheetsSearch.value = '';

            // Clear previous data and show loading
            if (elements.sheetsDataContainer) {
                elements.sheetsDataContainer.innerHTML = `
                    <div class="loading-placeholder" style="padding: 40px;">
                        <div class="spinner"></div>
                        <span>Loading ${formatSheetTabName(newSheet)} data...</span>
                    </div>
                `;
            }

            // Fetch data for selected sheet
            fetchSheetsData(newSheet);
        });
    });
}

function setupEventListeners() {
    // Trigger form
    elements.triggerForm.addEventListener('submit', handleTriggerSubmit);

    // Note: Sheet tab listeners are set up in buildSheetTabs() after dynamic creation

    // Search with debounce
    if (elements.sheetsSearch) {
        elements.sheetsSearch.addEventListener('input', (e) => {
            clearTimeout(dataTableState.searchTimeout);
            dataTableState.searchTimeout = setTimeout(() => {
                dataTableState.search = e.target.value;
                dataTableState.page = 1;
                fetchSheetsData(dataTableState.currentSheet);
            }, 300);
        });
    }

    // Pagination controls
    if (elements.prevPageBtn) {
        elements.prevPageBtn.addEventListener('click', () => {
            if (dataTableState.page > 1) {
                dataTableState.page--;
                fetchSheetsData(dataTableState.currentSheet);
            }
        });
    }

    if (elements.nextPageBtn) {
        elements.nextPageBtn.addEventListener('click', () => {
            if (dataTableState.pagination?.hasNextPage) {
                dataTableState.page++;
                fetchSheetsData(dataTableState.currentSheet);
            }
        });
    }

    // Rows per page
    if (elements.rowsPerPage) {
        elements.rowsPerPage.addEventListener('change', (e) => {
            dataTableState.limit = parseInt(e.target.value);
            dataTableState.page = 1;
            fetchSheetsData(dataTableState.currentSheet);
        });
    }

    // Details tabs
    document.querySelectorAll('.details-tabs .tab').forEach(tab => {
        tab.addEventListener('click', () => switchTab(tab.dataset.tab));
    });
}

// ========================================
// WebSocket Connection - Real-time Updates
// ========================================

function connectWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}`;

    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
        updateConnectionStatus('connected', 'Connected');
        reconnectAttempts = 0;
        console.log('WebSocket connected');
    };

    ws.onmessage = (event) => {
        try {
            const message = JSON.parse(event.data);
            handleWebSocketMessage(message);
        } catch (error) {
            console.error('WebSocket message error:', error);
        }
    };

    ws.onclose = () => {
        updateConnectionStatus('', 'Disconnected');
        console.log('WebSocket disconnected');

        // Reconnect with backoff
        if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
            const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000);
            reconnectAttempts++;
            console.log(`Reconnecting in ${delay}ms...`);
            setTimeout(connectWebSocket, delay);
        }
    };

    ws.onerror = (error) => {
        updateConnectionStatus('error', 'Error');
        console.error('WebSocket error:', error);
    };
}

function handleWebSocketMessage(message) {
    console.log('WebSocket message:', message.type, message.status || '');

    switch (message.type) {
        case 'execution_status':
            updateExecutionDisplay(message);
            break;
        case 'fetch_sheets_data':
            // Automatically fetch sheets data when workflow completes
            console.log('Workflow completed - fetching sheets data...');
            setTimeout(() => fetchSheetsData(dataTableState.currentSheet), 1000);
            break;
        case 'sheets_data_update':
            // Direct data from n8n callback
            console.log(`Received ${message.totalRows} rows for ${message.sheetName} from n8n`);
            showNotification(`📊 Received ${message.totalRows} rows from workflow!`, 'success');
            fetchSheetsData(message.sheetName || dataTableState.currentSheet);
            break;
        case 'sheets_data_available':
            console.log('Sheets data available:', message.sheets);
            if (message.sheets && message.sheets.length > 0) {
                fetchSheetsData(message.sheets[0]);
            }
            break;
        case 'workflow_triggered':
            updateExecutionStatus('running');
            showNotification('Workflow triggered successfully!', 'success');
            break;
    }
}

function updateConnectionStatus(status, text) {
    elements.connectionStatus.className = `status-badge ${status}`;
    elements.connectionStatus.querySelector('.status-text').textContent = text;
}

// ========================================
// Execution Status Display
// ========================================

function updateExecutionDisplay(execution) {
    const status = execution.status || 'idle';
    updateExecutionStatus(status);

    // Update trigger button based on status
    if (status === 'running' || status === 'starting') {
        elements.triggerBtn.disabled = true;
        elements.triggerBtn.innerHTML = `
            <span class="spinner" style="width:16px;height:16px;border-width:2px;margin-right:8px;"></span>
            <span>Workflow Running...</span>
        `;
    } else {
        elements.triggerBtn.disabled = false;
        elements.triggerBtn.innerHTML = '<span class="btn-icon">▶</span><span>Trigger Workflow</span>';
    }

    // Handle completion
    if (status === 'completed') {
        showNotification('✅ Workflow completed successfully!', 'success');
        fetchExecutions();
    } else if (status === 'error') {
        showNotification(`❌ Workflow failed: ${execution.error || 'Unknown error'}`, 'error');
    }
}

function updateExecutionStatus(status) {
    const statusMap = {
        idle: { class: 'idle', text: '⚪ Idle' },
        starting: { class: 'running', text: '🔄 Starting...' },
        running: { class: 'running', text: '🔄 Running...' },
        completed: { class: 'completed', text: '✅ Completed' },
        success: { class: 'completed', text: '✅ Completed' },
        error: { class: 'error', text: '❌ Failed' }
    };

    const statusInfo = statusMap[status] || statusMap.idle;
    elements.executionStatus.innerHTML = `<span class="status-pill ${statusInfo.class}">${statusInfo.text}</span>`;
}

async function fetchCurrentStatus() {
    try {
        const response = await fetch(`${API_BASE}/api/workflow/status`);
        const data = await response.json();
        if (data.success && data.execution) {
            updateExecutionDisplay(data.execution);
        }
    } catch (error) {
        console.error('Failed to fetch status:', error);
    }
}

// ========================================
// Workflow Triggering
// ========================================

async function handleTriggerSubmit(event) {
    event.preventDefault();

    const formData = {
        message: document.getElementById('icpDescription').value,
        targetTitles: document.getElementById('targetTitles').value,
        targetLocation: document.getElementById('targetLocation').value,
        targetIndustry: document.getElementById('targetIndustry').value,
        leadCount: parseInt(document.getElementById('leadCount').value) || 10
    };

    elements.triggerBtn.disabled = true;
    elements.triggerBtn.innerHTML = `
        <span class="spinner" style="width:16px;height:16px;border-width:2px;margin-right:8px;"></span>
        <span>Triggering...</span>
    `;
    updateExecutionStatus('starting');

    try {
        const response = await fetch(`${API_BASE}/api/workflow/trigger`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ data: formData })
        });

        const result = await response.json();

        if (result.success) {
            showNotification('🚀 Workflow triggered! Monitoring progress...', 'success');
        } else {
            showNotification(`Error: ${result.error}`, 'error');
            updateExecutionStatus('error');
            elements.triggerBtn.disabled = false;
            elements.triggerBtn.innerHTML = '<span class="btn-icon">▶</span><span>Trigger Workflow</span>';
        }
    } catch (error) {
        console.error('Trigger error:', error);
        showNotification('Failed to trigger workflow', 'error');
        updateExecutionStatus('error');
        elements.triggerBtn.disabled = false;
        elements.triggerBtn.innerHTML = '<span class="btn-icon">▶</span><span>Trigger Workflow</span>';
    }
}

// ========================================
// Google Sheets Data Display (Enhanced)
// ========================================

async function fetchSheetsInfo() {
    try {
        const response = await fetch(`${API_BASE}/api/sheets/data`);
        const data = await response.json();

        if (data.sheetUrl && elements.sheetsLink) {
            elements.sheetsLink.href = data.sheetUrl;
        }
    } catch (error) {
        console.error('Failed to fetch sheets info:', error);
    }
}

async function fetchSheetsData(sheetName = 'Leads Master') {
    if (dataTableState.isLoading) return;
    dataTableState.isLoading = true;
    dataTableState.currentSheet = sheetName;

    // Show loading state
    if (elements.sheetsDataContainer) {
        elements.sheetsDataContainer.innerHTML = `
            <div class="loading-placeholder" style="padding: 40px;">
                <div class="spinner"></div>
                <span>Loading ${sheetName} data...</span>
            </div>
        `;
    }

    try {
        const params = new URLSearchParams({
            sheet: sheetName,
            page: dataTableState.page,
            limit: dataTableState.limit,
            sortBy: dataTableState.sortBy,
            sortOrder: dataTableState.sortOrder,
            search: dataTableState.search
        });

        const response = await fetch(`${API_BASE}/api/sheets/data?${params}`);
        const data = await response.json();

        if (data.success && data.data) {
            dataTableState.headers = data.headers;
            dataTableState.data = data.data;
            dataTableState.pagination = data.pagination;
            renderDataTable(data);
        } else if (data.noData) {
            renderEmptyState(data);
        } else {
            renderErrorState(data.error || 'Failed to load data');
        }
    } catch (error) {
        console.error('Failed to fetch sheets data:', error);
        renderErrorState('Network error - please check connection');
    } finally {
        dataTableState.isLoading = false;
    }
}

function renderDataTable(data) {
    const { headers, data: rows, pagination, sheetName } = data;

    if (!rows || rows.length === 0) {
        elements.sheetsDataContainer.innerHTML = `
            <div class="empty-state">
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                    <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
                    <line x1="3" y1="9" x2="21" y2="9"></line>
                    <line x1="9" y1="21" x2="9" y2="9"></line>
                </svg>
                <p>No data found in "${sheetName}"</p>
                ${dataTableState.search ? '<p class="hint">Try adjusting your search query</p>' : ''}
            </div>
        `;
        elements.paginationControls.style.display = 'none';
        return;
    }

    // Build sortable table headers
    const headerHtml = headers.map(h => {
        const isSorted = dataTableState.sortBy === h;
        const sortIcon = isSorted
            ? (dataTableState.sortOrder === 'asc' ? '↑' : '↓')
            : '↕';
        const sortClass = isSorted ? 'sorted' : '';
        return `
            <th class="sortable ${sortClass}" data-column="${escapeHtml(h)}" onclick="handleSort('${escapeHtml(h)}')">
                <span class="th-content">
                    ${escapeHtml(h)}
                    <span class="sort-icon">${sortIcon}</span>
                </span>
            </th>
        `;
    }).join('');

    // Build table rows
    const rowsHtml = rows.map((row, idx) => {
        const cells = headers.map(h => {
            const value = row[h] || '';
            const displayValue = truncate(String(value), 50);
            return `<td title="${escapeHtml(String(value))}">${escapeHtml(displayValue)}</td>`;
        }).join('');
        return `<tr>${cells}</tr>`;
    }).join('');

    elements.sheetsDataContainer.innerHTML = `
        <div class="data-stats">
            <span class="stat-badge primary">${pagination.totalRows} total rows</span>
            <span class="stat-badge">${headers.length} columns</span>
            ${dataTableState.search ? `<span class="stat-badge search">Filtering: "${escapeHtml(dataTableState.search)}"</span>` : ''}
        </div>
        <div class="table-wrapper">
            <table class="data-table">
                <thead>
                    <tr>${headerHtml}</tr>
                </thead>
                <tbody>
                    ${rowsHtml}
                </tbody>
            </table>
        </div>
    `;

    // Update pagination
    updatePaginationControls(pagination);
}

function updatePaginationControls(pagination) {
    if (!pagination || pagination.totalRows === 0) {
        elements.paginationControls.style.display = 'none';
        return;
    }

    elements.paginationControls.style.display = 'flex';

    // Update info text
    const start = (pagination.page - 1) * pagination.limit + 1;
    const end = Math.min(pagination.page * pagination.limit, pagination.totalRows);
    elements.paginationInfo.textContent = `Showing ${start} - ${end} of ${pagination.totalRows}`;

    // Update buttons
    elements.prevPageBtn.disabled = !pagination.hasPrevPage;
    elements.nextPageBtn.disabled = !pagination.hasNextPage;

    // Render page numbers
    let pageHtml = '';
    const maxVisiblePages = 5;
    let startPage = Math.max(1, pagination.page - Math.floor(maxVisiblePages / 2));
    let endPage = Math.min(pagination.totalPages, startPage + maxVisiblePages - 1);

    if (endPage - startPage < maxVisiblePages - 1) {
        startPage = Math.max(1, endPage - maxVisiblePages + 1);
    }

    if (startPage > 1) {
        pageHtml += `<button class="page-btn" onclick="goToPage(1)">1</button>`;
        if (startPage > 2) pageHtml += `<span class="page-ellipsis">...</span>`;
    }

    for (let i = startPage; i <= endPage; i++) {
        const activeClass = i === pagination.page ? 'active' : '';
        pageHtml += `<button class="page-btn ${activeClass}" onclick="goToPage(${i})">${i}</button>`;
    }

    if (endPage < pagination.totalPages) {
        if (endPage < pagination.totalPages - 1) pageHtml += `<span class="page-ellipsis">...</span>`;
        pageHtml += `<button class="page-btn" onclick="goToPage(${pagination.totalPages})">${pagination.totalPages}</button>`;
    }

    elements.pageNumbers.innerHTML = pageHtml;
}

function renderEmptyState(data) {
    elements.sheetsDataContainer.innerHTML = `
        <div class="waiting-state">
            <div class="waiting-icon">📊</div>
            <h3>Waiting for Workflow Data</h3>
            <p>Data will appear here automatically after the workflow completes.</p>
            <div class="tip-box">
                <strong>💡 Tip:</strong> Add an HTTP Request node at the end of your n8n workflow to send data to this dashboard.
            </div>
            ${data.sheetUrl ? `
                <a href="${data.sheetUrl}" target="_blank" class="btn btn-primary" style="margin-top: 16px;">
                    Open Google Sheet
                </a>
            ` : ''}
        </div>
    `;
    elements.paginationControls.style.display = 'none';
}

function renderErrorState(message) {
    elements.sheetsDataContainer.innerHTML = `
        <div class="error-state">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                <circle cx="12" cy="12" r="10"></circle>
                <line x1="12" y1="8" x2="12" y2="12"></line>
                <line x1="12" y1="16" x2="12.01" y2="16"></line>
            </svg>
            <p>${escapeHtml(message)}</p>
            <button class="btn btn-primary" style="margin-top: 16px;" onclick="fetchSheetsData('${dataTableState.currentSheet}')">
                Retry
            </button>
        </div>
    `;
    elements.paginationControls.style.display = 'none';
}

// Global function for sorting (called from onclick)
function handleSort(column) {
    if (dataTableState.sortBy === column) {
        // Toggle order
        dataTableState.sortOrder = dataTableState.sortOrder === 'asc' ? 'desc' : 'asc';
    } else {
        dataTableState.sortBy = column;
        dataTableState.sortOrder = 'asc';
    }
    dataTableState.page = 1;
    fetchSheetsData(dataTableState.currentSheet);
}

// Global function for pagination (called from onclick)
function goToPage(page) {
    dataTableState.page = page;
    fetchSheetsData(dataTableState.currentSheet);
}

// ========================================
// Rendering Functions
// ========================================

function renderWorkflowStats() {
    if (!workflowData) return;

    elements.totalNodes.textContent = workflowData.totalNodes;
    elements.linkedinNodes.textContent = workflowData.nodeGroups.linkedin.length;
    elements.sheetsNodes.textContent = workflowData.nodeGroups.sheets.length;
    elements.aiNodes.textContent = workflowData.nodeGroups.ai.length;
}

function renderNodeGroups() {
    if (!workflowData) return;

    const groups = [
        { key: 'triggers', label: 'Triggers', icon: '⚡' },
        { key: 'linkedin', label: 'LinkedIn', icon: '🔗' },
        { key: 'sheets', label: 'Google Sheets', icon: '📊' },
        { key: 'ai', label: 'AI Processing', icon: '🤖' },
        { key: 'logic', label: 'Logic & Control', icon: '⚙️' },
        { key: 'other', label: 'Other', icon: '📦' }
    ];

    let html = '';

    groups.forEach(group => {
        const nodes = workflowData.nodeGroups[group.key];
        if (!nodes || nodes.length === 0) return;

        html += `
            <div class="node-group ${group.key}">
                <div class="node-group-header">
                    <span class="group-icon">${group.icon}</span>
                    ${group.label} (${nodes.length})
                </div>
                <div class="node-group-nodes">
                    ${nodes.map(node => `
                        <div class="node-item" data-node-id="${node.id}" data-node-name="${escapeHtml(node.name)}" onclick="showNodeDetails('${node.id}', '${escapeHtml(node.name)}')">
                            <span class="node-status-icon"></span>
                            <span class="node-name">${truncate(node.name, 25)}</span>
                        </div>
                    `).join('')}
                </div>
            </div>
        `;
    });

    elements.nodeGroups.innerHTML = html || '<div class="empty-state">No nodes found</div>';
}

// ========================================
// Executions List
// ========================================

async function fetchExecutions() {
    try {
        const response = await fetch(`${API_BASE}/api/workflow/executions`);
        const data = await response.json();

        if (data.success && data.executions) {
            renderExecutionsList(Array.isArray(data.executions) ? data.executions : []);
        }
    } catch (error) {
        console.error('Failed to fetch executions:', error);
    }
}

function renderExecutionsList(executions) {
    if (!executions || executions.length === 0) {
        elements.executionsList.innerHTML = '<div class="empty-state">No executions yet</div>';
        return;
    }

    elements.executionsList.innerHTML = executions.slice(0, 10).map(exec => {
        const status = exec.status || (exec.finished ? 'success' : 'running');
        const date = new Date(exec.startedAt || exec.createdAt);
        const timeStr = date.toLocaleTimeString();
        const dateStr = date.toLocaleDateString();

        return `
            <div class="execution-item" onclick="loadExecution('${exec.id}')">
                <span class="execution-status-dot ${status}"></span>
                <div class="execution-info">
                    <div class="execution-id">#${exec.id.slice(0, 8)}...</div>
                    <div class="execution-time">${dateStr} ${timeStr}</div>
                </div>
            </div>
        `;
    }).join('');
}

async function loadExecution(executionId) {
    showNotification('Loading execution details...', 'info');
}

// ========================================
// Node Details
// ========================================

function showNodeDetails(nodeId, nodeName) {
    elements.nodeDetailsCard.style.display = 'block';
    elements.detailsNodeName.textContent = nodeName;
    elements.inputData.textContent = 'Select an execution to view node data';
    elements.outputData.textContent = 'Select an execution to view node data';
    elements.nodeDetailsCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function closeNodeDetails() {
    elements.nodeDetailsCard.style.display = 'none';
}

function switchTab(tabName) {
    document.querySelectorAll('.details-tabs .tab').forEach(tab => {
        tab.classList.toggle('active', tab.dataset.tab === tabName);
    });

    document.querySelectorAll('.tab-panel').forEach(panel => {
        panel.classList.toggle('active', panel.id === `${tabName}Panel`);
    });
}

// ========================================
// Utility Functions
// ========================================

function truncate(str, length) {
    if (!str) return '';
    return str.length > length ? str.slice(0, length) + '...' : str;
}

function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML.replace(/'/g, "\\'").replace(/"/g, '\\"');
}

function showNotification(message, type = 'info') {
    console.log(`[${type.toUpperCase()}] ${message}`);

    // Remove existing notifications
    document.querySelectorAll('.toast').forEach(t => t.remove());

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    toast.style.cssText = `
        position: fixed;
        bottom: 20px;
        right: 20px;
        padding: 14px 24px;
        background: ${type === 'success' ? 'linear-gradient(135deg, #10B981, #059669)' : type === 'error' ? 'linear-gradient(135deg, #EF4444, #DC2626)' : 'linear-gradient(135deg, #3B82F6, #2563EB)'};
        color: white;
        border-radius: 10px;
        font-size: 14px;
        font-weight: 500;
        z-index: 1000;
        box-shadow: 0 10px 40px rgba(0,0,0,0.3);
        animation: slideIn 0.3s ease;
    `;

    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 4000);
}

function showError(message) {
    elements.nodeGroups.innerHTML = `
        <div class="empty-state" style="color: #EF4444;">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="12" r="10"></circle>
                <line x1="12" y1="8" x2="12" y2="12"></line>
                <line x1="12" y1="16" x2="12.01" y2="16"></line>
            </svg>
            <p>${message}</p>
            <button class="btn btn-primary" style="margin-top: 16px;" onclick="location.reload()">
                Retry
            </button>
        </div>
    `;
}

// Add animations and additional styles
const style = document.createElement('style');
style.textContent = `
    @keyframes slideIn {
        from { transform: translateX(100%); opacity: 0; }
        to { transform: translateX(0); opacity: 1; }
    }
`;
document.head.appendChild(style);
