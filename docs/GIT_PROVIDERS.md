# Git Provider Setup

Complete setup instructions for all supported git providers. The server automatically detects your provider from the repository URL and uses the appropriate authentication method.

## Table of Contents

- [Overview](#overview)
- [GitHub](#github)
- [GitLab](#gitlab)
- [Bitbucket](#bitbucket)
- [Self-Hosted / Generic](#self-hosted--generic)
- [Authentication Formats](#authentication-formats)
- [Troubleshooting](#troubleshooting)

## Overview

The Obsidian MCP Server supports these git providers:

| Provider    | Token Type            | Auto-Detected | Setup Complexity |
| ----------- | --------------------- | ------------- | ---------------- |
| GitHub      | Personal Access Token | Yes           | Easy             |
| GitLab      | Personal Access Token | Yes           | Easy             |
| Bitbucket   | App Password          | Yes           | Easy             |
| Self-Hosted | Token/Password        | Yes           | Medium           |

**Required Environment Variables:**

- `VAULT_REPO` - Your repository URL
- `VAULT_BRANCH` - Branch name (typically "main" or "master")
- `GIT_TOKEN` - Your access token or password
- `GIT_USERNAME` - Username (required for self-hosted/generic providers only)

---

## GitHub

GitHub is the most common git provider with straightforward token setup.

### Prerequisites

- GitHub account
- Repository with your Obsidian vault

### Setup Steps

**1. Create a Personal Access Token:**

Go to [GitHub Settings → Developer Settings → Personal Access Tokens](https://github.com/settings/tokens)

**For classic tokens:**

- Click "Generate new token (classic)"
- Give it a descriptive name (e.g., "Obsidian MCP Server")
- Select scopes:
  - ✅ `repo` (Full control of private repositories)
- Click "Generate token"
- Copy the token (you won't see it again!)

**For fine-grained tokens (recommended):**

- Click "Generate new token"
- Give it a name and expiration
- Select "Only select repositories" → Choose your vault repository
- Set permissions:
  - ✅ Contents: Read and write
  - ✅ Metadata: Read-only (automatically included)
- Click "Generate token"
- Copy the token

**2. Configure environment variables:**

```bash
# In your .env file:
VAULT_REPO=https://github.com/username/vault-repo.git
VAULT_BRANCH=main
GIT_TOKEN=ghp_YourPersonalAccessTokenHere
```

### Repository URL Format

```
https://github.com/username/repository.git
https://github.com/username/repository  # .git suffix optional
```

### Authentication Format

The server automatically formats GitHub URLs as:

```
https://x-access-token:TOKEN@github.com/username/repository.git
```

### Token Permissions

**Minimum required:**

- `repo` scope (classic token)
- OR Contents: Read and write (fine-grained token)

**Recommended expiration:**

- 90 days (rotate regularly)
- No expiration (for production, rotate manually)

---

## GitLab

GitLab supports both gitlab.com and self-hosted instances.

### Prerequisites

- GitLab account (gitlab.com or self-hosted)
- Repository with your Obsidian vault

### Setup Steps

**1. Create a Personal Access Token:**

Go to [GitLab Settings → Access Tokens](https://gitlab.com/-/profile/personal_access_tokens)

**For gitlab.com:**

- Name: "Obsidian MCP Server"
- Expiration date: Choose based on your security policy
- Select scopes:
  - ✅ `api` (Complete read/write access to the API)
  - Note: `api` includes repository access
- Click "Create personal access token"
- Copy the token immediately (you won't see it again!)

**For self-hosted GitLab:**

- Same process as above
- Use your self-hosted GitLab URL

**2. Configure environment variables:**

```bash
# For gitlab.com:
VAULT_REPO=https://gitlab.com/username/vault-repo.git
VAULT_BRANCH=main
GIT_TOKEN=glpat-YourPersonalAccessTokenHere

# For self-hosted GitLab:
VAULT_REPO=https://gitlab.company.com/username/vault-repo.git
VAULT_BRANCH=main
GIT_TOKEN=glpat-YourPersonalAccessTokenHere
```

### Repository URL Format

```
https://gitlab.com/username/repository.git
https://gitlab.com/group/subgroup/repository.git
https://gitlab.company.com/username/repository.git  # Self-hosted
```

### Authentication Format

The server automatically formats GitLab URLs as:

```
https://oauth2:TOKEN@gitlab.com/username/repository.git
```

### Token Permissions

**Required scope:**

- `api` - Complete read/write access

**Alternative (more restrictive):**

- `read_repository` + `write_repository` (if available in your GitLab version)

### Self-Hosted GitLab

**Automatic detection:**

- Server detects "gitlab" in hostname
- Uses OAuth2 authentication format
- No additional configuration needed

**Example:**

```bash
VAULT_REPO=https://gitlab.mycompany.com/team/vault.git
GIT_TOKEN=glpat-xyz123
# No GIT_USERNAME needed - auto-detected as GitLab (access tokens authenticate as oauth2)
# Using a deploy token instead? It only works with its own username:
# GIT_USERNAME=gitlab+deploy-token-42
```

---

## Bitbucket

Bitbucket uses App Passwords instead of Personal Access Tokens.

### Prerequisites

- Bitbucket account
- Repository with your Obsidian vault

### Setup Steps

**1. Create an App Password:**

Go to [Bitbucket Settings → Personal Settings → App passwords](https://bitbucket.org/account/settings/app-passwords/)

- Click "Create app password"
- Label: "Obsidian MCP Server"
- Permissions:
  - ✅ Repositories: Read
  - ✅ Repositories: Write
- Click "Create"
- Copy the password immediately (you won't see it again!)

**2. Configure environment variables:**

```bash
VAULT_REPO=https://bitbucket.org/username/vault-repo.git
VAULT_BRANCH=main
GIT_TOKEN=YourAppPasswordHere
```

### Repository URL Format

```
https://bitbucket.org/username/repository.git
https://bitbucket.org/workspace/repository.git
```

### Authentication Format

The server automatically formats Bitbucket URLs as:

```
https://x-token-auth:TOKEN@bitbucket.org/username/repository.git
```

### App Password Permissions

**Minimum required:**

- Repositories: Read
- Repositories: Write

**Optional (for additional functionality):**

- Pull requests: Read/Write (if you plan to automate PRs)

---

## Self-Hosted / Generic

For Gitea, Gogs, custom git servers, or any provider not listed above.

### Prerequisites

- Access to a git server
- Repository with your Obsidian vault
- Personal access token or password

### Setup Steps

**1. Create a token on your git server**

The process varies by provider. Common self-hosted git providers:

**Gitea:**

- Go to Settings → Applications → Generate New Token
- Give it a name
- Select scopes: `repo` or `write:repository`

**Gogs:**

- Go to Settings → Applications → Generate New Token
- Give it a name (no scopes needed)

**Generic Git Server:**

- Use your account password
- Or create an application-specific password if supported

**2. Configure environment variables:**

```bash
VAULT_REPO=https://git.mycompany.com/username/vault-repo.git
VAULT_BRANCH=main
GIT_TOKEN=YourTokenOrPasswordHere
GIT_USERNAME=your_username  # Required for generic providers!
```

### Important: GIT_USERNAME Required

For self-hosted/generic providers, you MUST set `GIT_USERNAME`:

```bash
GIT_USERNAME=your_username
```

This is used for basic authentication when the provider cannot be auto-detected.

### Repository URL Format

```
https://git.example.com/username/repository.git
https://git.example.com/group/repository.git
http://192.168.1.100:3000/repo.git  # Local network
```

### Authentication Format

The server uses basic authentication for generic providers:

```
https://USERNAME:TOKEN@git.example.com/username/repository.git
```

### Provider Detection

The server tries to detect specific providers by hostname:

| Hostname Contains | Detected Provider | Auth Format          |
| ----------------- | ----------------- | -------------------- |
| `github.com`      | GitHub            | `x-access-token`     |
| `gitlab`          | GitLab            | `oauth2`             |
| `bitbucket.org`   | Bitbucket         | `x-token-auth`       |
| Other             | Generic           | Basic (username:pwd) |

---

## Authentication Formats

How the server formats authenticated URLs for each provider:

### GitHub

```
https://x-access-token:TOKEN@github.com/user/repo.git
```

### GitLab (including self-hosted)

```
https://oauth2:TOKEN@gitlab.com/user/repo.git
https://oauth2:TOKEN@gitlab.company.com/user/repo.git
```

### Bitbucket

```
https://x-token-auth:TOKEN@bitbucket.org/user/repo.git
```

### Generic / Self-Hosted

```
https://USERNAME:TOKEN@git.example.com/user/repo.git
```

**Note:** The server automatically formats URLs. You only need to provide:

- Plain repository URL in `VAULT_REPO`
- Token in `GIT_TOKEN`
- Username in `GIT_USERNAME` (generic only)
