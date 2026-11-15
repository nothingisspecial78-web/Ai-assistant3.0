import { useCallback, useEffect, useRef, useState } from 'react';
import {
  MAX_GUIDE_STEPS,
  truncateTipWords,
  type AvailableRouteHint,
  type GuideClarificationOption,
  type GuideStepResponse,
  type PageMapElement,
} from '@ai-assistant/core';
import {
  findElementByAiId,
  getAvailableRoutes,
  getElementLabel,
  getPageMap,
  isSensitiveDomElement,
} from '../guide/pageMap.ts';

export interface UseGuideCoBrowserOptions {
  apiUrl: string;
  appId: string;
  getAuthToken?: () => string | Promise<string>;
  getAvailableRoutes?: () => AvailableRouteHint[];
  getAppContext?: () => string;
  onNavigate?: (route: string) => void;
}

export interface StartGuideOptions {
  confirmedPath?: boolean;
  preferredTargetId?: string;
  preferredRoute?: string;
}

export type StartGuideOutcome =
  | { status: 'started' }
  | {
      status: 'clarify';
      goal: string;
      question: string;
      options: GuideClarificationOption[];
    }
  | { status: 'error'; message: string };

export interface GuideCoBrowserState {
  active: boolean;
  checking: boolean;
  goal: string;
  stepNumber: number;
  maxSteps: number;
  loading: boolean;
  decision: GuideStepResponse | null;
  pausedForInput: boolean;
  sensitiveBlocked: boolean;
  targetRect: DOMRect | null;
  cursorPos: { x: number; y: number };
  targetMissing: boolean;
  error: string | null;
  startGuide: (goal: string, options?: StartGuideOptions) => Promise<StartGuideOutcome>;
  continueAfterInput: () => Promise<void>;
  stopGuide: () => void;
}

function isInputControl(el: HTMLElement): boolean {
  const tag = el.tagName.toLowerCase();
  return tag === 'input' || tag === 'select' || tag === 'textarea';
}

function mergeAvailableRoutes(
  domRoutes: AvailableRouteHint[],
  hostRoutes: AvailableRouteHint[]
): AvailableRouteHint[] {
  const seen = new Set<string>();
  const merged: AvailableRouteHint[] = [];
  for (const r of [...domRoutes, ...hostRoutes]) {
    if (!r?.route || seen.has(r.route)) continue;
    seen.add(r.route);
    merged.push({ route: r.route, label: r.label || r.route });
    if (merged.length >= 40) break;
  }
  return merged;
}

export function useGuideCoBrowser({
  apiUrl,
  appId,
  getAuthToken,
  getAvailableRoutes: getHostAvailableRoutes,
  getAppContext,
  onNavigate,
}: UseGuideCoBrowserOptions): GuideCoBrowserState {
  const [active, setActive] = useState(false);
  const [checking, setChecking] = useState(false);
  const [goal, setGoal] = useState('');
  const [stepNumber, setStepNumber] = useState(0);
  const [loading, setLoading] = useState(false);
  const [decision, setDecision] = useState<GuideStepResponse | null>(null);
  const [pausedForInput, setPausedForInput] = useState(false);
  const [sensitiveBlocked, setSensitiveBlocked] = useState(false);
  const [targetRect, setTargetRect] = useState<DOMRect | null>(null);
  const [cursorPos, setCursorPos] = useState<{ x: number; y: number }>({
    x: typeof window !== 'undefined' ? window.innerWidth * 0.5 : 320,
    y: typeof window !== 'undefined' ? window.innerHeight * 0.4 : 240,
  });
  const [targetMissing, setTargetMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sessionTokenRef = useRef(0);
  const summaryHistoryRef = useRef<string[]>([]);
  const activeGoalRef = useRef('');
  const targetElRef = useRef<HTMLElement | null>(null);
  const timersRef = useRef<number[]>([]);
  const onNavigateRef = useRef(onNavigate);
  onNavigateRef.current = onNavigate;
  const getAuthTokenRef = useRef(getAuthToken);
  getAuthTokenRef.current = getAuthToken;
  const getHostRoutesRef = useRef(getHostAvailableRoutes);
  getHostRoutesRef.current = getHostAvailableRoutes;
  const getAppContextRef = useRef(getAppContext);
  getAppContextRef.current = getAppContext;

  const clearTimers = useCallback(() => {
    for (const id of timersRef.current) {
      window.clearTimeout(id);
    }
    timersRef.current = [];
  }, []);

  const stopGuide = useCallback(() => {
    sessionTokenRef.current += 1;
    clearTimers();
    targetElRef.current = null;
    summaryHistoryRef.current = [];
    activeGoalRef.current = '';
    setActive(false);
    setChecking(false);
    setLoading(false);
    setDecision(null);
    setPausedForInput(false);
    setSensitiveBlocked(false);
    setTargetRect(null);
    setTargetMissing(false);
    setError(null);
    setStepNumber(0);
  }, [clearTimers]);

  // Keep spotlight rect & gliding SVG cursor synced on scroll/resize
  useEffect(() => {
    if (!active) return;

    let rafId = 0;
    const syncRect = () => {
      const el = targetElRef.current;
      if (el && document.contains(el)) {
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          setTargetRect(rect);
          setCursorPos({
            x: rect.left + Math.min(rect.width * 0.72, rect.width - 8),
            y: rect.top + Math.min(rect.height * 0.65, rect.height - 6),
          });
          setTargetMissing(false);
          return;
        }
      }
      if (targetElRef.current) {
        setTargetRect(null);
      }
    };

    const scheduleSync = () => {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(syncRect);
    };

    syncRect();
    window.addEventListener('scroll', scheduleSync, true);
    window.addEventListener('resize', scheduleSync);
    const interval = window.setInterval(scheduleSync, 260);

    return () => {
      if (rafId) cancelAnimationFrame(rafId);
      window.clearInterval(interval);
      window.removeEventListener('scroll', scheduleSync, true);
      window.removeEventListener('resize', scheduleSync);
    };
  }, [active, decision]);

  // Escape key cancels active guide cleanly
  useEffect(() => {
    if (!active) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        stopGuide();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [active, stopGuide]);

  const applyStepDecision = useCallback(
    (
      rawDecision: GuideStepResponse,
      stepNum: number,
      sessionToken: number,
      onAdvance: (nextStep: number, tok: number) => void
    ) => {
      const nextTip = truncateTipWords(rawDecision.tip || 'Follow this step.');
      const normalized: GuideStepResponse = { ...rawDecision, tip: nextTip };
      setLoading(false);
      setDecision(normalized);

      if (normalized.action === 'complete') {
        targetElRef.current = null;
        setTargetRect(null);
        setTargetMissing(false);
        return;
      }

      if (normalized.action === 'navigate') {
        targetElRef.current = null;
        setTargetRect(null);
        const nextRoute = normalized.route || '/';
        summaryHistoryRef.current.push(`Navigated to ${nextRoute}`);
        if (onNavigateRef.current) {
          onNavigateRef.current(nextRoute);
        } else if (typeof window !== 'undefined' && window.location.pathname !== nextRoute) {
          window.history.pushState({}, '', nextRoute);
          window.dispatchEvent(new PopStateEvent('popstate'));
        }

        const t = window.setTimeout(() => {
          if (sessionToken === sessionTokenRef.current) {
            onAdvance(stepNum + 1, sessionToken);
          }
        }, 520);
        timersRef.current.push(t);
        return;
      }

      // Locate target element by data-ai-id (or fallback slug/id)
      const el = normalized.targetId ? findElementByAiId(normalized.targetId) : null;
      if (!el) {
        targetElRef.current = null;
        setTargetRect(null);
        setTargetMissing(true);
        setPausedForInput(true);
        return;
      }

      targetElRef.current = el;
      setTargetMissing(false);
      el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });

      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        setTargetRect(rect);
        setCursorPos({
          x: rect.left + Math.min(rect.width * 0.72, rect.width - 8),
          y: rect.top + Math.min(rect.height * 0.65, rect.height - 6),
        });
      }

      const domSensitive = isSensitiveDomElement(el);
      const inputEl = isInputControl(el);
      const label = getElementLabel(el) || normalized.targetId || 'element';

      // Client-side safety guardrail: NEVER auto-click sensitive controls or input fields
      if (
        normalized.action === 'click_safe' &&
        !domSensitive &&
        !inputEl &&
        !normalized.sensitiveBlocked
      ) {
        summaryHistoryRef.current.push(`Clicked ${normalized.targetId} (${label})`);
        const tClick = window.setTimeout(() => {
          if (sessionToken !== sessionTokenRef.current) return;
          if (!isSensitiveDomElement(el) && !isInputControl(el)) {
            el.click();
          }
          const tNext = window.setTimeout(() => {
            if (sessionToken === sessionTokenRef.current) {
              onAdvance(stepNum + 1, sessionToken);
            }
          }, 650);
          timersRef.current.push(tNext);
        }, 420);
        timersRef.current.push(tClick);
        return;
      }

      // point_and_wait (or blocked sensitive button / input): pause & await human action
      if (domSensitive || normalized.sensitiveBlocked) {
        setSensitiveBlocked(true);
      }
      if (inputEl) {
        try {
          el.focus({ preventScroll: true });
        } catch {
          el.focus();
        }
      }

      summaryHistoryRef.current.push(`Guided user to ${normalized.targetId} (${label})`);
      setPausedForInput(true);
    },
    []
  );

  const requestGuideStep = useCallback(
    async (payload: {
      goal: string;
      previousStepSummary: string;
      stepNumber: number;
      currentRoute: string;
      pageMap: PageMapElement[];
      confirmedPath?: boolean;
      preferredTargetId?: string;
      preferredRoute?: string;
      availableRoutes?: AvailableRouteHint[];
      appContext?: string;
    }): Promise<GuideStepResponse> => {
      const token = getAuthTokenRef.current ? await getAuthTokenRef.current() : '';
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'x-app-id': appId,
      };
      if (token) {
        headers.Authorization = token.startsWith('Bearer ') ? token : `Bearer ${token}`;
      }

      const base = apiUrl ? apiUrl.replace(/\/$/, '') : '';
      const res = await fetch(`${base}/api/guide-step`, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        throw new Error(`Guide step failed (${res.status})`);
      }

      return (await res.json()) as GuideStepResponse;
    },
    [apiUrl, appId]
  );

  const fetchNextStep = useCallback(
    async (stepNum: number, sessionToken: number): Promise<void> => {
      if (sessionToken !== sessionTokenRef.current) return;

      if (stepNum > MAX_GUIDE_STEPS) {
        setDecision({
          action: 'complete',
          tip: truncateTipWords('Reached 10-step guide limit. Please finish remaining steps manually.'),
        });
        setPausedForInput(false);
        setLoading(false);
        return;
      }

      setStepNumber(stepNum);
      setLoading(true);
      setPausedForInput(false);
      setSensitiveBlocked(false);
      setError(null);

      const currentRoute =
        typeof window !== 'undefined' ? window.location.pathname : '/';
      const pageMap: PageMapElement[] = getPageMap({ currentRoute });
      const domRoutes = getAvailableRoutes();
      const hostRoutes = getHostRoutesRef.current ? getHostRoutesRef.current() : [];
      const availableRoutes = mergeAvailableRoutes(domRoutes, hostRoutes);
      const appContext = getAppContextRef.current ? getAppContextRef.current() : undefined;
      const previousStepSummary = summaryHistoryRef.current.slice(-10).join(' -> ');

      try {
        const rawDecision = await requestGuideStep({
          goal: activeGoalRef.current,
          previousStepSummary,
          stepNumber: stepNum,
          currentRoute,
          pageMap,
          confirmedPath: true,
          ...(availableRoutes.length > 0 ? { availableRoutes } : {}),
          ...(appContext ? { appContext } : {}),
        });

        if (sessionToken !== sessionTokenRef.current) return;

        applyStepDecision(rawDecision, stepNum, sessionToken, (nextStep, tok) => {
          void fetchNextStep(nextStep, tok);
        });
      } catch (err) {
        if (sessionToken !== sessionTokenRef.current) return;
        setLoading(false);
        setError(err instanceof Error ? err.message : 'Unable to fetch guide step.');
      }
    },
    [applyStepDecision, requestGuideStep]
  );

  // When paused on a sensitive button or interactive control, clicking it directly or pressing Enter on an input can advance cleanly
  useEffect(() => {
    if (!active || !pausedForInput || !decision) return;
    const el = targetElRef.current;
    if (!el) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (
        e.key === 'Enter' &&
        el.tagName.toLowerCase() === 'input' &&
        document.activeElement === el
      ) {
        e.preventDefault();
        const tok = sessionTokenRef.current;
        void fetchNextStep(stepNumber + 1, tok);
      }
    };

    const handleManualButtonClick = () => {
      if (isSensitiveDomElement(el) || !isInputControl(el)) {
        const tok = sessionTokenRef.current;
        const t = window.setTimeout(() => {
          if (tok === sessionTokenRef.current) {
            void fetchNextStep(stepNumber + 1, tok);
          }
        }, 380);
        timersRef.current.push(t);
      }
    };

    el.addEventListener('keydown', handleKeyDown);
    if (!isInputControl(el)) {
      el.addEventListener('click', handleManualButtonClick);
    }
    return () => {
      el.removeEventListener('keydown', handleKeyDown);
      el.removeEventListener('click', handleManualButtonClick);
    };
  }, [active, pausedForInput, decision, stepNumber, fetchNextStep]);

  const startGuide = useCallback(
    async (userGoal: string, options: StartGuideOptions = {}): Promise<StartGuideOutcome> => {
      const cleanGoal = userGoal.trim();
      if (!cleanGoal) return { status: 'error', message: 'Empty guide goal.' };

      clearTimers();
      const token = sessionTokenRef.current + 1;
      sessionTokenRef.current = token;
      summaryHistoryRef.current = [];
      targetElRef.current = null;
      activeGoalRef.current = cleanGoal;

      setChecking(true);
      setError(null);

      const currentRoute =
        typeof window !== 'undefined' ? window.location.pathname : '/';
      const pageMap = getPageMap({ currentRoute });
      const domRoutes = getAvailableRoutes();
      const hostRoutes = getHostRoutesRef.current ? getHostRoutesRef.current() : [];
      const availableRoutes = mergeAvailableRoutes(domRoutes, hostRoutes);
      const appContext = getAppContextRef.current ? getAppContextRef.current() : undefined;

      try {
        const rawDecision = await requestGuideStep({
          goal: cleanGoal,
          previousStepSummary: '',
          stepNumber: 1,
          currentRoute,
          pageMap,
          confirmedPath: Boolean(options.confirmedPath),
          preferredTargetId: options.preferredTargetId,
          preferredRoute: options.preferredRoute,
          ...(availableRoutes.length > 0 ? { availableRoutes } : {}),
          ...(appContext ? { appContext } : {}),
        });

        if (token !== sessionTokenRef.current) {
          return { status: 'error', message: 'Guide cancelled.' };
        }

        setChecking(false);

        if (
          rawDecision.action === 'clarify' &&
          !options.confirmedPath &&
          Array.isArray(rawDecision.options) &&
          rawDecision.options.length >= 2
        ) {
          setActive(false);
          setDecision(null);
          return {
            status: 'clarify',
            goal: cleanGoal,
            question:
              rawDecision.question ||
              'Multiple paths are available. Which one would you like me to guide you through?',
            options: rawDecision.options,
          };
        }

        // Launch GuideCursor immediately on Step 1 decision
        setGoal(cleanGoal);
        setStepNumber(1);
        setActive(true);
        setTargetRect(null);
        setPausedForInput(false);
        setSensitiveBlocked(false);
        setTargetMissing(false);

        applyStepDecision(rawDecision, 1, token, (nextStep, tok) => {
          void fetchNextStep(nextStep, tok);
        });

        return { status: 'started' };
      } catch (err) {
        if (token !== sessionTokenRef.current) {
          return { status: 'error', message: 'Guide cancelled.' };
        }
        const msg = err instanceof Error ? err.message : 'Unable to start guide.';
        setChecking(false);
        setLoading(false);
        setError(msg);
        return { status: 'error', message: msg };
      }
    },
    [applyStepDecision, clearTimers, fetchNextStep, requestGuideStep]
  );

  const continueAfterInput = useCallback(async () => {
    if (!active || loading) return;
    if (decision?.action === 'complete') {
      stopGuide();
      return;
    }
    const token = sessionTokenRef.current;
    await fetchNextStep(stepNumber + 1, token);
  }, [active, loading, decision, stepNumber, fetchNextStep, stopGuide]);

  useEffect(() => () => clearTimers(), [clearTimers]);

  return {
    active,
    checking,
    goal,
    stepNumber,
    maxSteps: MAX_GUIDE_STEPS,
    loading,
    decision,
    pausedForInput,
    sensitiveBlocked,
    targetRect,
    cursorPos,
    targetMissing,
    error,
    startGuide,
    continueAfterInput,
    stopGuide,
  };
}
