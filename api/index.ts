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
  const candidates = [
    path.resolve(process.cwd(), 'profiles'),
    path.resolve(import.meta.dirname, '../profiles'),
    path.resolve(import.meta.dirname, 'profiles'),
    path.resolve('/var/task/profiles'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return candidates[0];
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
    })();
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

  // If Vercel rewrote the request to /api/index.ts, reconstruct original route from Vercel headers
  const matchedPath =
    (req.headers['x-matched-path'] as string) ||
    (req.headers['x-forwarded-uri'] as string) ||
    (req.headers['x-original-url'] as string);

  if (matchedPath && (req.url === '/api/index.ts' || req.url.startsWith('/api/index.ts?'))) {
    const urlObj = new URL(req.url, 'http://localhost');
    const matchedObj = new URL(matchedPath, 'http://localhost');
    req.url = matchedObj.pathname + (urlObj.search || matchedObj.search || '');
  }

  try {
    const app = await getOrCreateVercelApp();
    return await new Promise<void>((resolve, reject) => {
      res.on('finish', () => resolve());
      res.on('close', () => resolve());
      res.on('error', (err) => reject(err));
      app(req, res, (err?: unknown) => {
        if (err) reject(err);
        else resolve();
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
