// Web test setup: clean up after each test, and give jsdom what Recharts needs. jsdom has no
// layout, so ResponsiveContainer would measure a width of 0 and draw nothing: the stub below
// reports a fixed 600 x 300 box as soon as an element is observed.
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

export const CHART_BOX = { width: 600, height: 300 };

class FixedResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}
  observe(target: Element) {
    const entry = {
      target,
      contentRect: { ...CHART_BOX, x: 0, y: 0, top: 0, left: 0, right: CHART_BOX.width, bottom: CHART_BOX.height },
    } as unknown as ResizeObserverEntry;
    this.callback([entry], this as unknown as ResizeObserver);
  }
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = FixedResizeObserver as unknown as typeof ResizeObserver;

afterEach(() => {
  cleanup();
  // The tests of files and configuration run in the node environment: no storage there.
  if (typeof sessionStorage !== "undefined") {
    sessionStorage.clear();
    localStorage.clear();
  }
});
