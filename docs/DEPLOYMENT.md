# Deployment Guide

Complete deployment instructions for all deployment modes of the Obsidian MCP Server.

## Table of Contents

- [From a push to a running pod](#from-a-push-to-a-running-pod)
- [Environment Configuration](#environment-configuration)
- [Stdio Mode (Local)](#stdio-mode-local)
- [HTTP Mode](#http-mode)
- [AWS Lambda](#aws-lambda)

## From a push to a running pod

Every push to `main` runs the **Release** workflow
(`.github/workflows/release.yml`): the tests, then a multi-architecture
(amd64, arm64) image pushed to `ghcr.io/<owner>/<repo>` with two tags:

| Tag                | Moves?     | Use it for                                                       |
| ------------------ | ---------- | ---------------------------------------------------------------- |
| `main-<short sha>` | Never      | Deploying. One per commit, so it also names what to roll back to |
| `latest`           | Every push | Trying the newest build by hand                                  |

Deploy a build by naming its tag — the workflow's run summary prints this
command for you:

```bash
helm upgrade brainmcp ./brainmcp-chart -n brain --reuse-values --set image.tag=main-c4786cc
```

Rolling back is the same command with an older tag.

**Why not just leave the chart on `latest`?** Because Helm would never pick up
a new image. An upgrade with unchanged values renders an identical pod
template, Kubernetes sees nothing to change, and no pod is replaced — so the
new `latest` is not pulled until something else happens to restart the pod.
Changing `image.tag` changes the template, and that is what makes the rollout
happen. (`kubectl rollout restart` also works with `latest`, but then nothing
records which build is running.)

Branches other than `main` run the tests only; they do not publish an image.

A rollout restarts the server, and OAuth sessions are held in memory, so each
deploy signs connected clients out once.

## Environment Configuration

All deployment modes require environment variables. Start by copying the example:

```bash
cp .env.example .env
```

### Core Variables (Required for all modes)

```bash
# Git Repository Configuration
VAULT_REPO=https://github.com/username/vault-repo.git
VAULT_BRANCH=main
GIT_TOKEN=your_personal_access_token

# Journal Configuration
JOURNAL_PATH_TEMPLATE=Journal/{{date}}.md
JOURNAL_DATE_FORMAT=YYYY-MM-DD
JOURNAL_ACTIVITY_SECTION=## Activity
JOURNAL_FILE_TEMPLATE=Templates/daily-note.md
```

See [Git Providers documentation](GIT_PROVIDERS.md) for token setup instructions.

### OAuth Variables (Required for HTTP and Lambda modes)

```bash
# OAuth Configuration
OAUTH_CLIENT_ID=obsidian-mcp-client
OAUTH_CLIENT_SECRET=<generate_random_secret>
PERSONAL_AUTH_TOKEN=<generate_random_token>
BASE_URL=http://localhost:3000  # Or your Lambda Function URL
```

Generate secure secrets using:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

To let some clients read without being able to write, generate another token
the same way and set it as `PERSONAL_AUTH_TOKEN_RO`. See
[Setting up a read-only token](../README.md#setting-up-a-read-only-token).

### Optional Variables

```bash
# Git Configuration (for self-hosted providers)
GIT_USERNAME=your_username

# Local Development
LOCAL_VAULT_PATH=./vault-local
PORT=3000

# Session Management
SESSION_EXPIRY_MS=86400000  # 24 hours

# AWS Configuration
AWS_REGION=eu-west-1
```

---

## Stdio Mode (Local)

Stdio mode uses standard input/output for communication with local MCP clients like Claude Desktop and Cursor.

### Prerequisites

- Node.js 22+ and npm, OR Docker
- Configured `.env` file with core variables

### Using npm

1. Install dependencies:

```bash
npm install
```

2. Configure environment:

```bash
cp .env.example .env
# Edit .env with your vault repo and git token
```

3. Run the server:

```bash
npm run dev
```

4. Configure your MCP client:

#### Claude Desktop

Add to your config file:

**macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "obsidian": {
      "command": "npm",
      "args": ["run", "--prefix", "/ABSOLUTE/PATH/TO/obsidian-mcp", "dev"]
    }
  }
}
```

Windows: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "obsidian": {
      "command": "npm",
      "args": ["run", "--prefix", "C:\\ABSOLUTE\\PATH\\TO\\obsidian-mcp", "dev"]
    }
  }
}
```

Restart Claude Desktop to load the server.

#### Cursor

Add to your Cursor MCP settings:

```json
{
  "mcpServers": {
    "obsidian": {
      "command": "npm",
      "args": ["run", "--prefix", "/ABSOLUTE/PATH/TO/obsidian-mcp", "dev"]
    }
  }
}
```

### Using Docker

1. Pull the image:

```bash
docker pull ghcr.io/jmashburn/brainmcp:latest
```

2. Configure environment:

```bash
cp .env.example obsidian-mcp.env
# Edit obsidian-mcp.env with your configuration
```

3. Test the server:

```bash
docker run -i --rm \
  -v "/ABSOLUTE/PATH/TO/obsidian-mcp.env:/app/.env" \
  ghcr.io/jmashburn/brainmcp:latest \
  stdio
```

4. Configure your MCP client:

#### Claude Desktop

**macOS/Linux:**

```json
{
  "mcpServers": {
    "obsidian": {
      "command": "docker",
      "args": [
        "run",
        "-i",
        "--rm",
        "-v",
        "/ABSOLUTE/PATH/TO/obsidian-mcp.env:/app/.env",
        "ghcr.io/jmashburn/brainmcp:latest",
        "stdio"
      ]
    }
  }
}
```

Windows:

```json
{
  "mcpServers": {
    "obsidian": {
      "command": "docker",
      "args": [
        "run",
        "-i",
        "--rm",
        "-v",
        "C:\\ABSOLUTE\\PATH\\TO\\obsidian-mcp.env:/app/.env",
        "ghcr.io/jmashburn/brainmcp:latest",
        "stdio"
      ]
    }
  }
}
```

---

## HTTP Mode

HTTP mode provides OAuth-secured remote access for ChatGPT, Claude web, and other remote MCP clients.

### Prerequisites

- Node.js 22+ and npm, OR Docker
- Configured `.env` file with core AND OAuth variables
- Public URL (optional, for remote access - use ngrok for testing)

### Local Deployment

Using npm:

```bash
# 1. Configure environment (including OAuth variables)
cp .env.example .env
# Edit .env

# 2. Start server
npm run dev:http
```

Server starts at `http://localhost:3000` by default.

Using Docker:

```bash
docker run -p 3000:3000 --rm \
  -v "/ABSOLUTE/PATH/TO/obsidian-mcp.env:/app/.env" \
  ghcr.io/jmashburn/brainmcp:latest \
  http
```

### Remote Access (ngrok)

For testing with ChatGPT or remote clients:

1. Start ngrok:

```bash
ngrok http 3000
```

2. Update BASE_URL:

```bash
# In your .env file:
BASE_URL=https://your-ngrok-url.ngrok.io
```

3. Restart server:

```bash
npm run dev:http
```

### OAuth Flow

HTTP mode uses OAuth 2.0 Authorization Code Flow with PKCE:

1. Register OAuth session:

```bash
POST /oauth/register
```

2. Authorize:

```
GET /oauth/authorize?client_id=...&redirect_uri=...&state=...&code_challenge=...
```

User logs in with `PERSONAL_AUTH_TOKEN`.

3. Exchange code for token:

```bash
POST /oauth/token
Content-Type: application/x-www-form-urlencoded

grant_type=authorization_code&code=...&client_id=...&redirect_uri=...&code_verifier=...
```

4. Access MCP endpoint:

```bash
POST /mcp
Authorization: Bearer <access_token>
```

### ChatGPT Integration

1. Start server in HTTP mode (local or remote)

2. In ChatGPT, go to Settings > MCP Servers

3. Add new server:

- Name: Obsidian MCP
- URL: Your server URL (e.g., `https://your-ngrok-url.ngrok.io` or Lambda Function URL)
- Authentication: OAuth 2.0

4. Complete OAuth flow with your PERSONAL_AUTH_TOKEN

5. Start chatting with your vault!

### Session Management

Local HTTP mode:

- Sessions stored in memory
- Lost on server restart
- Default expiry: 24 hours

Lambda mode:

- Sessions stored in DynamoDB
- Persist across Lambda invocations
- TTL-based expiration
- Default expiry: 24 hours

---

## AWS Lambda

Deploy to AWS Lambda for production remote access with DynamoDB session storage.

### Prerequisites

- AWS CLI configured with valid credentials
- AWS CDK installed: `npm install -g aws-cdk`
- Docker installed (for Lambda image build)
- Configured `.env` file with all variables (core + OAuth)

### Deployment Steps

1. Install dependencies:

```bash
npm install
```

2. Configure environment:

```bash
cp .env.example .env
# Edit .env and fill in all required variables including:
#   - VAULT_REPO, VAULT_BRANCH, GIT_TOKEN (git access)
#   - OAUTH_CLIENT_ID, OAUTH_CLIENT_SECRET, PERSONAL_AUTH_TOKEN (OAuth)
#   - JOURNAL_* variables (journal configuration)
```

3. Bootstrap CDK (first time only):

```bash
npx cdk bootstrap
```

4. Deploy to AWS:

```bash
npm run cdk:deploy
```

This will:

- Build Docker image for Lambda
- Create DynamoDB table for sessions
- Deploy Lambda function with Function URL
- Set up CloudWatch logs

5. Note the Function URL from deployment output:

```
Outputs:
ObsidianMcpStack.FunctionUrl = https://abc123.lambda-url.us-east-1.on.aws/
```

6. Update BASE_URL and redeploy:

```bash
# In .env:
BASE_URL=https://abc123.lambda-url.us-east-1.on.aws

# Redeploy:
npm run cdk:deploy
```

### What Gets Deployed

The CDK stack provisions:

Lambda Function:

- Runtime: Docker image (ARM64)
- Memory: 2GB
- Ephemeral storage: 10GB (for git cache in /tmp)
- Timeout: 60 seconds
- Function URL: Public HTTPS endpoint with CORS

DynamoDB Table:

- Session storage with TTL
- Removal policy: RETAIN (manual deletion required after stack destruction)

CloudWatch Logs:

- Log group with 1-week retention
- Automatic log streaming

### Monitoring

View logs:

```bash
aws logs tail /aws/lambda/ObsidianMcpFunction --follow
```

View DynamoDB sessions:

```bash
aws dynamodb scan --table-name ObsidianMcpSessions
```

### Cold Start Optimization

Lambda uses `/tmp/obsidian-vault` for git cache persistence:

- First invocation (cold): Clones vault (~5-10s depending on vault size)
- Subsequent invocations (warm): Reuses cached vault (~1-2s for git pull)

The cache persists across warm starts and is automatically cleaned after the first invocation.

### Updating Deployment

Update code or configuration:

```bash
npm run cdk:deploy
```

Update environment variables only:

```bash
# Edit .env
npm run cdk:deploy
```

### Cleanup

Destroy stack:

```bash
npm run cdk:destroy
```

**Note:** The DynamoDB session table uses RETAIN removal policy. Manually delete it from AWS Console if needed:

```bash
aws dynamodb delete-table --table-name ObsidianMcpSessions
```
