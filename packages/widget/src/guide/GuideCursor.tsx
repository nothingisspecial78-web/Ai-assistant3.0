import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Loader2,
  Mic,
  MicOff,
  Send,
  ShieldAlert,
  Square,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';
import type { GuideStepResponse } from '@ai-assistant/core';
import { useVoiceInput } from '../hooks/useVoiceInput.ts';
import { computeGuideCursorLayout } from './guidePositioning.ts';

export interface GuideCursorProps {
  active: boolean;
  appName?: string;
  apiUrl?: string;
  appId?: string;
  language?: 'auto' | 'en' | 'ml' | string;
  getAuthToken?: () => string | Promise<string>;
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
  detectedError?: string | null;
  canGoBack?: boolean;
  muted?: boolean;
  isSpeaking?: boolean;
  onBack?: () => void;
  onNext: () => void;
  onReply?: (reply: string) => void;
  onToggleMute?: () => void;
  onStop: () => void;
}

export function GuideCursor({
  active,
  appName = 'App',
  apiUrl = '',
  appId = 'khazna-ledger',
  language = 'en',
  getAuthToken,
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
  detectedError,
  canGoBack = false,
  muted = false,
  isSpeaking = false,
  onBack,
  onNext,
  onReply,
  onToggleMute,
  onStop,
}: GuideCursorProps) {
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [cardSize, setCardSize] = useState<{ width: number; height: number }>({
    width: 320,
    height: 175,
  });
  const [viewport, setViewport] = useState<{ width: number; height: number }>(() =>
    typeof window !== 'undefined'
      ? { width: window.innerWidth, height: window.innerHeight }
      : { width: 1280, height: 800 }
  );
  const [replyText, setReplyText] = useState('');

  const { recordingState, micError, clearMicError, toggleVoiceInput } = useVoiceInput({
    apiUrl,
    appId,
    language,
    getAuthToken,
    onTranscript: (transcript) => {
      const clean = transcript.trim();
      if (!clean) return;
      if (onReply) {
        onReply(clean);
      } else {
        setReplyText(clean);
      }
    },
  });

  useEffect(() => {
    setReplyText('');
    clearMicError();
  }, [decision?.question, decision?.askStage, stepNumber, clearMicError]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onResize = () => {
      setViewport({ width: window.innerWidth, height: window.innerHeight });
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useLayoutEffect(() => {
    const el = cardRef.current;
    if (!el || !active) return;

    const measure = () => {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        setCardSize((prev) =>
          Math.abs(prev.width - r.width) > 2 || Math.abs(prev.height - r.height) > 2
            ? { width: Math.round(r.width), height: Math.round(r.height) }
            : prev
        );
      }
    };

    measure();

    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(measure);
      ro.observe(el);
      return () => ro.disconnect();
    }
  }, [active, decision, loading, error, targetMissing, recordingState, micError]);

  const displayAppName = appName.trim() || 'App';
  const isComplete = decision?.action === 'complete';
  const isAskUser = decision?.action === 'ask_user';
  const isRefresh = decision?.action === 'refresh_and_retry';

  const layout = useMemo(
    () =>
      computeGuideCursorLayout({
        targetRect: targetRect
          ? {
              left: targetRect.left,
              top: targetRect.top,
              right: targetRect.right,
              bottom: targetRect.bottom,
              width: targetRect.width,
              height: targetRect.height,
            }
          : null,
        cardSize,
        viewport,
        appName: displayAppName,
        isComplete: isComplete || isAskUser || isRefresh,
        preferredAnchorCursor: targetRect ? undefined : cursorPos,
      }),
    [targetRect, cardSize, viewport, displayAppName, isComplete, isAskUser, isRefresh, cursorPos]
  );

  if (!active) return null;

  const showNextButton =
    !isAskUser && !isRefresh && (pausedForInput || isComplete) && !loading && !error;

  const ringStyle: React.CSSProperties | undefined =
    targetRect && !isAskUser && !isRefresh
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

  const submitTextReply = () => {
    const clean = replyText.trim();
    if (!clean || !onReply || loading) return;
    setReplyText('');
    onReply(clean);
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
          transform: `translate3d(${Math.round(layout.cursorPos.x)}px, ${Math.round(
            layout.cursorPos.y
          )}px, 0)`,
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

      {/* Compact floating instruction tooltip with dynamic collision detection */}
      <div
        ref={cardRef}
        data-testid="guide-tooltip-card"
        data-placement={layout.placement}
        className="aia-guide-cursor-card"
        onPointerDown={markOverlayEvent}
        onMouseDown={markOverlayEvent}
        style={{
          left: `${layout.cardLeft}px`,
          top: `${layout.cardTop}px`,
          width: `${layout.cardWidth}px`,
        }}
      >
        <div className="aia-guide-cursor-card-head">
          <span className="aia-guide-cursor-step" style={{ fontVariantNumeric: 'tabular-nums' }}>
            Step {Math.min(stepNumber, maxSteps)} / {maxSteps}
          </span>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {sensitiveBlocked && (
              <span className="aia-guide-cursor-sensitive-badge">
                <ShieldAlert size={12} /> Manual Click Only
              </span>
            )}
            {onToggleMute && (
              <button
                type="button"
                data-testid="guide-voice-toggle-btn"
                data-ai-id="guide-voice-toggle-btn"
                aria-label={muted ? 'Unmute guide voice' : 'Mute guide voice'}
                aria-pressed={muted}
                title={muted ? 'Unmute agent voice' : isSpeaking ? 'Speaking… (click to mute)' : 'Mute agent voice'}
                className={`aia-guide-cursor-icon-btn ${isSpeaking && !muted ? 'is-speaking' : ''}`}
                onClick={onToggleMute}
              >
                {muted ? <VolumeX size={13} /> : <Volume2 size={13} />}
              </button>
            )}
          </div>
        </div>

        {isAskUser && detectedError && decision?.askStage === 'diagnostic' && (
          <div className="aia-guide-cursor-error-note" data-testid="guide-detected-error-note">
            Detected issue: {detectedError}
          </div>
        )}

        <p className="aia-guide-cursor-tip" data-testid="guide-tip-text">
          {loading ? (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <Loader2 size={13} className="aia-spin" /> Finding next step…
            </span>
          ) : error ? (
            error
          ) : isAskUser ? (
            decision?.question || decision?.tip || 'Please respond to continue.'
          ) : (
            decision?.tip || 'Follow the highlighted control.'
          )}
        </p>

        {isAskUser && !loading && !error && (
          <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {decision?.quickReplies && decision.quickReplies.length > 0 && (
              <div className="aia-guide-cursor-replies" data-testid="guide-quick-replies">
                {decision.quickReplies.map((qr) => (
                  <button
                    key={qr.id}
                    type="button"
                    data-testid={`guide-quick-reply-${qr.id}`}
                    data-ai-id={`guide-quick-reply-${qr.id}`}
                    className={`aia-guide-cursor-reply-btn ${
                      qr.variant === 'primary'
                        ? 'is-primary'
                        : qr.variant === 'danger'
                          ? 'is-danger'
                          : ''
                    }`}
                    onClick={() => onReply?.(qr.value)}
                  >
                    {qr.label}
                  </button>
                ))}
              </div>
            )}

            <div className="aia-guide-cursor-reply-input-row">
              <input
                type="text"
                data-testid="guide-reply-input"
                data-ai-id="guide-reply-input"
                aria-label="Reply to assistant question"
                placeholder={
                  decision?.askStage === 'follow_up_guide'
                    ? 'Ask another guide or type close…'
                    : 'Type or speak Yes / No…'
                }
                className="aia-guide-cursor-reply-input"
                value={replyText}
                onChange={(e) => setReplyText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    submitTextReply();
                  }
                }}
              />
              <button
                type="button"
                data-testid="guide-voice-input-btn"
                data-ai-id="guide-voice-input-btn"
                aria-label={recordingState === 'listening' ? 'Stop voice answer' : 'Speak answer'}
                aria-pressed={recordingState !== 'idle'}
                title="Speak your answer"
                className={`aia-guide-cursor-mic-btn ${
                  recordingState === 'listening' ? 'is-listening' : ''
                }`}
                onClick={toggleVoiceInput}
              >
                {recordingState === 'listening' ? <MicOff size={13} /> : <Mic size={13} />}
              </button>
              <button
                type="button"
                data-testid="guide-reply-send-btn"
                data-ai-id="guide-reply-send-btn"
                aria-label="Send reply"
                disabled={!replyText.trim()}
                className="aia-guide-cursor-mic-btn is-send"
                onClick={submitTextReply}
              >
                <Send size={13} />
              </button>
            </div>

            {recordingState !== 'idle' && (
              <div style={{ fontSize: '11px', color: '#93c5fd', fontWeight: 600 }} role="status">
                {recordingState === 'listening' ? 'Listening… speak now' : 'Transcribing voice…'}
              </div>
            )}
            {micError && (
              <div style={{ fontSize: '11px', color: '#fda4af' }} role="status">
                {micError}
              </div>
            )}
          </div>
        )}

        {targetMissing && !isAskUser && !loading && !error && (
          <div className="aia-guide-cursor-hint">
            Target not visible here. Complete manually or press Next.
          </div>
        )}

        <div className="aia-guide-cursor-actions">
          {!error && onBack && (
            <button
              type="button"
              disabled={!canGoBack || loading}
              data-ai-id="guide-back-btn"
              data-testid="guide-back-btn"
              className="aia-guide-cursor-back"
              onClick={onBack}
            >
              <ArrowLeft size={13} /> Back
            </button>
          )}
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
