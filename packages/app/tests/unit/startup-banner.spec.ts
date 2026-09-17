import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { startupBanner } from '@/server/local/startup-banner';

const INFO = {
  baseUrl: 'https://brain.example.com',
  vaultPath: '/app/vaults/vault-local',
  clientId: 'brain-mcp-client',
};

describe('startupBanner', () => {
  it('shows where the server is and which client id to configure', () => {
    const banner = startupBanner(INFO);

    expect(banner).toContain('https://brain.example.com/mcp');
    expect(banner).toContain('Client ID: brain-mcp-client');
  });

  it('tells the operator where the client secret is, instead of printing it', () => {
    expect(startupBanner(INFO)).toContain('Client Secret: (not printed');
  });

  // The banner goes to stdout, which is the log sink. It once interpolated
  // OAUTH_CLIENT_SECRET, which put the credential in every log aggregator
  // downstream. Hold the line in the source, not only in the output: a value
  // that is never read cannot be printed.
  it('never reads a credential from the environment', () => {
    const source = readFileSync(
      path.resolve(__dirname, '../../src/server/local/startup-banner.ts'),
      'utf8',
    );

    expect(source).not.toMatch(/process\.env/);
    expect(source).not.toMatch(/\$\{[^}]*(SECRET|TOKEN|PASSWORD)[^}]*\}/i);
  });

  it('is not handed a secret by the server that prints it', () => {
    const source = readFileSync(path.resolve(__dirname, '../../src/server/local/http.ts'), 'utf8');
    const call = source.slice(
      source.indexOf('startupBanner('),
      source.indexOf('startupBanner(') + 200,
    );

    expect(call).not.toMatch(/SECRET|TOKEN|PASSWORD/i);
  });
});
