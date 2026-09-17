# BrainMCP Helm chart

Installs the BrainMCP HTTP server (OAuth 2.0 + PKCE) on Kubernetes or OpenShift.

The server keeps **its own clone** of the vault and commits and pushes every
write. It only ever sees what has been pushed to the vault's remote, and the
clone is disposable — it lives in an `emptyDir` and is re-created when the pod
restarts. Never point it at a working copy that someone edits.

## Prerequisites

- Helm 3.8+, Kubernetes 1.25+ (or OpenShift 4.12+)
- A vault in a git repository reachable over **HTTPS** (SSH is not supported)
- A token that can push to the vault's branch
- A hostname for the server. `server.baseUrl` is the OAuth issuer, so it must
  be the URL clients actually use.

## Install

Create the secret yourself so the credentials stay out of the Helm release
record:

```bash
kubectl create namespace brain
kubectl -n brain create secret generic brainmcp-secrets \
  --from-literal=GIT_TOKEN="$GIT_TOKEN" \
  --from-literal=OAUTH_CLIENT_SECRET="$(openssl rand -hex 32)" \
  --from-literal=PERSONAL_AUTH_TOKEN="$(openssl rand -hex 32)"
```

`PERSONAL_AUTH_TOKEN` is what a person types on the login page, so keep a copy
somewhere you can read it back. Add `MCP_STATIC_BEARER_TOKENS` (comma-separated)
for clients that can only send a fixed `Authorization: Bearer` header. Anyone
holding either has the whole vault.

For clients that should only ever read, add `PERSONAL_AUTH_TOKEN_RO` (a second
login token) and/or `MCP_STATIC_BEARER_TOKENS_RO` to the same secret. A client
authenticated with one is never offered a tool that changes the vault, and the
vault it is given refuses writes. Use different values from the read-write
ones: a token present at both levels is treated as read-only.

OpenShift:

```bash
helm install brainmcp ./brainmcp-chart -n brain \
  -f brainmcp-chart/values-openshift.yaml \
  --set vault.repo=https://git.example.com/me/vault.git \
  --set server.baseUrl=https://brainmcp.apps.example.com \
  --set route.host=brainmcp.apps.example.com \
  --set secrets.existingSecret=brainmcp-secrets
```

Plain Kubernetes:

```bash
helm install brainmcp ./brainmcp-chart -n brain \
  -f brainmcp-chart/values-k8s.yaml \
  --set vault.repo=https://git.example.com/me/vault.git \
  --set server.baseUrl=https://brainmcp.example.com \
  --set ingress.host=brainmcp.example.com \
  --set secrets.existingSecret=brainmcp-secrets
```

Give clients `<baseUrl>/mcp`, not the site root.

### Adding a read-only token later

```bash
kubectl -n brain patch secret brainmcp-secrets --type=merge \
  -p "{\"stringData\":{\"PERSONAL_AUTH_TOKEN_RO\":\"$(openssl rand -hex 32)\"}}"
kubectl -n brain rollout restart deploy/brainmcp

# read it back when you need to type it on the login page
kubectl -n brain get secret brainmcp-secrets -o jsonpath='{.data.PERSONAL_AUTH_TOKEN_RO}' | base64 -d
```

The restart is required — environment is read at startup, and a change to a
secret you manage yourself does not roll the pod. It also signs every OAuth
client out once. The startup log confirms the result with
`"loginRead":true`.

## Verify

```bash
kubectl -n brain rollout status deploy/brainmcp
kubectl -n brain logs deploy/brainmcp | grep -E 'hooks|protection'
curl -s -o /dev/null -w '%{http_code}\n' https://brainmcp.example.com/health     # 200
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://brainmcp.example.com/mcp # 401
```

A `401` on the unauthenticated POST is the server answering. A `404` means the
URL is wrong; a `403` usually means a proxy in front of it refused the client.

## Self-hosted git remotes

| Situation                                                                       | Setting                                                                 |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Host is not `github.com`/`bitbucket.org` and its name does not contain `gitlab` | `git.username` — use `oauth2` for a GitLab access token                 |
| Remote rejects commits from unknown authors                                     | `git.authorName`, `git.authorEmail`                                     |
| Certificate signed by a private CA                                              | `git.caBundle.existingConfigMap` (and `git.caBundle.key`)               |
| Vault has a `.gitlab-ci.yml` clients must not rewrite                           | `vault.protectedPaths` — it **replaces** the defaults, so list them all |

```bash
kubectl -n brain create configmap corp-ca --from-file=ca.crt=/path/to/corp-ca.pem
helm upgrade brainmcp ./brainmcp-chart -n brain --reuse-values \
  --set git.caBundle.existingConfigMap=corp-ca
```

## Values worth knowing

| Value                                                                     | Default      | Notes                                                                              |
| ------------------------------------------------------------------------- | ------------ | ---------------------------------------------------------------------------------- |
| `vault.repo`                                                              | —            | **Required.** HTTPS URL, no credentials in it                                      |
| `server.baseUrl`                                                          | —            | **Required.** External URL; OAuth issuer                                           |
| `secrets.existingSecret`                                                  | `""`         | Preferred over the inline `secrets.*` values                                       |
| `secrets.personalAuthTokenReadOnly`, `secrets.staticBearerTokensReadOnly` | `""`         | Optional read-only credentials                                                     |
| `image.tag`                                                               | `latest`     | Pin a `main-<sha>` tag for reproducible installs                                   |
| `vault.hooksPath`                                                         | `.githooks`  | The vault's own pre-commit runs on the server's writes. Applied at clone time only |
| `vault.guidanceFiles`                                                     | Brain layout | Served as a resource and write-protected                                           |
| `server.exposedTools`                                                     | `""` (all)   | Allowlist; omitted tools disappear from `tools/list`                               |
| `conventions.*`                                                           | Brain layout | Inbox, tasks, templates and journal locations                                      |
| `replicaCount`                                                            | `1`          | More than 1 is refused: sessions live in memory                                    |
| `podSecurityContext`                                                      | `{}`         | Auto: nothing on OpenShift, UID/fsGroup `10001` elsewhere                          |
| `extraEnv`, `extraVolumes`, `extraVolumeMounts`                           | `[]`         | e.g. `https_proxy`                                                                 |

See [`values.yaml`](values.yaml) for the full list.

## Operations

- **Upgrade:** `helm upgrade brainmcp ./brainmcp-chart -n brain --reuse-values --set image.tag=main-<sha>`.
  Every push to `main` publishes that tag, and the Release workflow's run summary prints the
  command. Name the tag rather than relying on `latest`: an upgrade with unchanged values rolls
  nothing, so a new `latest` would not be pulled.
  Configuration changes roll the pod automatically; a change to an
  `existingSecret` does not — `kubectl -n brain rollout restart deploy/brainmcp`.
- **Restarts log everyone out.** Sessions and OAuth state are in memory.
- **Token rotation:** update the secret, then restart the deployment. An expired
  git token shows up as repeated re-clone attempts in the log.
- **Uninstall:** `helm uninstall brainmcp -n brain`. The vault is untouched; a
  secret you created yourself is not removed.
