import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createCollegeFinanceApp, DEMO_FINANCE_TOKEN } from '../apps/demo-college-finance/server.ts';
import { createLibraryApp, DEMO_LIBRARY_TOKEN } from '../apps/second-demo-app/server.ts';
import { resolveAppBaseUrl, verifyUserToken } from '../packages/server/src/auth.ts';
import { loadConfig } from '../packages/server/src/config.ts';
import { ProfileRegistry } from '../packages/server/src/profiles/loader.ts';
import { getAssistantVercelApp } from '../packages/server/src/vercel.ts';

describe('Vercel multi-service configuration and runtime bindings', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('1. vercel.json defines valid services, bindings, and ordered rewrites', () => {
    const raw = fs.readFileSync(path.resolve(process.cwd(), 'vercel.json'), 'utf8');
    const cfg = JSON.parse(raw) as {
      services: Record<
        string,
        {
          root: string;
          framework?: string;
          runtime?: string;
          entrypoint?: string;
          bindings?: Array<{ type: string; service: string; format: string; env: string }>;
        }
      >;
      rewrites: Array<{ source: string; destination: { service: string } }>;
      [key: string]: unknown;
    };

    const forbiddenTopLevel = [
      'functions',
      'installCommand',
      'buildCommand',
      'devCommand',
      'ignoreCommand',
      'outputDirectory',
      'framework',
    ];
    for (const key of forbiddenTopLevel) {
      expect(cfg[key]).toBeUndefined();
    }

    expect(Object.keys(cfg.services)).toEqual(
      expect.arrayContaining(['app', 'assistant-api', 'demo-college-finance', 'second-demo-app'])
    );

    for (const [name, svc] of Object.entries(cfg.services)) {
      const rootDir = path.resolve(process.cwd(), svc.root);
      expect(fs.existsSync(rootDir), `service "${name}" root should exist: ${rootDir}`).toBe(true);
      if (svc.entrypoint) {
        const entryFile = path.resolve(rootDir, svc.entrypoint);
        expect(fs.existsSync(entryFile), `entrypoint should exist: ${entryFile}`).toBe(true);
      }
      if (svc.bindings) {
        for (const binding of svc.bindings) {
          expect(binding.type).toBe('service');
          expect(binding.format).toBe('url');
          expect(cfg.services[binding.service]).toBeDefined();
          expect(binding.env.length).toBeGreaterThan(0);
        }
      }
    }

    expect(cfg.rewrites.length).toBeGreaterThanOrEqual(4);
    const lastRewrite = cfg.rewrites[cfg.rewrites.length - 1];
    expect(lastRewrite.source).toBe('/(.*)');
    expect(lastRewrite.destination.service).toBe('app');

    const collegeIdx = cfg.rewrites.findIndex((r) => r.source.includes('/api/demo/college-finance'));
    const apiCatchIdx = cfg.rewrites.findIndex((r) => r.source === '/api/(.*)');
    expect(collegeIdx).toBeGreaterThanOrEqual(0);
    expect(apiCatchIdx).toBeGreaterThan(collegeIdx);
  });

  it('2. resolveAppBaseUrl prefers Vercel service binding env vars and falls back to 127.0.0.1 in single-port mode', () => {
    expect(
      resolveAppBaseUrl('http://localhost:3000/api/demo/college-finance', 3000, 'college-finance', {})
    ).toBe('http://127.0.0.1:3000/api/demo/college-finance');

    expect(
      resolveAppBaseUrl('http://localhost:3000/api/demo/college-finance', 3000, 'college-finance', {
        DEMO_COLLEGE_FINANCE_URL: 'https://demo-college-finance.internal/',
      })
    ).toBe('https://demo-college-finance.internal/api/demo/college-finance');

    expect(
      resolveAppBaseUrl('http://localhost:3000/api/demo/college-finance', 3000, 'khazna-ledger', {
        DEMO_COLLEGE_FINANCE_URL: 'http://127.0.0.1:4101',
      })
    ).toBe('http://127.0.0.1:4101/api/demo/college-finance');

    expect(
      resolveAppBaseUrl('http://localhost:3000/api/demo/second-demo', 3000, 'second-demo', {
        SECOND_DEMO_APP_URL: 'https://second-demo.internal',
      })
    ).toBe('https://second-demo.internal/api/demo/second-demo');
  });

async function listenOnEphemeralPort(app: import('express').Express) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', () => resolve());
    server.once('error', reject);
  });
  const port = (server.address() as AddressInfo).port;
  return { server, port };
}

  it('3. Standalone services serve prefixed and root routes and authenticate via runtime bindings', async () => {
    const { server: financeServer, port: financePort } = await listenOnEphemeralPort(
      createCollegeFinanceApp()
    );
    const { server: libraryServer, port: libraryPort } = await listenOnEphemeralPort(
      createLibraryApp()
    );

    try {
      process.env.DEMO_COLLEGE_FINANCE_URL = `http://127.0.0.1:${financePort}`;
      process.env.SECOND_DEMO_APP_URL = `http://127.0.0.1:${libraryPort}`;

      const [finPrefixed, finRoot, libPrefixed, libRoot] = await Promise.all([
        fetch(`http://127.0.0.1:${financePort}/api/demo/college-finance/students`, {
          headers: { Authorization: `Bearer ${DEMO_FINANCE_TOKEN}` },
        }),
        fetch(`http://127.0.0.1:${financePort}/students`, {
          headers: { Authorization: `Bearer ${DEMO_FINANCE_TOKEN}` },
        }),
        fetch(`http://127.0.0.1:${libraryPort}/api/demo/second-demo/books`, {
          headers: { Authorization: `Bearer ${DEMO_LIBRARY_TOKEN}` },
        }),
        fetch(`http://127.0.0.1:${libraryPort}/books`, {
          headers: { Authorization: `Bearer ${DEMO_LIBRARY_TOKEN}` },
        }),
      ]);

      expect(finPrefixed.status).toBe(200);
      expect(finRoot.status).toBe(200);
      expect(libPrefixed.status).toBe(200);
      expect(libRoot.status).toBe(200);

      const cfg = loadConfig();
      const registry = new ProfileRegistry();
      await registry.loadAll(cfg.profilesDir);

      const financeProfile = registry.getProfile('college-finance')!;
      const libraryProfile = registry.getProfile('second-demo')!;

      const verifiedFinance = await verifyUserToken({
        token: `Bearer ${DEMO_FINANCE_TOKEN}`,
        profile: financeProfile,
        cfg,
      });
      expect(verifiedFinance?.userId).toBe('bursar-01');

      const verifiedLibrary = await verifyUserToken({
        token: `Bearer ${DEMO_LIBRARY_TOKEN}`,
        profile: libraryProfile,
        cfg,
      });
      expect(verifiedLibrary?.userId).toBe('librarian-01');
    } finally {
      await Promise.all([
        new Promise<void>((resolve) => financeServer.close(() => resolve())),
        new Promise<void>((resolve) => libraryServer.close(() => resolve())),
      ]);
    }
  });

  it('4. Assistant Vercel entrypoint initializes cleanly and serves /health and /api/profiles', async () => {
    const app = await getAssistantVercelApp();
    const { server, port } = await listenOnEphemeralPort(app);
    try {
      const [healthRes, profilesRes] = await Promise.all([
        fetch(`http://127.0.0.1:${port}/health`),
        fetch(`http://127.0.0.1:${port}/api/profiles`),
      ]);
      expect(healthRes.status).toBe(200);
      expect(profilesRes.status).toBe(200);
      const healthJson = (await healthRes.json()) as { status: string; profiles: unknown[] };
      const profilesJson = (await profilesRes.json()) as { profiles: unknown[] };
      expect(healthJson.status).toBe('ok');
      expect(profilesJson.profiles.length).toBeGreaterThanOrEqual(3);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
