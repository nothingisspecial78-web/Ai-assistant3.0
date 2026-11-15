import { GoogleGenAI } from '@google/genai';
import { Router, type Request, type Response } from 'express';
import {
  buildDeterministicGuideStep,
  detectAmbiguousGuidePaths,
  GUIDE_SYSTEM_PROMPT,
  GuideStepRequestSchema,
  MAX_GUIDE_STEPS,
  OPENROUTER_GUIDE_MODELS,
  sanitizeGuideStepDecision,
  type AvailableRouteHint,
  type GuideStepResponse,
  type PageMapElement,
} from '@ai-assistant/core';
import { logger, type ServerConfig } from '../config.ts';

export interface GuideStepRouteDeps {
  cfg: Pick<ServerConfig, 'openRouterApiKey' | 'llmTimeoutMs'> &
    Partial<Pick<ServerConfig, 'geminiApiKey' | 'groqApiKey'>>;
  fetchImpl?: typeof fetch;
}

export interface OpenRouterGuidePayload {
  models: string[];
  route: 'fallback';
  response_format: { type: 'json_object' };
  temperature: number;
  max_tokens: number;
  messages: Array<{ role: 'system' | 'user'; content: string }>;
}

export function parseGuideJsonResponse(rawText: string): Record<string, unknown> | null {
  const trimmed = rawText.trim();
  if (!trimmed) return null;

  const withoutFence = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  try {
    const parsed = JSON.parse(withoutFence);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    const firstBrace = withoutFence.indexOf('{');
    const lastBrace = withoutFence.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      try {
        const sliced = JSON.parse(withoutFence.slice(firstBrace, lastBrace + 1));
        return sliced && typeof sliced === 'object' && !Array.isArray(sliced)
          ? (sliced as Record<string, unknown>)
          : null;
      } catch {
        return null;
      }
    }
    return null;
  }
}

function buildCompactGuideUserJson(params: {
  goal: string;
  previousStepSummary: string;
  currentRoute: string;
  stepNumber: number;
  pageMap: PageMapElement[];
  confirmedPath?: boolean;
  preferredTargetId?: string;
  preferredRoute?: string;
  availableRoutes?: AvailableRouteHint[];
  appContext?: string;
}): string {
  const compactElements = params.pageMap.slice(0, 60).map((el) => ({
    id: el.id,
    tag: el.tag,
    type: el.type,
    label: el.label,
    hasValue: el.hasValue,
    ...(el.sensitive ? { sensitive: true } : {}),
  }));

  const userPayload: Record<string, unknown> = {
    goal: params.goal,
    route: params.currentRoute,
    step: params.stepNumber,
    prev: params.previousStepSummary,
    pageMap: compactElements,
  };

  if (typeof params.confirmedPath === 'boolean') {
    userPayload.confirmedPath = params.confirmedPath;
  }
  if (params.preferredTargetId) {
    userPayload.preferredTargetId = params.preferredTargetId;
  }
  if (params.preferredRoute) {
    userPayload.preferredRoute = params.preferredRoute;
  }
  if (params.availableRoutes && params.availableRoutes.length > 0) {
    userPayload.routes = params.availableRoutes.slice(0, 25);
  }
  if (params.appContext) {
    userPayload.ctx = params.appContext.slice(0, 240);
  }

  return JSON.stringify(userPayload);
}

/**
 * Builds the token-minimized OpenRouter chat completions payload.
 * Sends ONLY compact pageMap JSON, goal, route, stepNumber, previousStepSummary,
 * and (on unconfirmed step 1) compact route/app hints for dynamic disambiguation.
 */
export function buildOpenRouterGuidePayload(params: {
  goal: string;
  previousStepSummary: string;
  currentRoute: string;
  stepNumber: number;
  pageMap: PageMapElement[];
  confirmedPath?: boolean;
  preferredTargetId?: string;
  preferredRoute?: string;
  availableRoutes?: AvailableRouteHint[];
  appContext?: string;
}): OpenRouterGuidePayload {
  return {
    models: [...OPENROUTER_GUIDE_MODELS],
    route: 'fallback',
    response_format: { type: 'json_object' },
    temperature: 0.1,
    max_tokens: params.stepNumber === 1 && !params.confirmedPath ? 360 : 180,
    messages: [
      { role: 'system', content: GUIDE_SYSTEM_PROMPT },
      {
        role: 'user',
        content: buildCompactGuideUserJson(params),
      },
    ],
  };
}

export async function resolveGuideStepDecision(params: {
  goal: string;
  previousStepSummary: string;
  currentRoute: string;
  stepNumber: number;
  pageMap: PageMapElement[];
  confirmedPath?: boolean;
  preferredTargetId?: string;
  preferredRoute?: string;
  availableRoutes?: AvailableRouteHint[];
  appContext?: string;
  openRouterApiKey?: string;
  geminiApiKey?: string;
  groqApiKey?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<GuideStepResponse> {
  const {
    goal,
    previousStepSummary,
    currentRoute,
    stepNumber,
    pageMap,
    confirmedPath = false,
    preferredTargetId,
    preferredRoute,
    availableRoutes = [],
    appContext,
    openRouterApiKey = '',
    geminiApiKey = '',
    groqApiKey = '',
    timeoutMs = 12000,
    fetchImpl = fetch,
  } = params;

  // Hard 10-step limit enforced before any LLM call
  if (stepNumber > MAX_GUIDE_STEPS) {
    return sanitizeGuideStepDecision({ action: 'complete' }, pageMap, stepNumber);
  }

  const allowClarify = stepNumber === 1 && !confirmedPath;
  const localClarify = allowClarify
    ? detectAmbiguousGuidePaths({
        goal,
        pageMap,
        currentRoute,
        availableRoutes,
        appContext,
        confirmedPath,
        stepNumber,
      })
    : null;

  const finalizeParsedDecision = (
    parsed: Record<string, unknown>,
    providerName: string
  ): GuideStepResponse => {
    const safe = sanitizeGuideStepDecision(parsed, pageMap, stepNumber, {
      allowClarify,
      availableRoutes,
      currentRoute,
    });

    // If the LLM guessed a single action on a clearly ambiguous Step 1 DOM/route cluster,
    // enforce clarifying prompt cleanly; otherwise preserve the LLM's clarify or action decision.
    if (allowClarify && safe.action !== 'clarify' && localClarify) {
      return {
        ...localClarify,
        provider: providerName,
      };
    }

    return {
      ...safe,
      provider: providerName,
    };
  };

  // 1. Primary OpenRouter call (google/gemini-2.5-flash -> groq/llama-3.3-70b-versatile fallback)
  if (openRouterApiKey) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(timeoutMs, 12000));
    try {
      const payload = buildOpenRouterGuidePayload({
        goal,
        previousStepSummary,
        currentRoute,
        stepNumber,
        pageMap,
        confirmedPath,
        preferredTargetId,
        preferredRoute,
        availableRoutes,
        appContext,
      });

      const res = await fetchImpl('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${openRouterApiKey}`,
          'X-Title': 'Interactive Guide Co-Browser',
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (res.ok) {
        const data = (await res.json()) as {
          model?: string;
          choices?: Array<{ message?: { content?: string } }>;
        };
        const content = data?.choices?.[0]?.message?.content;
        if (typeof content === 'string') {
          const parsed = parseGuideJsonResponse(content);
          if (parsed) {
            return finalizeParsedDecision(parsed, data.model || 'openrouter');
          }
        }
      }
    } catch {
      // Fall through cleanly to next configured live provider or local DOM planner
    } finally {
      clearTimeout(timer);
    }
  }

  // 2. Direct Gemini fallback via @google/genai when GEMINI_API_KEY is configured
  if (geminiApiKey) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const ai = new GoogleGenAI({ apiKey: geminiApiKey });
      const userJson = buildCompactGuideUserJson({
        goal,
        previousStepSummary,
        currentRoute,
        stepNumber,
        pageMap,
        confirmedPath,
        preferredTargetId,
        preferredRoute,
        availableRoutes,
        appContext,
      });

      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Gemini guide-step timeout')), Math.min(timeoutMs, 12000));
      });

      const response = await Promise.race([
        ai.models.generateContent({
          model: 'gemini-2.5-flash',
          contents: [
            {
              role: 'user',
              parts: [{ text: userJson }],
            },
          ],
          config: {
            systemInstruction: GUIDE_SYSTEM_PROMPT,
            responseMimeType: 'application/json',
            temperature: 0.1,
            maxOutputTokens: allowClarify ? 1000 : 400,
            thinkingConfig: {
              thinkingBudget: allowClarify ? 128 : 0,
            },
          },
        }),
        timeoutPromise,
      ]);

      const rawText = response.text || '';
      const parsed = parseGuideJsonResponse(rawText);
      if (parsed) {
        return finalizeParsedDecision(parsed, 'gemini:gemini-2.5-flash');
      }
      logger.warn({ rawLen: rawText.length }, 'Gemini guide-step returned non-JSON or empty output');
    } catch (err) {
      logger.warn({ err }, 'Gemini guide-step fallback failed');
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // 3. Direct Groq fallback when GROQ_API_KEY is configured
  if (groqApiKey) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(timeoutMs, 12000));
    try {
      const userJson = buildCompactGuideUserJson({
        goal,
        previousStepSummary,
        currentRoute,
        stepNumber,
        pageMap,
        confirmedPath,
        preferredTargetId,
        preferredRoute,
        availableRoutes,
        appContext,
      });

      const res = await fetchImpl('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${groqApiKey}`,
        },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          response_format: { type: 'json_object' },
          temperature: 0.1,
          max_tokens: allowClarify ? 360 : 180,
          messages: [
            { role: 'system', content: GUIDE_SYSTEM_PROMPT },
            { role: 'user', content: userJson },
          ],
        }),
        signal: controller.signal,
      });

      if (res.ok) {
        const data = (await res.json()) as {
          model?: string;
          choices?: Array<{ message?: { content?: string } }>;
        };
        const content = data?.choices?.[0]?.message?.content;
        if (typeof content === 'string') {
          const parsed = parseGuideJsonResponse(content);
          if (parsed) {
            return finalizeParsedDecision(parsed, `groq:${data.model || 'llama-3.3-70b-versatile'}`);
          }
        }
      }
    } catch {
      // Fall through cleanly to deterministic local DOM planner
    } finally {
      clearTimeout(timer);
    }
  }

  if (localClarify) {
    return {
      ...localClarify,
      provider: 'deterministic-dom-fallback',
    };
  }

  const deterministic = buildDeterministicGuideStep({
    goal,
    previousStepSummary,
    pageMap,
    stepNumber,
    currentRoute,
    confirmedPath,
    preferredTargetId,
    preferredRoute,
    availableRoutes,
  });

  return {
    ...deterministic,
    provider: 'deterministic-dom-fallback',
  };
}

export function createGuideStepRouter({ cfg, fetchImpl }: GuideStepRouteDeps): Router {
  const router = Router();

  router.post('/', async (req: Request, res: Response) => {
    const parsed = GuideStepRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: 'Invalid guide-step request payload',
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
      return;
    }

    const {
      goal,
      previousStepSummary,
      currentRoute,
      stepNumber,
      pageMap,
      confirmedPath,
      preferredTargetId,
      preferredRoute,
      availableRoutes,
      appContext,
    } = parsed.data;

    const decision = await resolveGuideStepDecision({
      goal,
      previousStepSummary,
      currentRoute,
      stepNumber,
      pageMap,
      confirmedPath,
      preferredTargetId,
      preferredRoute,
      availableRoutes,
      appContext,
      openRouterApiKey: cfg.openRouterApiKey,
      geminiApiKey: cfg.geminiApiKey,
      groqApiKey: cfg.groqApiKey,
      timeoutMs: cfg.llmTimeoutMs,
      fetchImpl,
    });

    res.json(decision);
  });

  return router;
}
