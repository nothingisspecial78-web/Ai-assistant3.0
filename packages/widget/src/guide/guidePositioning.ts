export interface LayoutRectLike {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export interface GuideBoxRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export type GuideTooltipPlacement = 'above' | 'below' | 'left' | 'right' | 'center';

export interface GuideCursorLayoutInput {
  targetRect: LayoutRectLike | null;
  cardSize: { width: number; height: number };
  viewport: { width: number; height: number };
  appName?: string;
  isComplete?: boolean;
  preferredAnchorCursor?: { x: number; y: number };
}

export interface GuideCursorLayoutResult {
  cursorPos: { x: number; y: number };
  cardLeft: number;
  cardTop: number;
  cardWidth: number;
  placement: GuideTooltipPlacement;
  hadCollision: boolean;
}

export function rectsOverlap(a: GuideBoxRect, b: GuideBoxRect, pad = 6): boolean {
  return !(
    a.right + pad <= b.left ||
    a.left - pad >= b.right ||
    a.bottom + pad <= b.top ||
    a.top - pad >= b.bottom
  );
}

function intersectionArea(a: GuideBoxRect, b: GuideBoxRect, pad = 0): number {
  const xOverlap = Math.max(0, Math.min(a.right + pad, b.right) - Math.max(a.left - pad, b.left));
  const yOverlap = Math.max(0, Math.min(a.bottom + pad, b.bottom) - Math.max(a.top - pad, b.top));
  return xOverlap * yOverlap;
}

/**
 * Pure dynamic collision-detection & auto-flip layout solver for the tour step card
 * and agent cursor pointer + name pill.
 *
 * Guarantees:
 * - Cursor + app name pill stay clamped inside the viewport and never clip edges.
 * - Tooltip card measures real height/width and checks vertical space above vs below
 *   the target element, automatically flipping between `above` and `below` during
 *   scrolling whenever insufficient vertical space exists or when colliding with the
 *   target element, cursor pill, top Screen Share pill, or bottom Stop Guide dock.
 */
export function computeGuideCursorLayout(
  input: GuideCursorLayoutInput
): GuideCursorLayoutResult {
  const vw = Math.max(320, input.viewport.width);
  const vh = Math.max(320, input.viewport.height);
  const displayAppName = (input.appName || 'App').trim() || 'App';
  const isComplete = Boolean(input.isComplete);
  const targetRect = input.targetRect;

  const cardWidth = Math.min(Math.max(240, input.cardSize.width || 310), Math.max(240, vw - 24));
  const cardHeight = Math.max(110, input.cardSize.height || 168);

  const margin = 12;
  const bottomSafeReserve = 76; // Stop Guide dock height + margin
  const maxCardLeft = Math.max(margin, vw - cardWidth - margin);
  const maxCardTop = Math.max(margin, vh - cardHeight - bottomSafeReserve);

  // Estimate cursor pointer + name pill bounding box
  const pillEstimatedWidth = Math.min(185, Math.max(98, 56 + displayAppName.length * 7.5));
  const cursorFootprintWidth = Math.max(32, pillEstimatedWidth + 16);
  const cursorFootprintHeight = 46;

  // Compute clamped/adjusted cursor position
  let rawCursorX =
    input.preferredAnchorCursor?.x ??
    (targetRect
      ? targetRect.left + Math.min(targetRect.width * 0.72, Math.max(10, targetRect.width - 10))
      : vw * 0.5);
  let rawCursorY =
    input.preferredAnchorCursor?.y ??
    (targetRect
      ? targetRect.top + Math.min(targetRect.height * 0.65, Math.max(8, targetRect.height - 8))
      : vh * 0.42);

  // Clamp cursor + name pill cleanly inside viewport so pill never gets cut off on right/bottom edges
  const cursorX = Math.max(
    12,
    Math.min(vw - cursorFootprintWidth - 8, Math.round(rawCursorX))
  );
  const cursorY = Math.max(
    12,
    Math.min(vh - cursorFootprintHeight - bottomSafeReserve, Math.round(rawCursorY))
  );

  const cursorBox: GuideBoxRect = {
    left: cursorX - 6,
    top: cursorY - 6,
    right: cursorX + pillEstimatedWidth + 8,
    bottom: cursorY + cursorFootprintHeight,
  };

  // Top Screen Share pill box
  const topPillBox: GuideBoxRect = {
    left: vw / 2 - 175,
    top: 0,
    right: vw / 2 + 175,
    bottom: 58,
  };

  // Bottom Stop Guide dock box
  const bottomDockBox: GuideBoxRect = {
    left: vw / 2 - 96,
    top: vh - bottomSafeReserve,
    right: vw / 2 + 96,
    bottom: vh,
  };

  const clampCandidate = (
    rawLeft: number,
    rawTop: number,
    placement: GuideTooltipPlacement
  ): { left: number; top: number; placement: GuideTooltipPlacement } => ({
    left: Math.max(margin, Math.min(maxCardLeft, Math.round(rawLeft))),
    top: Math.max(margin, Math.min(maxCardTop, Math.round(rawTop))),
    placement,
  });

  const gap = 16;
  const candidates: Array<{
    left: number;
    top: number;
    placement: GuideTooltipPlacement;
    priorityBias: number;
  }> = [];

  if (targetRect && !isComplete) {
    const targetBox: GuideBoxRect = {
      left: targetRect.left,
      top: targetRect.top,
      right: targetRect.right,
      bottom: targetRect.bottom,
    };

    const effectiveTopFloor = rectsOverlap(
      {
        left: targetRect.left,
        top: 0,
        right: Math.max(targetRect.right, targetRect.left + cardWidth),
        bottom: 60,
      },
      topPillBox,
      4
    )
      ? 62
      : margin;

    const availAbove = targetRect.top - effectiveTopFloor;
    const availBelow = vh - bottomSafeReserve - targetRect.bottom;
    const canFitAbove = availAbove >= cardHeight + gap;
    const canFitBelow = availBelow >= cardHeight + gap;

    // Horizontal alignments centered over target, left-aligned with target, or shifted clear of cursor
    const targetCenterLeft = targetRect.left + targetRect.width / 2 - cardWidth / 2;
    const xOffsets = [
      targetRect.left,
      targetCenterLeft,
      targetRect.right - cardWidth,
      cursorBox.left - cardWidth - 14,
      cursorBox.right + 14,
    ];

    const pushAbove = (bias: number) => {
      for (let i = 0; i < xOffsets.length; i++) {
        const clamped = clampCandidate(xOffsets[i]!, targetRect.top - cardHeight - gap, 'above');
        candidates.push({ ...clamped, priorityBias: bias + i });
      }
    };

    const pushBelow = (bias: number) => {
      const topBelowTarget = targetRect.bottom + gap;
      const topBelowCursor = Math.max(targetRect.bottom + gap, cursorBox.bottom + 12);
      for (let i = 0; i < xOffsets.length; i++) {
        const c1 = clampCandidate(xOffsets[i]!, topBelowTarget, 'below');
        candidates.push({ ...c1, priorityBias: bias + i });
        if (topBelowCursor !== topBelowTarget) {
          const c2 = clampCandidate(xOffsets[i]!, topBelowCursor, 'below');
          candidates.push({ ...c2, priorityBias: bias + i + 0.5 });
        }
      }
    };

    const pushSides = (bias: number) => {
      const fitsRight = targetRect.right + cardWidth + 22 <= vw - margin;
      const fitsLeft = targetRect.left - cardWidth - 22 >= margin;
      const midY = targetRect.top + targetRect.height / 2 - cardHeight / 2;
      if (fitsRight) {
        candidates.push({
          ...clampCandidate(targetRect.right + 20, targetRect.top - 8, 'right'),
          priorityBias: bias,
        });
        candidates.push({
          ...clampCandidate(targetRect.right + 20, midY, 'right'),
          priorityBias: bias + 1,
        });
      }
      if (fitsLeft) {
        candidates.push({
          ...clampCandidate(targetRect.left - cardWidth - 20, targetRect.top - 8, 'left'),
          priorityBias: bias,
        });
        candidates.push({
          ...clampCandidate(targetRect.left - cardWidth - 20, midY, 'left'),
          priorityBias: bias + 1,
        });
      }
    };

    // Automatic above <-> below dynamic preference based on available vertical room:
    // If above fits comfortably, evaluate above before below;
    // when scrolled so insufficient space exists above (`!canFitAbove`), automatically flip to below!
    if (canFitAbove && !canFitBelow) {
      pushAbove(0);
      pushSides(8);
      pushBelow(20);
    } else if (!canFitAbove && canFitBelow) {
      pushBelow(0);
      pushSides(8);
      pushAbove(20);
    } else if (canFitAbove && canFitBelow) {
      // Both fit: prefer above unless target is in upper quarter near top Share pill
      if (availAbove >= cardHeight + gap + 12) {
        pushAbove(0);
        pushBelow(6);
        pushSides(12);
      } else {
        pushBelow(0);
        pushAbove(6);
        pushSides(12);
      }
    } else {
      // Tight vertical viewport on both sides: try sides first, then whichever vertical side has more room
      pushSides(0);
      if (availBelow >= availAbove) {
        pushBelow(4);
        pushAbove(12);
      } else {
        pushAbove(4);
        pushBelow(12);
      }
    }

    let chosen = candidates[0]!;
    let bestScore = Number.POSITIVE_INFINITY;

    for (const cand of candidates) {
      const box: GuideBoxRect = {
        left: cand.left,
        top: cand.top,
        right: cand.left + cardWidth,
        bottom: cand.top + cardHeight,
      };

      let penalty = cand.priorityBias;
      // Target overlap is unacceptable unless viewport cannot fit otherwise
      if (rectsOverlap(box, targetBox, 8)) {
        penalty += 5000 + intersectionArea(box, targetBox, 8);
      }
      // Cursor pointer + pill overlap
      if (rectsOverlap(box, cursorBox, 8)) {
        penalty += 3000 + intersectionArea(box, cursorBox, 8);
      }
      // Top Screen Share pill overlap
      if (rectsOverlap(box, topPillBox, 6)) {
        penalty += 1500 + intersectionArea(box, topPillBox, 6);
      }
      // Bottom Stop dock overlap
      if (rectsOverlap(box, bottomDockBox, 6)) {
        penalty += 1500 + intersectionArea(box, bottomDockBox, 6);
      }

      if (penalty < bestScore) {
        bestScore = penalty;
        chosen = cand;
      }
    }

    return {
      cursorPos: { x: cursorX, y: cursorY },
      cardLeft: chosen.left,
      cardTop: chosen.top,
      cardWidth,
      placement: chosen.placement,
      hadCollision: bestScore >= 1500,
    };
  }

  // No target spotlight (e.g. ask_user follow-up, completion, navigation, or error):
  const noTargetCandidates = [
    { ...clampCandidate((vw - cardWidth) / 2, cursorBox.bottom + 20, 'below'), priorityBias: 0 },
    {
      ...clampCandidate((vw - cardWidth) / 2, cursorBox.top - cardHeight - 20, 'above'),
      priorityBias: 1,
    },
    { ...clampCandidate(cursorBox.right + 20, cursorY - 20, 'right'), priorityBias: 2 },
    { ...clampCandidate(cursorBox.left - cardWidth - 20, cursorY - 20, 'left'), priorityBias: 3 },
    { ...clampCandidate((vw - cardWidth) / 2, vh * 0.25, 'center'), priorityBias: 4 },
  ];

  let chosen = noTargetCandidates[0]!;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const cand of noTargetCandidates) {
    const box: GuideBoxRect = {
      left: cand.left,
      top: cand.top,
      right: cand.left + cardWidth,
      bottom: cand.top + cardHeight,
    };
    let penalty = cand.priorityBias;
    if (rectsOverlap(box, cursorBox, 8)) penalty += 3000 + intersectionArea(box, cursorBox, 8);
    if (rectsOverlap(box, topPillBox, 6)) penalty += 1500 + intersectionArea(box, topPillBox, 6);
    if (rectsOverlap(box, bottomDockBox, 6)) penalty += 1500 + intersectionArea(box, bottomDockBox, 6);
    if (penalty < bestScore) {
      bestScore = penalty;
      chosen = cand;
    }
  }

  return {
    cursorPos: { x: cursorX, y: cursorY },
    cardLeft: chosen.left,
    cardTop: chosen.top,
    cardWidth,
    placement: chosen.placement,
    hadCollision: bestScore >= 1500,
  };
}
