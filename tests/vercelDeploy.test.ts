import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getOrCreateVercelApp } from '../api/index.ts';
import { DEMO_FINANCE_TOKEN } from '../apps/demo-college-finance/server.ts';
import { DEMO_LIBRARY_TOKEN } from '../apps/second-demo-app/server.ts';
import {
  registerLocalExpressApp,
  resolveAppBaseUrl,
  verifyUserToken,
} from '../packages/server/src/auth.ts';
import { loadConfig } from '../packages/server/src/config.ts';
import { ProfileRegistry } from '../packages/server/src/profiles/loader.ts';

async function listenOnEphemeralPort(app: import('express').Express) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', () => resolve());
    server.once('error', reject);
  });
  const port = (server.address() as AddressInfo).port;
  return { server, port };
}

describe('Vercel single-project full-stack deployment & in-process assistant dispatch', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    registerLocalExpressApp(null);
  });

  it('1. vercel.json configures unified single-project Vite + /api/index.ts deployment without splitting into services', () => {
    const raw = fs.readFileSync(path.resolve(process.cwd(), 'vercel.json'), 'utf8');
    const cfg = JSON.parse(raw) as {
      services?: unknown;
      buildCommand: string;
      outputDirectory: string;
      functions: Record<string, { includeFiles?: string; maxDuration?: number }>;
      rewrites: Array<{ source: string; destination: string }>;
    };

    expect(cfg.services).toBeUndefined();
    expect(cfg.buildCommand).toBe('npm run build');
    expect(cfg.outputDirectory).toBe('dist');
    expect(cfg.functions['api/index.ts']?.includeFiles).toContain('profiles');
    expect(cfg.functions['api/index.ts']?.includeFiles).toContain('data');
    expect(fs.existsSync(path.resolve(process.cwd(), 'api/index.ts'))).toBe(true);

    expect(cfg.rewrites).toEqual(
      expect.arrayContaining([
        { source: '/health', destination: '/api/index.ts' },
        { source: '/api/(.*)', destination: '/api/index.ts' },
        { source: '/(.*)', destination: '/index.html' },
      ])
    );
  });

  it('2. api/index.ts mounts all features (/health, /api/profiles, /api/guide-step, /api/demo/*) and dispatches /me in-process without TCP port 3000', async () => {
    const app = await getOrCreateVercelApp();
    const { server, port } = await listenOnEphemeralPort(app);

    try {
      const [healthRes, profilesRes, financeRes, libraryRes, guideRes] = await Promise.all([
        fetch(`http://127.0.0.1:${port}/health`),
        fetch(`http://127.0.0.1:${port}/api/profiles`),
        fetch(`http://127.0.0.1:${port}/api/demo/college-finance/students`, {
          headers: { Authorization: `Bearer ${DEMO_FINANCE_TOKEN}` },
        }),
        fetch(`http://127.0.0.1:${port}/api/demo/second-demo/books`, {
          headers: { Authorization: `Bearer ${DEMO_LIBRARY_TOKEN}` },
        }),
        fetch(`http://127.0.0.1:${port}/api/guide-step`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            goal: 'show me where to login',
            previousStepSummary: '',
            currentRoute: '/',
            stepNumber: 1,
            pageMap: [
              {
                id: 'login-btn',
                tag: 'button',
                type: 'button',
                label: 'Sign In',
                currentRoute: '/',
                hasValue: false,
              },
            ],
          }),
        }),
      ]);

      expect(healthRes.status).toBe(200);
      expect(profilesRes.status).toBe(200);
      expect(financeRes.status).toBe(200);
      expect(libraryRes.status).toBe(200);
      expect(guideRes.status).toBe(200);

      // Verify in-process /me auth check resolves even when cfg.port (unused port 59999) is NOT listening
      const cfg = loadConfig({ port: 59999 });
      const registry = new ProfileRegistry();
      await registry.loadAll(cfg.profilesDir);

      const financeUser = await verifyUserToken({
        token: `Bearer ${DEMO_FINANCE_TOKEN}`,
        profile: registry.getProfile('college-finance')!,
        cfg,
      });
      expect(financeUser?.userId).toBe('bursar-01');

      const libraryUser = await verifyUserToken({
        token: `Bearer ${DEMO_LIBRARY_TOKEN}`,
        profile: registry.getProfile('second-demo')!,
        cfg,
      });
      expect(libraryUser?.userId).toBe('librarian-01');

      // Also verify an authenticated /api/chat tool read call runs cleanly in-process against port 59999 fallback
      const chatRes = await fetch(`http://127.0.0.1:${port}/api/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${DEMO_FINANCE_TOKEN}`,
        },
        body: JSON.stringify({
          appId: 'college-finance',
          messages: [{ role: 'user', content: 'how many students are enrolled?' }],
        }),
      });
      expect(chatRes.status).toBe(200);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('3. resolveAppBaseUrl preserves external/bound URL compatibility for standalone AI assistant integration', () => {
    expect(
      resolveAppBaseUrl('https://external-app.example.com/api', 3000, 'external-app', {})
    ).toBe('https://external-app.example.com/api');

    expect(
      resolveAppBaseUrl('http://localhost:3000/api/demo/college-finance', 3000, 'college-finance', {
        DEMO_COLLEGE_FINANCE_URL: 'https://demo-college-finance.internal/',
      })
    ).toBe('https://demo-college-finance.internal/api/demo/college-finance');
  });
});
