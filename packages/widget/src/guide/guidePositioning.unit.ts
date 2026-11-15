import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeGuideCursorLayout, rectsOverlap } from './guidePositioning.ts';

describe('GuideCursor Dynamic Collision & Auto-Flip Layout', () => {
  const viewport = { width: 1280, height: 720 };
  const cardSize = { width: 320, height: 170 };

  it('places the tooltip card above the target when sufficient vertical space exists', () => {
    const targetRect = {
      left: 460,
      top: 340,
      right: 760,
      bottom: 388,
      width: 300,
      height: 48,
    };

    const res = computeGuideCursorLayout({
      targetRect,
      cardSize,
      viewport,
      appName: 'Khazna',
    });

    assert.equal(res.placement, 'above');
    assert.ok(res.cardTop + cardSize.height <= targetRect.top, 'Card should sit cleanly above target');
    assert.equal(res.hadCollision, false);

    const cardBox = {
      left: res.cardLeft,
      top: res.cardTop,
      right: res.cardLeft + res.cardWidth,
      bottom: res.cardTop + cardSize.height,
    };
    assert.equal(rectsOverlap(cardBox, targetRect, 4), false);
  });

  it('automatically flips tooltip from above to below when scrolling target near the top of viewport', () => {
    const targetNearTop = {
      left: 460,
      top: 78,
      right: 760,
      bottom: 124,
      width: 300,
      height: 46,
    };

    const res = computeGuideCursorLayout({
      targetRect: targetNearTop,
      cardSize,
      viewport,
      appName: 'Khazna',
    });

    assert.equal(res.placement, 'below');
    assert.ok(res.cardTop >= targetNearTop.bottom, 'Card should flip below target when vertical space above is insufficient');
    assert.equal(res.hadCollision, false);
  });

  it('automatically flips tooltip from below back to above when target sits near the bottom dock', () => {
    const targetNearBottom = {
      left: 460,
      top: 560,
      right: 760,
      bottom: 606,
      width: 300,
      height: 46,
    };

    const res = computeGuideCursorLayout({
      targetRect: targetNearBottom,
      cardSize,
      viewport,
      appName: 'Khazna',
    });

    assert.equal(res.placement, 'above');
    assert.ok(res.cardTop + cardSize.height <= targetNearBottom.top);
    assert.equal(res.hadCollision, false);
  });

  it('clamps the agent cursor pointer and app pill inside the viewport near right/bottom edges', () => {
    const targetAtRightEdge = {
      left: 1180,
      top: 640,
      right: 1272,
      bottom: 684,
      width: 92,
      height: 44,
    };

    const res = computeGuideCursorLayout({
      targetRect: targetAtRightEdge,
      cardSize,
      viewport,
      appName: 'Khazna Campus',
    });

    assert.ok(res.cursorPos.x <= viewport.width - 120, `Expected clamped cursor X, got ${res.cursorPos.x}`);
    assert.ok(res.cursorPos.y <= viewport.height - 110, `Expected clamped cursor Y, got ${res.cursorPos.y}`);
  });
});
