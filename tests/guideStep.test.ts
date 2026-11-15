import type { AddressInfo } from 'node:net';
import express from 'express';
import { describe, expect, it } from 'vitest';
import {
  GUIDE_SYSTEM_PROMPT,
  OPENROUTER_GUIDE_MODELS,
  estimateApproxTokens,
  shouldTriggerGuideMode,
  type PageMapElement,
} from '@ai-assistant/core';
import {
  buildOpenRouterGuidePayload,
  createGuideStepRouter,
  resolveGuideStepDecision,
} from '../packages/server/src/routes/guideStep.ts';
import { createStandaloneAssistantApp } from '../packages/server/src/index.ts';
import { getPageMap } from '../packages/widget/src/guide/pageMap.ts';

interface StubNodeSpec {
  tagName: string;
  attrs?: Record<string, string>;
  value?: string;
  checked?: boolean;
  textContent?: string;
  hidden?: boolean;
  disabled?: boolean;
  excluded?: boolean;
  zeroRect?: boolean;
}

function createStubRoot(specs: StubNodeSpec[]): ParentNode {
  const elements = specs.map((spec) => {
    const attrs = spec.attrs ?? {};
    return {
      tagName: spec.tagName.toUpperCase(),
      value: spec.value ?? '',
      checked: spec.checked ?? false,
      textContent: spec.textContent ?? '',
      hidden: spec.hidden ?? false,
      disabled: spec.disabled ?? false,
      getAttribute(name: string) {
        return attrs[name] ?? null;
      },
      closest(selector: string) {
        if (spec.excluded && selector.includes('.aia-root')) {
          return {};
        }
        return null;
      },
      querySelector() {
        return null;
      },
      getBoundingClientRect() {
        return spec.zeroRect
          ? { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 }
          : { left: 20, top: 20, width: 120, height: 36, right: 140, bottom: 56 };
      },
    } as unknown as Element;
  });

  return {
    querySelectorAll() {
      return elements as unknown as NodeListOf<Element>;
    },
  } as unknown as ParentNode;
}

describe('Guide Me Co-Browsing Architecture', () => {
  it('1. DOM Scanner (getPageMap): strips noise, excludes hidden/widget nodes, and NEVER leaks typed input values', () => {
    const secretPassword = 'SuperSecretPassword123!';
    const secretPhone = '9876543210';

    const root = createStubRoot([
      {
        tagName: 'input',
        attrs: {
          'data-ai-id': 'login-password-input',
          'data-sensitive': 'true',
          type: 'password',
          'aria-label': '<b>Password</b>',
        },
        value: secretPassword,
      },
      {
        tagName: 'input',
        attrs: {
          'data-ai-id': 'student-phone-input',
          type: 'text',
          placeholder: 'Mobile number',
        },
        value: secretPhone,
      },
      {
        tagName: 'input',
        attrs: {
          'data-ai-id': 'student-email-input',
          type: 'email',
          placeholder: 'Email address',
        },
        value: '',
      },
      {
        tagName: 'button',
        attrs: {
          'data-ai-id': 'pay-submit-btn',
          'data-sensitive': 'true',
          type: 'submit',
        },
        textContent: '  <span>Pay</span>\n   Now  ',
      },
      {
        tagName: 'button',
        attrs: { 'data-ai-id': 'hidden-btn' },
        hidden: true,
        textContent: 'Hidden',
      },
      {
        tagName: 'button',
        attrs: { 'data-ai-id': 'widget-internal-btn' },
        excluded: true,
        textContent: 'Inside Widget',
      },
      {
        tagName: 'button',
        attrs: { 'data-ai-id': 'zero-rect-btn' },
        zeroRect: true,
        textContent: 'Collapsed',
      },
    ]);

    const pageMap = getPageMap({
      root,
      currentRoute: '/app/profile',
    });

    expect(pageMap).toHaveLength(4);
    expect(pageMap.map((e) => e.id)).toEqual([
      'login-password-input',
      'student-phone-input',
      'student-email-input',
      'pay-submit-btn',
    ]);

    expect(pageMap[0]).toEqual({
      id: 'login-password-input',
      tag: 'input',
      type: 'password',
      label: 'Password',
      hasValue: true,
      currentRoute: '/app/profile',
      sensitive: true,
    });
    expect(pageMap[1].hasValue).toBe(true);
    expect(pageMap[2].hasValue).toBe(false);
    expect(pageMap[3].label).toBe('Pay Now');
    expect(pageMap[3].sensitive).toBe(true);

    // Strict privacy check: secrets NEVER appear in serialized output
    const serialized = JSON.stringify(pageMap);
    expect(serialized).not.toContain(secretPassword);
    expect(serialized).not.toContain(secretPhone);
  });

  it('2. OpenRouter Payload Contract: uses fallback models, json_object format, <250 token system prompt, and compact pageMap', () => {
    expect(estimateApproxTokens(GUIDE_SYSTEM_PROMPT)).toBeLessThan(250);

    const pageMap: PageMapElement[] = [
      {
        id: 'students-add-btn',
        tag: 'button',
        type: 'button',
        label: 'Add student',
        hasValue: false,
        currentRoute: '/admin/students',
      },
    ];

    const payload = buildOpenRouterGuidePayload({
      goal: 'how do I add a student?',
      previousStepSummary: 'Started guide',
      currentRoute: '/admin',
      stepNumber: 1,
      pageMap,
    });

    expect(payload.models).toEqual(['google/gemini-2.5-flash', 'groq/llama-3.3-70b-versatile']);
    expect(payload.models).toEqual([...OPENROUTER_GUIDE_MODELS]);
    expect(payload.route).toBe('fallback');
    expect(payload.response_format).toEqual({ type: 'json_object' });
    expect(payload.messages[0]).toEqual({ role: 'system', content: GUIDE_SYSTEM_PROMPT });

    const userMsg = JSON.parse(payload.messages[1]!.content);
    expect(userMsg.goal).toBe('how do I add a student?');
    expect(userMsg.route).toBe('/admin');
    expect(userMsg.step).toBe(1);
    expect(userMsg.prev).toBe('Started guide');
    expect(userMsg.pageMap).toEqual([
      {
        id: 'students-add-btn',
        tag: 'button',
        type: 'button',
        label: 'Add student',
        hasValue: false,
      },
    ]);
  });

  it('3. Server Guardrails & OpenRouter Integration: blocks sensitive click_safe even if returned by OpenRouter', async () => {
    let capturedUrl = '';
    let capturedBody = '';
    const mockFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = String(input);
      capturedBody = String(init?.body ?? '');
      return new Response(
        JSON.stringify({
          model: 'google/gemini-2.5-flash',
          choices: [
            {
              message: {
                content: JSON.stringify({
                  action: 'click_safe',
                  targetId: 'delete-sector-btn',
                  route: '',
                  tip: 'Delete this sector right now immediately without asking anyone else first at all',
                }),
              },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }) as typeof fetch;

    const decision = await resolveGuideStepDecision({
      goal: 'how do I delete a sector?',
      previousStepSummary: '',
      currentRoute: '/admin/sectors',
      stepNumber: 2,
      pageMap: [
        {
          id: 'delete-sector-btn',
          tag: 'button',
          type: 'button',
          label: 'Delete sector',
          hasValue: false,
          currentRoute: '/admin/sectors',
          sensitive: true,
        },
      ],
      openRouterApiKey: 'test-openrouter-key',
      fetchImpl: mockFetch,
    });

    expect(capturedUrl).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(JSON.parse(capturedBody).route).toBe('fallback');
    expect(decision.action).toBe('point_and_wait');
    expect(decision.targetId).toBe('delete-sector-btn');
    expect(decision.sensitiveBlocked).toBe(true);
    expect(decision.tip.split(/\s+/).filter(Boolean).length).toBeLessThanOrEqual(12);
    expect(decision.provider).toBe('google/gemini-2.5-flash');
  });

  it('4. Express /api/guide-step Router: validates input, handles deterministic fallback, and enforces 10-step limit', async () => {
    const app = express();
    app.use(express.json());
    app.use(
      '/api/guide-step',
      createGuideStepRouter({
        cfg: { openRouterApiKey: '', llmTimeoutMs: 5000 },
      })
    );

    const server = app.listen(0);
    const { port } = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      const badRes = await fetch(`${baseUrl}/api/guide-step`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ goal: '' }),
      });
      expect(badRes.status).toBe(400);

      const navRes = await fetch(`${baseUrl}/api/guide-step`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          goal: 'how do I add a student?',
          previousStepSummary: '',
          currentRoute: '/admin',
          stepNumber: 1,
          pageMap: [
            {
              id: 'nav-overview-link',
              tag: 'a',
              type: 'link',
              label: 'Overview',
              hasValue: false,
              currentRoute: '/admin',
            },
          ],
        }),
      });
      expect(navRes.status).toBe(200);
      const navJson = (await navRes.json()) as { action: string; route?: string; provider?: string };
      expect(navJson.action).toBe('navigate');
      expect(navJson.route).toBe('/admin/students');
      expect(navJson.provider).toBe('deterministic-dom-fallback');

      const capRes = await fetch(`${baseUrl}/api/guide-step`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          goal: 'how do I add a student?',
          previousStepSummary: 'Step 10 finished',
          currentRoute: '/admin/students',
          stepNumber: 11,
          pageMap: [],
        }),
      });
      expect(capRes.status).toBe(200);
      const capJson = (await capRes.json()) as { action: string };
      expect(capJson.action).toBe('complete');
    } finally {
      server.close();
    }
  });

  it('5. Hybrid Chat Routing: keeps direct table edits in inline chat while routing guidance prompts to Guide Me', () => {
    expect(shouldTriggerGuideMode('how do I record a bulk payment?')).toBe(true);
    expect(shouldTriggerGuideMode('show me where to import students')).toBe(true);
    expect(shouldTriggerGuideMode('guide login')).toBe(true);
    expect(shouldTriggerGuideMode('guide students')).toBe(true);
    expect(shouldTriggerGuideMode('update user table')).toBe(false);
    expect(shouldTriggerGuideMode('update the students table with class 5')).toBe(false);
  });

  it('6. Dynamic Path Disambiguation: /api/guide-step clarifies broad goals before launching GuideCursor and transitions on confirmedPath', async () => {
    const app = express();
    app.use(express.json());
    app.use(
      '/api/guide-step',
      createGuideStepRouter({
        cfg: { openRouterApiKey: '', llmTimeoutMs: 5000 },
      })
    );

    const server = app.listen(0);
    const { port } = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${port}`;

    const multiLoginPageMap: PageMapElement[] = [
      { id: 'auth-tab-signin', tag: 'button', type: 'button', label: 'Sign in', hasValue: false, currentRoute: '/login' },
      { id: 'login-role-admin', tag: 'button', type: 'button', label: 'Admin', hasValue: false, currentRoute: '/login' },
      { id: 'login-role-manager', tag: 'button', type: 'button', label: 'Sector Manager', hasValue: false, currentRoute: '/login' },
      { id: 'login-role-student', tag: 'button', type: 'button', label: 'Student', hasValue: false, currentRoute: '/login' },
      { id: 'login-email-input', tag: 'input', type: 'email', label: 'Email', hasValue: false, currentRoute: '/login' },
    ];

    try {
      const clarifyRes = await fetch(`${baseUrl}/api/guide-step`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          goal: 'guide me how to log in',
          previousStepSummary: '',
          currentRoute: '/login',
          stepNumber: 1,
          confirmedPath: false,
          pageMap: multiLoginPageMap,
          availableRoutes: [
            { route: '/login', label: 'Portal Login' },
            { route: '/super-admin/login', label: 'Super Admin Login' },
          ],
        }),
      });
      expect(clarifyRes.status).toBe(200);
      const clarifyJson = (await clarifyRes.json()) as {
        action: string;
        question?: string;
        options?: Array<{ id: string; label: string; refinedGoal: string; targetId?: string; route?: string }>;
      };
      expect(clarifyJson.action).toBe('clarify');
      expect(clarifyJson.question).toBeTruthy();
      expect(clarifyJson.options?.map((o) => o.label)).toEqual([
        'Admin',
        'Sector Manager',
        'Student',
        'Super Admin Login',
      ]);

      // Selecting an option sends confirmedPath: true and preferredTargetId -> launches GuideCursor step immediately
      const selected = clarifyJson.options![1]!;
      const confirmedRes = await fetch(`${baseUrl}/api/guide-step`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          goal: selected.refinedGoal,
          previousStepSummary: '',
          currentRoute: '/login',
          stepNumber: 1,
          confirmedPath: true,
          preferredTargetId: selected.targetId,
          preferredRoute: selected.route,
          pageMap: multiLoginPageMap,
        }),
      });
      expect(confirmedRes.status).toBe(200);
      const confirmedJson = (await confirmedRes.json()) as { action: string; targetId?: string };
      expect(confirmedJson.action).toBe('click_safe');
      expect(confirmedJson.targetId).toBe('login-role-manager');
    } finally {
      server.close();
    }
  });

  it('7. Proxy Headers & Rate Limiter: handles X-Forwarded-For and Forwarded headers cleanly without ValidationError', async () => {
    const { app } = await createStandaloneAssistantApp({
      openRouterApiKey: '',
      llmTimeoutMs: 5000,
    });
    const server = app.listen(0);
    const { port } = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      const res = await fetch(`${baseUrl}/api/guide-step`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-app-id': 'khazna-ledger',
          Authorization: 'Bearer demo:PUBLIC:guest',
          'X-Forwarded-For': '203.0.113.45, 10.0.0.1',
          Forwarded: 'for=203.0.113.45;proto=https',
        },
        body: JSON.stringify({
          goal: 'how do I reset my password?',
          previousStepSummary: '',
          currentRoute: '/login',
          stepNumber: 1,
          pageMap: [
            {
              id: 'login-forgot-password-btn',
              tag: 'button',
              type: 'button',
              label: 'Forgot password?',
              hasValue: false,
              currentRoute: '/login',
            },
          ],
        }),
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as { action: string; targetId?: string };
      expect(json.action).toBe('click_safe');
      expect(json.targetId).toBe('login-forgot-password-btn');
    } finally {
      server.close();
    }
  });

  it('8. AI Multi-Task Thinking: preserves LLM clarify question & options when OpenRouter/LLM detects multiple tasks on a page', async () => {
    const mockFetch = (async () => {
      return new Response(
        JSON.stringify({
          model: 'google/gemini-2.5-flash',
          choices: [
            {
              message: {
                content:
                  '```json\n' +
                  JSON.stringify({
                    action: 'clarify',
                    question: 'There are multiple student management tasks. Which one would you like to do?',
                    tip: 'Choose a student task to start.',
                    options: [
                      {
                        id: 'add-student',
                        label: 'Add a single student',
                        description: 'Open enrollment drawer',
                        refinedGoal: 'Guide me to add a single student',
                        targetId: 'students-add-btn',
                        route: '/admin/students',
                      },
                      {
                        id: 'bulk-import',
                        label: 'Import students via CSV',
                        description: 'Upload spreadsheet',
                        refinedGoal: 'Guide me to import students via CSV',
                        route: '/admin/students/import',
                      },
                    ],
                  }) +
                  '\n```',
              },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }) as typeof fetch;

    const decision = await resolveGuideStepDecision({
      goal: 'guide students',
      previousStepSummary: '',
      currentRoute: '/admin/students',
      stepNumber: 1,
      confirmedPath: false,
      pageMap: [
        { id: 'students-add-btn', tag: 'button', type: 'button', label: 'Add student', hasValue: false, currentRoute: '/admin/students' },
        { id: 'students-export-btn', tag: 'button', type: 'button', label: 'Export CSV', hasValue: false, currentRoute: '/admin/students' },
      ],
      availableRoutes: [
        { route: '/admin/students', label: 'Students' },
        { route: '/admin/students/import', label: 'Student Import' },
      ],
      openRouterApiKey: 'test-openrouter-key',
      fetchImpl: mockFetch,
    });

    expect(decision.action).toBe('clarify');
    expect(decision.question).toBe(
      'There are multiple student management tasks. Which one would you like to do?'
    );
    expect(decision.options).toHaveLength(2);
    expect(decision.options?.[0]?.targetId).toBe('students-add-btn');
    expect(decision.options?.[0]?.route).toBe('/admin/students');
    expect(decision.options?.[1]?.route).toBe('/admin/students/import');
    expect(decision.provider).toBe('google/gemini-2.5-flash');
  });

  it('9. Step 10 History Resilience & Strict Login Scoping: accepts >400 char history without 400 and blocks LLM demo picks', async () => {
    const app = express();
    app.use(express.json());
    app.use(
      '/api/guide-step',
      createGuideStepRouter({
        cfg: { openRouterApiKey: '', llmTimeoutMs: 5000 },
      })
    );

    const server = app.listen(0);
    const { port } = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      const longHistory = Array.from({ length: 10 }, (_, idx) =>
        `Guided user to step-${idx + 1}-very-long-element-identifier (Very Long Control Label ${idx + 1})`
      ).join(' -> ');
      expect(longHistory.length).toBeGreaterThan(500);

      const step10Res = await fetch(`${baseUrl}/api/guide-step`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          goal: 'how do I add a student?',
          previousStepSummary: longHistory,
          currentRoute: '/admin/students',
          stepNumber: 10,
          pageMap: [
            {
              id: 'students-add-btn',
              tag: 'button',
              type: 'button',
              label: 'Add student',
              hasValue: false,
              currentRoute: '/admin/students',
            },
          ],
        }),
      });
      expect(step10Res.status).toBe(200);
      const step10Json = (await step10Res.json()) as { action: string };
      expect(step10Json.action).toBe('complete');

      // LLM attempting to click login-demo-student-btn gets overridden cleanly
      const mockDemoPick = (async () =>
        new Response(
          JSON.stringify({
            model: 'google/gemini-2.5-flash',
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    action: 'click_safe',
                    targetId: 'login-demo-student-btn',
                    tip: 'Click Student Demo.',
                  }),
                },
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )) as typeof fetch;

      const filtered = await resolveGuideStepDecision({
        goal: 'guide me to login as student',
        previousStepSummary: 'Clicked login-role-student (Student)',
        currentRoute: '/login',
        stepNumber: 2,
        confirmedPath: true,
        pageMap: [
          { id: 'login-demo-student-btn', tag: 'button', type: 'button', label: 'Student', hasValue: false, currentRoute: '/login' },
          { id: 'login-student-admission-input', tag: 'input', type: 'text', label: 'Admission number', hasValue: false, currentRoute: '/login' },
          { id: 'login-submit-btn', tag: 'button', type: 'submit', label: 'Sign in as Student', hasValue: false, currentRoute: '/login' },
        ],
        openRouterApiKey: 'test-key',
        fetchImpl: mockDemoPick,
      });
      expect(filtered.targetId).toBe('login-student-admission-input');
      expect(filtered.action).toBe('point_and_wait');

      // Login goal reaching /app overview completes immediately
      const atOverview = await resolveGuideStepDecision({
        goal: 'guide me to login as student',
        previousStepSummary: 'Clicked login-submit-btn (Sign in as Student)',
        currentRoute: '/app',
        stepNumber: 4,
        confirmedPath: true,
        pageMap: [
          { id: 'student-combined-statement-btn', tag: 'button', type: 'button', label: 'Download statement', hasValue: false, currentRoute: '/app' },
        ],
        openRouterApiKey: 'test-key',
        fetchImpl: mockDemoPick,
      });
      expect(atOverview.action).toBe('complete');
    } finally {
      server.close();
    }
  });
});

