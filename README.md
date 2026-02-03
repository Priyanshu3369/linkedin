# LinkedIn Outreach Dashboard

A real-time monitoring dashboard for your n8n LinkedIn outreach workflow.

## Features

- **Trigger Workflow** - Start workflow execution with custom ICP parameters
- **Real-Time Monitoring** - Watch nodes execute with live status updates
- **Node Details** - View input/output data for each node
- **Execution History** - Browse recent workflow runs
- **Google Sheets Link** - Quick access to results spreadsheet

## Quick Start

### 1. Install Dependencies
```powershell
cd d:\OneDrive\Documents\Desktop\LINKEDIN\dashboard
npm install
```

### 2. Configure Environment
The `.env` file is already configured with your credentials:
- `N8N_BASE_URL` - Your n8n instance URL (http://localhost:5678)
- `N8N_API_KEY` - Your n8n API key
- `N8N_WORKFLOW_ID` - The workflow ID to trigger
- `GOOGLE_SHEET_ID` - Your Google Sheets ID for results

### 3. Start the Dashboard
```powershell
npm start
```

### 4. Open in Browser
Navigate to: **http://localhost:3000**

## Requirements

- Node.js 16+
- n8n running locally (http://localhost:5678)
- n8n API key configured

## Usage

1. **Trigger Workflow**: Fill in ICP details and click "Trigger Workflow"
2. **Monitor Progress**: Watch nodes light up as they execute
3. **View Details**: Click any node to see its input/output data
4. **Check Results**: Click "Open in Sheets" to view your leads

## Architecture

```
dashboard/
├── server.js          # Express + WebSocket backend
├── package.json       # Dependencies
├── .env              # Configuration
└── public/
    ├── index.html    # Dashboard UI
    ├── styles.css    # Styling
    └── app.js        # Frontend logic
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/workflow` | GET | Get workflow structure |
| `/api/workflow/trigger` | POST | Trigger workflow execution |
| `/api/workflow/executions` | GET | List recent executions |
| `/api/workflow/execution/:id` | GET | Get execution details |
| `/api/sheets/data` | GET | Get Google Sheets info |
