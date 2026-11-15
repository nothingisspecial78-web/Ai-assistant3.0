import React, { useMemo } from 'react';
import { ArrowRight, Check, Loader2, ShieldAlert, Square, X } from 'lucide-react';
import type { GuideStepResponse } from '@ai-assistant/core';

export interface GuideCursorProps {
  active: boolean;
  appName?: string;
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
  onNext: () => void;
  onStop: () => void;
}

interface BoxRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

function rectsOverlap(a: BoxRect, b: BoxRect, pad = 6): boolean {
  return !(
    a.right + pad <= b.left ||
    a.left - pad >= b.right ||
    a.bottom + pad <= b.top ||
    a.top - pad >= b.bottom
  );
}

export function GuideCursor({
  active,
  appName = 'App',
  stepNumber,
  maxSteps,
  loading,
  decision,
  pausedForInput,
  sensitiveBlocked,
  targetRect,
  cursorPos,
  targetMissing,
  error,
  onNext,
  onStop,
}: GuideCursorProps) {
  const viewport = useMemo(() => {
    if (typeof window === 'undefined') return { w: 1280, h: 800 };
    return { w: window.innerWidth, h: window.innerHeight };
  }, [targetRect, cursorPos, active]);

  if (!active) return null;

  const displayAppName = appName.trim() || 'App';
  const isComplete = decision?.action === 'complete';
  const showNextButton = (pausedForInput || isComplete) && !loading && !error;

  const cardWidth = Math.min(310, Math.max(240, viewport.w - 24));
  const approxCardHeight = error ? 136 : 152;
  const maxCardLeft = Math.max(12, viewport.w - cardWidth - 12);
  const maxCardTop = Math.max(12, viewport.h - approxCardHeight - 82);

  // Bounding box for the SVG pointer arrow + its attached web-app-name pill
  const pillEstimatedWidth = Math.min(185, Math.max(96, 56 + displayAppName.length * 7.5));
  const cursorBox: BoxRect = {
    left: cursorPos.x - 6,
    top: cursorPos.y - 6,
    right: cursorPos.x + pillEstimatedWidth,
    bottom: cursorPos.y + 48,
  };

  // Top screen-sharing pill strip to avoid overlapping
  const topPillBox: BoxRect = {
    left: viewport.w / 2 - 170,
    top: 0,
    right: viewport.w / 2 + 170,
    bottom: 58,
  };

  const clampCandidate = (rawLeft: number, rawTop: number): { left: number; top: number } => ({
    left: Math.max(12, Math.min(maxCardLeft, Math.round(rawLeft))),
    top: Math.max(12, Math.min(maxCardTop, Math.round(rawTop))),
  });

  const candidates: Array<{ left: number; top: number }> = [];

  if (targetRect && !isComplete) {
    const fitsLeft = targetRect.left - cardWidth - 22 >= 12;
    const fitsRight = targetRect.right + cardWidth + 22 <= viewport.w - 12;

    if (fitsLeft) {
      candidates.push(clampCandidate(targetRect.left - cardWidth - 22, targetRect.top - 12));
    }
    if (fitsRight) {
      candidates.push(clampCandidate(targetRect.right + 22, targetRect.top - 12));
    }
    // Fallback below / above target (clear of cursorBox)
    candidates.push(
      clampCandidate(targetRect.left, Math.max(targetRect.bottom + 16, cursorBox.bottom + 14))
    );
    candidates.push(clampCandidate(targetRect.left, targetRect.bottom + 16));
    candidates.push(clampCandidate(targetRect.left, targetRect.top - approxCardHeight - 16));
    candidates.push(clampCandidate(targetRect.right + 20, targetRect.top));
    candidates.push(clampCandidate(targetRect.left - cardWidth - 20, targetRect.top));
  } else {
    // No target spotlight (e.g. completion, navigation, or error): place cleanly away from cursorBox
    candidates.push(clampCandidate((viewport.w - cardWidth) / 2, cursorBox.bottom + 20));
    candidates.push(
      clampCandidate((viewport.w - cardWidth) / 2, cursorBox.top - approxCardHeight - 20)
    );
    candidates.push(clampCandidate(cursorBox.right + 20, cursorPos.y));
    candidates.push(clampCandidate(cursorBox.left - cardWidth - 20, cursorPos.y));
    candidates.push(clampCandidate((viewport.w - cardWidth) / 2, viewport.h * 0.24));
  }

  let chosen = candidates[0]!;
  let bestScore = Number.POSITIVE_INFINITY;

  for (const cand of candidates) {
    const box: BoxRect = {
      left: cand.left,
      top: cand.top,
      right: cand.left + cardWidth,
      bottom: cand.top + approxCardHeight,
    };
    let penalty = 0;
    if (rectsOverlap(box, cursorBox, 8)) penalty += 1000;
    if (rectsOverlap(box, topPillBox, 6)) penalty += 250;
    if (targetRect && !isComplete) {
      const targetBox: BoxRect = {
        left: targetRect.left,
        top: targetRect.top,
        right: targetRect.right,
        bottom: targetRect.bottom,
      };
      if (rectsOverlap(box, targetBox, 8)) penalty += 400;
    }
    if (penalty < bestScore) {
      bestScore = penalty;
      chosen = cand;
      if (penalty === 0) break;
    }
  }

  const cardLeft = chosen.left;
  const cardTop = chosen.top;

  const ringStyle: React.CSSProperties | undefined = targetRect
    ? {
        left: `${Math.max(2, targetRect.left - 5)}px`,
        top: `${Math.max(2, targetRect.top - 5)}px`,
        width: `${Math.max(16, targetRect.width + 10)}px`,
        height: `${Math.max(16, targetRect.height + 10)}px`,
      }
    : undefined;

  const markOverlayEvent = (e: React.SyntheticEvent) => {
    const ne = e.nativeEvent as Event & { __aiaOverlayClick?: boolean };
    ne.__aiaOverlayClick = true;
  };

  return (
    <div
      className="aia-guide-cursor-root"
      data-testid="guide-cursor-overlay"
      role="region"
      aria-label="Interactive Guide Me overlay"
    >
      {/* Target spotlight highlight ring */}
      {ringStyle && !isComplete && (
        <div
          data-testid="guide-spotlight-ring"
          className={`aia-guide-cursor-ring ${
            sensitiveBlocked ? 'aia-guide-cursor-ring-sensitive' : ''
          }`}
          style={ringStyle}
        />
      )}

      {/* Smooth-gliding SVG pointer + Web App Name Pill */}
      <div
        data-testid="guide-svg-pointer"
        className="aia-guide-cursor-pointer"
        style={{
          transform: `translate3d(${Math.round(cursorPos.x)}px, ${Math.round(cursorPos.y)}px, 0)`,
        }}
      >
        <svg
          width="28"
          height="28"
          viewBox="0 0 28 28"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          aria-hidden="true"
        >
          <path
            d="M4.5 3.5L23.5 11.2L15.1 14.4L11.8 22.8L4.5 3.5Z"
            fill={sensitiveBlocked ? '#ef4444' : '#f97316'}
            stroke="#ffffff"
            strokeWidth="2"
            strokeLinejoin="round"
          />
        </svg>
        <span
          data-testid="guide-agent-cursor-pill"
          className={`aia-cursor-name-pill ${
            sensitiveBlocked ? 'aia-cursor-name-pill-sensitive' : 'aia-cursor-name-pill-agent'
          }`}
        >
          {displayAppName}
        </span>
      </div>

      {/* Compact floating instruction tooltip */}
      <div
        data-testid="guide-tooltip-card"
        className="aia-guide-cursor-card"
        onPointerDown={markOverlayEvent}
        onMouseDown={markOverlayEvent}
        style={{ left: `${cardLeft}px`, top: `${cardTop}px`, width: `${cardWidth}px` }}
      >
        <div className="aia-guide-cursor-card-head">
          <span className="aia-guide-cursor-step" style={{ fontVariantNumeric: 'tabular-nums' }}>
            Step {Math.min(stepNumber, maxSteps)} / {maxSteps}
          </span>
          {sensitiveBlocked && (
            <span className="aia-guide-cursor-sensitive-badge">
              <ShieldAlert size={12} /> Manual Click Only
            </span>
          )}
        </div>

        <p className="aia-guide-cursor-tip" data-testid="guide-tip-text">
          {loading ? (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <Loader2 size={13} className="aia-spin" /> Finding next step…
            </span>
          ) : error ? (
            error
          ) : (
            decision?.tip || 'Follow the highlighted control.'
          )}
        </p>

        {targetMissing && !loading && !error && (
          <div className="aia-guide-cursor-hint">
            Target not visible here. Complete manually or press Next.
          </div>
        )}

        <div className="aia-guide-cursor-actions">
          {error && !loading && (
            <button
              type="button"
              data-ai-id="guide-error-close-btn"
              data-testid="guide-error-close-btn"
              className="aia-guide-cursor-next"
              onClick={onStop}
            >
              <X size={13} /> Close
            </button>
          )}
          {(showNextButton || loading) && (
            <button
              type="button"
              disabled={loading}
              data-ai-id="guide-next-btn"
              data-testid="guide-next-btn"
              className="aia-guide-cursor-next"
              onClick={onNext}
            >
              {isComplete ? (
                <>
                  <Check size={13} /> Done
                </>
              ) : (
                <>
                  Next <ArrowRight size={13} />
                </>
              )}
            </button>
          )}
        </div>
      </div>

      {/* Persistent floating Stop Guide control */}
      <div
        className="aia-guide-cursor-stop-dock"
        onPointerDown={markOverlayEvent}
        onMouseDown={markOverlayEvent}
      >
        <button
          type="button"
          data-ai-id="guide-stop-btn"
          data-testid="guide-stop-btn"
          className="aia-guide-cursor-stop"
          onClick={onStop}
        >
          <Square size={11} fill="currentColor" />
          Stop Guide
        </button>
      </div>
    </div>
  );
}
