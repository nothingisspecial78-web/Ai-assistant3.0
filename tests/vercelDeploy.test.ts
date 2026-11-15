import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import handler, { getOrCreateVercelApp } from '../api/index.ts';
import {
  registerLocalExpressApp,
  resolveAppBaseUrl,
} from '../packages/server/src/auth.ts';

async function listenOnEphemeralPort(app: import('express').Express) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', () => resolve());
    server.once('error', reject);
  });
  const port = (server.address() as AddressInfo).port;
  return { server, port };
}

describe('Vercel single-project full-stack deployment for Khazna', () => {
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
        { source: '/health', destination: '/api/index.ts?__route=health' },
        { source: '/api/(.*)', destination: '/api/index.ts?__route=$1' },
        { source: '/(.*)', destination: '/index.html' },
      ])
    );
  });

  it('2. api/index.ts mounts Khazna backend routes (/health, /api/profiles, /api/guide-step)', async () => {
    const app = await getOrCreateVercelApp();
    const { server, port } = await listenOnEphemeralPort(app);

    try {
      const [healthRes, profilesRes, guideRes] = await Promise.all([
        fetch(`http://127.0.0.1:${port}/health`),
        fetch(`http://127.0.0.1:${port}/api/profiles`),
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
      expect(guideRes.status).toBe(200);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('3. resolveAppBaseUrl handles standard internal base URLs', () => {
    expect(
      resolveAppBaseUrl('https://khazna.islahululoom.com/api', 3000, 'khazna-ledger', {})
    ).toBe('https://khazna.islahululoom.com/api');
  });

  it('4. handler cleanly routes Vercel requests with ?__route=... and returns CORS headers', async () => {
    // Test OPTIONS preflight
    let headers: Record<string, string> = {};
    let statusCode = 200;
    let ended = false;
    let body = '';

    const createMockRes = () => {
      headers = {};
      statusCode = 200;
      ended = false;
      body = '';
      const callbacks: Record<string, () => void> = {};

      const mockRes = {
        setHeader(k: string, v: string) {
          headers[k.toLowerCase()] = v;
          return mockRes;
        },
        status(code: number) {
          statusCode = code;
          return mockRes;
        },
        json(data: unknown) {
          body = JSON.stringify(data);
          mockRes.end();
          return mockRes;
        },
        end() {
          ended = true;
          callbacks['finish']?.();
          callbacks['close']?.();
          return mockRes;
        },
        on(event: string, cb: () => void) {
          callbacks[event] = cb;
          return mockRes;
        },
        headersSent: false,
      };
      return mockRes;
    };

    // 4a. OPTIONS request
    const optionsReq = {
      method: 'OPTIONS',
      url: '/api/index.ts?__route=guide-step',
      headers: { 'x-real-ip': '1.2.3.4' },
    };
    await handler(optionsReq as never, createMockRes() as never);
    expect(statusCode).toBe(204);
    expect(headers['access-control-allow-origin']).toBe('*');

    // 4b. GET /health with ?__route=health
    const healthReq = {
      method: 'GET',
      url: '/api/index.ts?__route=health',
      headers: { 'x-real-ip': '1.2.3.4' },
    };
    await handler(healthReq as never, createMockRes() as never);
    expect(statusCode).toBe(200);
    expect(body).toContain('"status":"ok"');
    expect(headers['access-control-allow-origin']).toBe('*');

    // 4c. GET /api/profiles with ?__route=profiles
    const profilesReq = {
      method: 'GET',
      url: '/api/index.ts?__route=profiles',
      headers: { 'x-real-ip': '1.2.3.4' },
    };
    await handler(profilesReq as never, createMockRes() as never);
    expect(statusCode).toBe(200);
    expect(body).toContain('khazna-ledger');
  });
});
