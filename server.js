require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { WebSocketServer } = require('ws');
const http = require('http');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Configuration
const N8N_BASE_URL = process.env.N8N_BASE_URL || 'http://localhost:5678';
const N8N_API_KEY = process.env.N8N_API_KEY;
const WORKFLOW_ID = process.env.N8N_WORKFLOW_ID;
const WEBHOOK_URL = process.env.N8N_WEBHOOK_URL;
const GOOGLE_SHEET_ID = process.env.GOOGLE_SHEET_ID;
const PORT = process.env.PORT || 3000;

// n8n API client
const n8nApi = axios.create({
  baseURL: N8N_BASE_URL,
  headers: {
    'X-N8N-API-KEY': N8N_API_KEY,
    'Content-Type': 'application/json'
  },
  timeout: 60000
});

// State
const clients = new Set();
let currentExecution = null;
let isPolling = false;
let pollingInterval = null;
let cachedSheetsData = {};
let triggeredExecutionId = null; // Track the specific execution ID

// WebSocket connection handler
wss.on('connection', (ws) => {
  console.log('Client connected');
  clients.add(ws);

  // Send current state to new client
  if (currentExecution) {
    ws.send(JSON.stringify({
      type: 'execution_status',
      ...currentExecution
    }));
  }

  // Send cached sheets data info if available
  if (Object.keys(cachedSheetsData).length > 0) {
    ws.send(JSON.stringify({
      type: 'sheets_data_available',
      sheets: Object.keys(cachedSheetsData)
    }));
  }

  ws.on('close', () => {
    console.log('Client disconnected');
    clients.delete(ws);
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
    clients.delete(ws);
  });
});

// Broadcast to all connected clients
function broadcast(data) {
  const message = JSON.stringify(data);
  console.log('[BROADCAST]', data.type, data.status || '');
  clients.forEach(client => {
    if (client.readyState === 1) {
      client.send(message);
    }
  });
}

// Parse workflow JSON
function parseWorkflow(workflowData) {
  const nodes = workflowData.nodes || [];
  const connections = workflowData.connections || {};
  const actualNodes = nodes.filter(node => node.type !== 'n8n-nodes-base.stickyNote');

  const nodeGroups = {
    triggers: [], linkedin: [], sheets: [], ai: [], logic: [], other: []
  };

  actualNodes.forEach(node => {
    const type = node.type.toLowerCase();
    const name = node.name.toLowerCase();

    if (type.includes('trigger') || type.includes('webhook') || type.includes('schedule')) {
      nodeGroups.triggers.push(node);
    } else if (type.includes('linkedin') || type.includes('hdw')) {
      nodeGroups.linkedin.push(node);
    } else if (type.includes('sheet') || name.includes('sheet')) {
      nodeGroups.sheets.push(node);
    } else if (type.includes('openai') || type.includes('langchain') || type.includes('ai') || name.includes('agent')) {
      nodeGroups.ai.push(node);
    } else if (type.includes('if') || type.includes('switch') || type.includes('split') || type.includes('merge') || type.includes('loop')) {
      nodeGroups.logic.push(node);
    } else {
      nodeGroups.other.push(node);
    }
  });

  return {
    name: workflowData.name,
    totalNodes: actualNodes.length,
    nodes: actualNodes.map(n => ({ id: n.id, name: n.name, type: n.type, position: n.position })),
    nodeGroups: {
      triggers: nodeGroups.triggers.map(n => ({ id: n.id, name: n.name, type: n.type })),
      linkedin: nodeGroups.linkedin.map(n => ({ id: n.id, name: n.name, type: n.type })),
      sheets: nodeGroups.sheets.map(n => ({ id: n.id, name: n.name, type: n.type })),
      ai: nodeGroups.ai.map(n => ({ id: n.id, name: n.name, type: n.type })),
      logic: nodeGroups.logic.map(n => ({ id: n.id, name: n.name, type: n.type })),
      other: nodeGroups.other.map(n => ({ id: n.id, name: n.name, type: n.type }))
    },
    connections
  };
}

// ============================================
// API Routes
// ============================================

// Get workflow info
app.get('/api/workflow', async (req, res) => {
  try {
    const workflowPath = path.join(__dirname, 'LinkedIn Outreach Flow - testing.json');
    const workflowData = JSON.parse(fs.readFileSync(workflowPath, 'utf8'));
    const parsed = parseWorkflow(workflowData);
    res.json({ success: true, workflow: parsed });
  } catch (error) {
    console.error('Error reading workflow:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Trigger workflow execution via webhook
app.post('/api/workflow/trigger', async (req, res) => {
  try {
    const { data } = req.body;

    console.log('\n========== TRIGGERING WORKFLOW ==========');
    console.log('Data:', JSON.stringify(data, null, 2));

    if (!WEBHOOK_URL) {
      throw new Error('N8N_WEBHOOK_URL not configured in .env file');
    }

    // Reset state for new execution
    cachedSheetsData = {};
    triggeredExecutionId = null;
    stopPolling();

    // IMPORTANT: Get existing execution IDs BEFORE triggering
    let existingExecutionIds = new Set();
    try {
      const existingResponse = await n8nApi.get('/api/v1/executions', {
        params: { workflowId: WORKFLOW_ID, limit: 20 }
      });
      const existingExecs = existingResponse.data.data || existingResponse.data || [];
      existingExecutionIds = new Set(existingExecs.map(e => e.id));
      console.log(`[TRIGGER] Found ${existingExecutionIds.size} existing executions`);
    } catch (err) {
      console.log('[TRIGGER] Could not fetch existing executions:', err.message);
    }

    // Update status - workflow starting
    currentExecution = {
      status: 'starting',
      startedAt: new Date().toISOString(),
      data: data,
      message: 'Triggering workflow...',
      existingExecutionIds: Array.from(existingExecutionIds) // Store for polling
    };
    broadcast({ type: 'execution_status', ...currentExecution });

    // Trigger workflow via webhook
    const response = await axios.post(WEBHOOK_URL, data, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 30000
    });

    console.log('Webhook response:', response.data);

    // Update status - workflow running
    currentExecution = {
      ...currentExecution,
      status: 'running',
      webhookResponse: response.data,
      message: 'Workflow is running...'
    };
    broadcast({ type: 'execution_status', ...currentExecution });

    // Start polling for execution status
    startPolling(existingExecutionIds);

    res.json({
      success: true,
      message: 'Workflow triggered successfully',
      status: 'running',
      response: response.data
    });
  } catch (error) {
    const errorMsg = error.code === 'ECONNREFUSED'
      ? 'Cannot connect to n8n webhook. Make sure n8n is running.'
      : error.response?.data?.message || error.message || 'Unknown error';

    console.error('Error triggering workflow:', errorMsg);

    currentExecution = {
      status: 'error',
      error: errorMsg,
      endedAt: new Date().toISOString()
    };
    broadcast({ type: 'execution_status', ...currentExecution });

    res.status(500).json({ success: false, error: errorMsg });
  }
});

// Get current execution status
app.get('/api/workflow/status', (req, res) => {
  res.json({
    success: true,
    execution: currentExecution || { status: 'idle' }
  });
});

// Get recent executions from n8n
app.get('/api/workflow/executions', async (req, res) => {
  try {
    const response = await n8nApi.get('/api/v1/executions', {
      params: { workflowId: WORKFLOW_ID, limit: 20 }
    });
    res.json({ success: true, executions: response.data.data || response.data });
  } catch (error) {
    console.error('Error getting executions:', error.response?.data || error.message);
    res.json({ success: true, executions: [], error: error.message });
  }
});

// ============================================
// n8n Callback Endpoints
// ============================================

// Receive sheets data from n8n (if workflow sends callback)
app.post('/api/workflow/callback', (req, res) => {
  console.log('[CALLBACK] Received callback from n8n');

  const { sheetName, data, status, message } = req.body;

  if (status === 'completed') {
    currentExecution = {
      status: 'completed',
      startedAt: currentExecution?.startedAt,
      endedAt: new Date().toISOString(),
      result: req.body
    };
    broadcast({ type: 'execution_status', ...currentExecution });

    if (data && Array.isArray(data)) {
      const sheet = sheetName || 'Leads Master';
      cachedSheetsData[sheet] = {
        data: data,
        receivedAt: new Date().toISOString()
      };

      broadcast({
        type: 'sheets_data_update',
        sheetName: sheet,
        data: data,
        totalRows: data.length
      });
    }

    broadcast({ type: 'fetch_sheets_data' });
  } else if (sheetName && data) {
    cachedSheetsData[sheetName] = {
      data: data,
      receivedAt: new Date().toISOString()
    };

    broadcast({
      type: 'sheets_data_update',
      sheetName: sheetName,
      data: data,
      totalRows: data.length
    });
    console.log(`[CALLBACK] Received ${data.length} rows for sheet: ${sheetName}`);
  }

  res.json({ success: true, message: 'Data received' });
});

// Mark workflow as complete (alternative endpoint)
app.post('/api/workflow/complete', (req, res) => {
  console.log('[COMPLETE] Workflow completion webhook received');

  currentExecution = {
    status: 'completed',
    endedAt: new Date().toISOString(),
    startedAt: currentExecution?.startedAt,
    result: req.body
  };

  if (req.body.sheets) {
    Object.entries(req.body.sheets).forEach(([sheetName, data]) => {
      cachedSheetsData[sheetName] = {
        data: Array.isArray(data) ? data : [],
        receivedAt: new Date().toISOString()
      };
    });
  }

  broadcast({ type: 'execution_status', ...currentExecution });
  broadcast({ type: 'fetch_sheets_data' });

  res.json({ success: true, message: 'Completion recorded' });
});

// Get Google Sheets data (from cache with pagination, sorting, search)
app.get('/api/sheets/data', (req, res) => {
  const sheetName = req.query.sheet || 'Aplify Testing';
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 20;
  const sortBy = req.query.sortBy || '';
  const sortOrder = req.query.sortOrder || 'asc';
  const searchQuery = (req.query.search || '').toLowerCase().trim();

  console.log(`[API] Fetching sheets data: sheet=${sheetName}, page=${page}, limit=${limit}`);

  if (cachedSheetsData[sheetName]) {
    const cached = cachedSheetsData[sheetName];
    let data = cached.data;

    // Extract headers
    let headers = [];
    let rows = data;

    if (data.length > 0) {
      if (Array.isArray(data[0])) {
        headers = data[0];
        rows = data.slice(1).map(row => {
          const obj = {};
          headers.forEach((h, i) => { obj[h] = row[i] || ''; });
          return obj;
        });
      } else {
        headers = Object.keys(data[0]);
        rows = data;
      }
    }

    // Apply search filter
    if (searchQuery) {
      rows = rows.filter(row => {
        return headers.some(header => {
          const value = String(row[header] || '').toLowerCase();
          return value.includes(searchQuery);
        });
      });
    }

    // Apply sorting
    if (sortBy && headers.includes(sortBy)) {
      rows.sort((a, b) => {
        const valA = String(a[sortBy] || '').toLowerCase();
        const valB = String(b[sortBy] || '').toLowerCase();

        const numA = parseFloat(valA);
        const numB = parseFloat(valB);
        if (!isNaN(numA) && !isNaN(numB)) {
          return sortOrder === 'asc' ? numA - numB : numB - numA;
        }

        return sortOrder === 'asc' ? valA.localeCompare(valB) : valB.localeCompare(valA);
      });
    }

    // Calculate pagination
    const totalRows = rows.length;
    const totalPages = Math.ceil(totalRows / limit);
    const startIndex = (page - 1) * limit;
    const endIndex = startIndex + limit;
    const paginatedRows = rows.slice(startIndex, endIndex);

    res.json({
      success: true,
      sheetName,
      headers,
      data: paginatedRows,
      pagination: {
        page,
        limit,
        totalRows,
        totalPages,
        hasNextPage: page < totalPages,
        hasPrevPage: page > 1
      },
      sort: { sortBy, sortOrder },
      search: searchQuery,
      source: 'n8n-execution',
      receivedAt: cached.receivedAt
    });
  } else {
    res.json({
      success: true,
      sheetId: GOOGLE_SHEET_ID,
      sheetUrl: `https://docs.google.com/spreadsheets/d/${GOOGLE_SHEET_ID}`,
      message: 'No data yet. Trigger a workflow to fetch data.',
      noData: true,
      availableSheets: Object.keys(cachedSheetsData)
    });
  }
});

// Get available sheets
app.get('/api/sheets/list', (req, res) => {
  const cachedSheets = Object.keys(cachedSheetsData);
  res.json({
    success: true,
    sheets: cachedSheets.length > 0 ? cachedSheets : ['Aplify Testing'],
    cached: cachedSheets.length > 0
  });
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    n8nUrl: N8N_BASE_URL,
    webhookUrl: WEBHOOK_URL ? 'configured' : 'not configured',
    workflowId: WORKFLOW_ID,
    callbackUrl: `http://localhost:${PORT}/api/workflow/callback`,
    cachedSheets: Object.keys(cachedSheetsData),
    currentExecution: currentExecution?.status || 'idle',
    isPolling
  });
});

// ============================================
// Execution Polling - Improved
// ============================================

function stopPolling() {
  isPolling = false;
  if (pollingInterval) {
    clearInterval(pollingInterval);
    pollingInterval = null;
  }
}

async function fetchExecutionData(executionId) {
  try {
    console.log(`[FETCH] Getting execution data for: ${executionId}`);

    const response = await n8nApi.get(`/api/v1/executions/${executionId}`, {
      params: { includeData: true }
    });

    const execution = response.data;

    if (!execution || !execution.data || !execution.data.resultData) {
      console.log('[FETCH] No result data in execution');
      return null;
    }

    const runData = execution.data.resultData.runData || {};
    let sheetsData = [];
    let foundNode = null;

    // Priority 1: Look for "Get Many" Google Sheets node
    for (const [nodeName, nodeRuns] of Object.entries(runData)) {
      const lowerName = nodeName.toLowerCase();
      if (lowerName.includes('get many') || lowerName.includes('sheet') || lowerName.includes('google')) {
        const data = extractNodeOutput(nodeRuns);
        if (data && data.length > 0) {
          sheetsData = data;
          foundNode = nodeName;
          console.log(`[FETCH] Found ${sheetsData.length} rows from: ${nodeName}`);
          break;
        }
      }
    }

    // Priority 2: Find any node with substantial data output
    if (sheetsData.length === 0) {
      for (const [nodeName, nodeRuns] of Object.entries(runData)) {
        const data = extractNodeOutput(nodeRuns);
        if (data && data.length > 5) { // Look for nodes with meaningful output
          sheetsData = data;
          foundNode = nodeName;
          console.log(`[FETCH] Using output from: ${nodeName} (${sheetsData.length} items)`);
          break;
        }
      }
    }

    if (sheetsData.length > 0) {
      const sheetName = 'Aplify Testing';
      cachedSheetsData[sheetName] = {
        data: sheetsData,
        receivedAt: new Date().toISOString(),
        source: foundNode
      };

      console.log(`[FETCH] Cached ${sheetsData.length} rows for: ${sheetName}`);

      broadcast({
        type: 'sheets_data_update',
        sheetName: sheetName,
        data: sheetsData,
        totalRows: sheetsData.length
      });

      return sheetsData;
    }

    console.log('[FETCH] No sheets data found in execution output');
    return null;
  } catch (error) {
    console.error('[FETCH] Error:', error.message);
    return null;
  }
}

function extractNodeOutput(nodeRuns) {
  if (!nodeRuns || nodeRuns.length === 0) return null;

  const lastRun = nodeRuns[nodeRuns.length - 1];
  if (!lastRun.data || !lastRun.data.main || lastRun.data.main.length === 0) return null;

  const outputItems = lastRun.data.main[0] || [];
  if (outputItems.length === 0) return null;

  return outputItems.map(item => item.json || item);
}

function startPolling(existingExecutionIds = new Set()) {
  if (isPolling) return;
  isPolling = true;

  console.log('[POLLING] Started execution polling');
  console.log(`[POLLING] Ignoring ${existingExecutionIds.size} existing executions`);

  let pollCount = 0;
  const maxPolls = 600; // 10 minutes max
  let foundNewExecution = false;

  const poll = async () => {
    if (!isPolling || pollCount >= maxPolls) {
      console.log('[POLLING] Stopped - max polls reached or polling disabled');
      stopPolling();
      return;
    }

    pollCount++;

    try {
      // Fetch recent executions
      const response = await n8nApi.get('/api/v1/executions', {
        params: { workflowId: WORKFLOW_ID, limit: 20 }
      });

      const executions = response.data.data || response.data || [];
      let targetExec = null;

      // If we already found and are tracking an execution, find it
      if (triggeredExecutionId) {
        targetExec = executions.find(e => e.id === triggeredExecutionId);
        if (targetExec) {
          foundNewExecution = true;
        }
      }

      // Otherwise, find a NEW execution that wasn't in the existing set
      if (!targetExec) {
        for (const exec of executions) {
          // Skip executions that existed before we triggered
          if (existingExecutionIds.has(exec.id)) {
            continue;
          }

          // This is a NEW execution - track it
          targetExec = exec;
          triggeredExecutionId = exec.id;
          foundNewExecution = true;
          console.log(`[POLLING] Found NEW execution: ${exec.id} (status: ${exec.status}, finished: ${exec.finished})`);
          break;
        }
      }

      if (!targetExec) {
        // Keep waiting for new execution to appear
        if (pollCount % 5 === 0) {
          console.log(`[POLLING] Waiting for new execution to appear... (poll ${pollCount})`);
        }
        pollingInterval = setTimeout(poll, 1000);
        return;
      }

      const execStatus = (targetExec.status || '').toLowerCase();
      const isFinished = targetExec.finished === true;
      const stoppedAt = targetExec.stoppedAt;
      const isWaiting = execStatus === 'waiting';
      const isRunning = !isFinished && !stoppedAt && (execStatus === 'running' || execStatus === '' || execStatus === 'new');
      const isError = execStatus === 'error' || execStatus === 'failed' || execStatus === 'crashed';
      const isSuccess = (isFinished && !isError) || execStatus === 'success' || execStatus === 'completed';

      // Log status changes
      if (pollCount % 5 === 0 || isFinished || stoppedAt) {
        console.log(`[POLLING] Execution ${targetExec.id}: status=${execStatus}, finished=${isFinished}, stoppedAt=${stoppedAt ? 'yes' : 'no'}`);
      }

      if (isWaiting) {
        // Workflow is waiting (paused) - show as running
        currentExecution = {
          ...currentExecution,
          status: 'running',
          executionId: targetExec.id,
          message: 'Workflow is waiting/paused...'
        };
        broadcast({ type: 'execution_status', ...currentExecution });
        pollingInterval = setTimeout(poll, 2000);
      } else if (isRunning) {
        // Still running - update status
        currentExecution = {
          ...currentExecution,
          status: 'running',
          executionId: targetExec.id,
          message: 'Workflow is running...'
        };
        broadcast({ type: 'execution_status', ...currentExecution });
        pollingInterval = setTimeout(poll, 1000);
      } else if (isSuccess) {
        // Completed successfully
        console.log(`[POLLING] Workflow COMPLETED: ${targetExec.id}`);

        currentExecution = {
          status: 'completed',
          startedAt: currentExecution?.startedAt,
          endedAt: new Date().toISOString(),
          executionId: targetExec.id,
          message: 'Workflow completed!'
        };
        broadcast({ type: 'execution_status', ...currentExecution });

        // Fetch the actual output data
        await fetchExecutionData(targetExec.id);

        broadcast({ type: 'fetch_sheets_data' });
        stopPolling();
      } else if (isError) {
        // Failed
        console.log(`[POLLING] Workflow FAILED: ${targetExec.id}`);

        currentExecution = {
          status: 'error',
          startedAt: currentExecution?.startedAt,
          endedAt: new Date().toISOString(),
          error: targetExec.error || 'Workflow failed',
          executionId: targetExec.id
        };
        broadcast({ type: 'execution_status', ...currentExecution });
        stopPolling();
      } else {
        // Unknown state - keep polling
        console.log(`[POLLING] Unknown state for ${targetExec.id}: status=${execStatus}, finished=${isFinished}`);
        pollingInterval = setTimeout(poll, 2000);
      }
    } catch (error) {
      console.error('[POLLING] Error:', error.message);
      pollingInterval = setTimeout(poll, 3000);
    }
  };

  // Start polling after a short delay to allow execution to start
  pollingInterval = setTimeout(poll, 3000);
}

// Serve frontend
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
server.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════════════╗
║     LinkedIn Outreach Dashboard                           ║
║     Running at: http://localhost:${PORT}                     ║
╠═══════════════════════════════════════════════════════════╣
║  Webhook: ${WEBHOOK_URL ? WEBHOOK_URL.slice(0, 45) + '...' : 'Not configured'}
╠═══════════════════════════════════════════════════════════╣
║  📌 Callback URL: http://localhost:${PORT}/api/workflow/callback
╚═══════════════════════════════════════════════════════════╝
  `);
});
