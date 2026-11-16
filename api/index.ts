import 'dotenv/config';
import express, { type Request, type Response } from 'express';
import helmet from 'helmet';
import fs from 'node:fs';
import path from 'node:path';
import {
  createAssistantRuntime,
  mountAssistantRoutes,
  registerLocalExpressApp,
} from '../packages/server/src/index.ts';

let appInstance: express.Express | null = null;
let initPromise: Promise<express.Express> | null = null;

function resolveProfilesDir(): string {
  if (process.env.PROFILES_DIR && fs.existsSync(process.env.PROFILES_DIR)) {
    return path.resolve(process.cwd(), process.env.PROFILES_DIR);
  }
  const metaDir = typeof import.meta.dirname === 'string' ? import.meta.dirname : null;
  const candidates = [
    path.resolve(process.cwd(), 'profiles'),
    metaDir ? path.resolve(metaDir, '../profiles') : null,
    metaDir ? path.resolve(metaDir, 'profiles') : null,
    path.resolve('/var/task/profiles'),
  ].filter((p): p is string => Boolean(p));

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return candidates[0] || path.resolve(process.cwd(), 'profiles');
}

export async function getOrCreateVercelApp(): Promise<express.Express> {
  if (appInstance) return appInstance;
  if (!initPromise) {
    initPromise = (async () => {
      const app = express();
      app.set('trust proxy', 1);
      app.use(express.json({ limit: '10mb' }));

      // 1. Initialize and mount reusable AI Assistant Backend (Khazna)
      const profilesDir = resolveProfilesDir();
      const runtime = await createAssistantRuntime({
        port: Number(process.env.PORT || 3000),
        profilesDir,
      });
      mountAssistantRoutes(app, runtime);

      // 2. Register in-process dispatcher so /me & tool calls never hit ECONNREFUSED on localhost:3000 in serverless
      registerLocalExpressApp(app);

      // 3. Fallback error handler
      app.use((err: unknown, _req: Request, res: Response, _next: express.NextFunction) => {
        const message = err instanceof Error ? err.message : 'Internal Server Error';
        if (!res.headersSent) {
          res.status(500).json({ error: 'Server Error', details: message });
        }
      });

      appInstance = app;
      return app;
    })().catch((err) => {
      initPromise = null;
      throw err;
    });
  }
  return initPromise;
}

export default async function handler(req: Request, res: Response) {
  // Ensure req.socket is present for serverless environments
  if (!req.socket) {
    (req as unknown as { socket: { remoteAddress: string } }).socket = {
      remoteAddress:
        (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
        (req.headers['x-real-ip'] as string) ||
        '127.0.0.1',
    };
  }

  // Top-level CORS headers for all Vercel responses
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, x-app-id, x-requested-with, accept, origin'
  );

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  // Parse incoming URL and reconstruct original route if rewritten by Vercel
  const rawUrl = req.url || '/';
  const urlObj = new URL(rawUrl, 'http://localhost');
  const routeParam = urlObj.searchParams.get('__route');

  if (routeParam) {
    // 1. Explicit Vercel rewrite parameter (?__route=...)
    urlObj.searchParams.delete('__route');
    const cleanRoute = routeParam.startsWith('/') ? routeParam : `/${routeParam}`;
    const prefix = cleanRoute === '/health' || cleanRoute.startsWith('/api') ? '' : '/api';
    const qs = urlObj.searchParams.toString();
    req.url = `${prefix}${cleanRoute}${qs ? `?${qs}` : ''}`;
  } else {
    // 2. Fallback to original URL headers (ignoring destination handler filenames)
    const isHandlerPath = (p?: string) =>
      !p ||
      /^\/api\/index(?:\.ts|\.js)?(?:\/|\?|$)/i.test(p) ||
      p === '/api' ||
      p === '/api/' ||
      p === '/';

    const candidate =
      (req.headers['x-forwarded-uri'] as string) ||
      (req.headers['x-original-url'] as string) ||
      (req.headers['x-now-route-matches'] as string) ||
      (req.headers['x-matched-path'] as string);

    if (isHandlerPath(req.url) && candidate && !isHandlerPath(candidate)) {
      const candObj = new URL(candidate, 'http://localhost');
      req.url = candObj.pathname + (urlObj.search || candObj.search || '');
    }
  }

  try {
    const app = await getOrCreateVercelApp();
    return await new Promise<void>((resolve, reject) => {
      res.on('finish', () => resolve());
      res.on('close', () => resolve());
      res.on('error', (err) => reject(err));
      app(req, res, (err?: unknown) => {
        if (err) {
          reject(err);
        } else if (!res.headersSent) {
          res.status(404).json({
            error: 'Not Found',
            url: req.url,
            originalUrl: rawUrl,
          });
          resolve();
        } else {
          resolve();
        }
      });
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (!res.headersSent) {
      res.status(500).json({
        error: 'Failed to process serverless assistant request',
        details: message,
      });
    }
  }
}
