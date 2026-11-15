import React, { useMemo } from 'react';
import { ArrowRight, Check, Loader2, ShieldAlert, Square } from 'lucide-react';
import type { GuideStepResponse } from '@ai-assistant/core';

export interface GuideCursorProps {
  active: boolean;
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

export function GuideCursor({
  active,
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

  const isComplete = decision?.action === 'complete';
  const showNextButton = (pausedForInput || isComplete) && !loading;

  // Compute clamped tooltip card position near the target element
  const cardWidth = Math.min(310, Math.max(240, viewport.w - 24));
  const approxCardHeight = 148;
  let cardLeft = cursorPos.x + 22;
  let cardTop = cursorPos.y + 18;

  if (targetRect) {
    if (targetRect.bottom + approxCardHeight + 24 < viewport.h) {
      cardTop = targetRect.bottom + 14;
      cardLeft = targetRect.left;
    } else if (targetRect.top - approxCardHeight - 20 > 12) {
      cardTop = targetRect.top - approxCardHeight - 14;
      cardLeft = targetRect.left;
    } else {
      cardTop = Math.max(16, targetRect.top);
      cardLeft = targetRect.right + 16;
    }
  } else {
    cardLeft = Math.round((viewport.w - cardWidth) / 2);
    cardTop = Math.round(viewport.h * 0.22);
  }

  cardLeft = Math.max(12, Math.min(viewport.w - cardWidth - 12, cardLeft));
  cardTop = Math.max(12, Math.min(viewport.h - approxCardHeight - 76, cardTop));

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

      {/* Smooth-gliding SVG pointer */}
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

        {targetMissing && !loading && (
          <div className="aia-guide-cursor-hint">
            Target not visible here. Complete manually or press Next.
          </div>
        )}

        <div className="aia-guide-cursor-actions">
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
