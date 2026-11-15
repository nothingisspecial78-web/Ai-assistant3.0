import 'dotenv/config';
import express, { type Request, type Response } from 'express';
import helmet from 'helmet';
import path from 'node:path';
import {
  createAssistantRuntime,
  mountAssistantRoutes,
  registerLocalExpressApp,
} from '../packages/server/src/index.ts';

let appInstance: express.Express | null = null;
let initPromise: Promise<express.Express> | null = null;

export async function getOrCreateVercelApp(): Promise<express.Express> {
  if (appInstance) return appInstance;
  if (!initPromise) {
    initPromise = (async () => {
      const app = express();
      app.set('trust proxy', 1);

      app.use(
        helmet({
          contentSecurityPolicy: false,
          crossOriginEmbedderPolicy: false,
        })
      );
      app.use(express.json({ limit: '10mb' }));

      // 1. Initialize and mount reusable AI Assistant Backend (Khazna)
      const profilesDir = path.resolve(process.cwd(), 'profiles');
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
        res.status(500).json({ error: 'Server Error', details: message });
      });

      appInstance = app;
      return app;
    })();
  }
  return initPromise;
}

export default async function handler(req: Request, res: Response) {
  try {
    const app = await getOrCreateVercelApp();
    return app(req, res);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({
      error: 'Failed to initialize serverless assistant runtime',
      details: message,
    });
  }
}
