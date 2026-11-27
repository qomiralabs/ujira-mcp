// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Qomira Labs

// Long tables draw only the rows in view, plus a few either side, with
// spacers above and below that keep the scrollbar true to the whole list.
// Rows are one line each, so they share one height; the hook measures a real
// row so the spacers stay exact at any font size.

import { useCallback, useLayoutEffect, useState, type RefObject } from 'react';

export interface RowWindow {
  /** The first row drawn. */
  readonly start: number;
  /** One past the last row drawn. */
  readonly end: number;
  readonly padTop: number;
  readonly padBottom: number;
}

// Before the first layout, or where there is no layout at all, plan for a
// tall screen so the first paint is never short of rows.
const FALLBACK_VIEWPORT = 900;

/** Which rows to draw for a scroll position. */
export function windowOf(
  count: number,
  scrollTop: number,
  viewport: number,
  rowHeight: number,
  overscan: number,
): RowWindow {
  if (count <= 0 || rowHeight <= 0) return { start: 0, end: 0, padTop: 0, padBottom: 0 };
  const height = viewport > 0 ? viewport : FALLBACK_VIEWPORT;
  const top = Math.max(0, scrollTop);
  const first = Math.min(count - 1, Math.floor(top / rowHeight));
  const start = Math.max(0, first - overscan);
  const end = Math.min(count, Math.ceil((top + height) / rowHeight) + overscan);
  return { start, end, padTop: start * rowHeight, padBottom: (count - end) * rowHeight };
}

export function useVirtualRows(
  count: number,
  scroller: RefObject<HTMLElement | null>,
  { estimate, overscan = 8 }: { estimate: number; overscan?: number },
): RowWindow & { measure: (row: HTMLElement | null) => void } {
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(0);
  const [rowHeight, setRowHeight] = useState(estimate);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el === null) return;
    let frame = 0;
    const read = () => {
      frame = 0;
      setScrollTop(el.scrollTop);
    };
    // One state update per frame however fast the wheel turns.
    const onScroll = () => {
      if (typeof requestAnimationFrame !== 'function') {
        read();
        return;
      }
      if (frame === 0) frame = requestAnimationFrame(read);
    };
    const onResize = () => {
      setViewport(el.clientHeight);
    };
    onResize();
    setScrollTop(el.scrollTop);
    el.addEventListener('scroll', onScroll, { passive: true });
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(onResize) : null;
    observer?.observe(el);
    return () => {
      el.removeEventListener('scroll', onScroll);
      observer?.disconnect();
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  }, [scroller]);

  const measure = useCallback((row: HTMLElement | null) => {
    if (row === null) return;
    const h = row.getBoundingClientRect().height;
    if (h > 0) setRowHeight((old) => (Math.abs(old - h) > 0.25 ? h : old));
  }, []);

  return { ...windowOf(count, scrollTop, viewport, rowHeight, overscan), measure };
}
