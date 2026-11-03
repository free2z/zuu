let preloadPromise: Promise<void> | undefined;

/** Load the custom-element registry and the rtk-meeting component while the
 * viewer's admission request is in flight. Stencil otherwise waits until the
 * element is mounted before fetching the component entry and its dependencies.
 */
export function preloadRtkMeeting(): Promise<void> {
  if (!preloadPromise) {
    const pending = Promise.all([
      import("@cloudflare/realtimekit-ui/loader"),
      import("@cloudflare/realtimekit-ui/components/rtk-meeting"),
    ]).then(([loader]) => {
      loader.defineCustomElements();
    });
    const retryable = pending.catch((error: unknown) => {
      if (preloadPromise === retryable) {
        preloadPromise = undefined;
      }
      throw error;
    });
    preloadPromise = retryable;
  }
  return preloadPromise;
}

export function markStreamPerformance(name: string): void {
  if (typeof performance !== "undefined" && performance.mark) {
    performance.mark(`stream:${name}`);
  }
}

/** Resolve when the first video rendered inside rtk-meeting submits a frame. */
export function observeFirstRtkVideoFrame(
  root: ParentNode,
  onFrame: () => void,
): () => void {
  if (typeof MutationObserver === "undefined") return () => {};

  let finished = false;
  const observedRoots = new WeakSet<Node>();
  const observedVideos = new WeakSet<HTMLVideoElement>();
  const observers: MutationObserver[] = [];

  const scan = (root: ParentNode) => {
    for (const element of root.querySelectorAll("*")) {
      if (element instanceof HTMLVideoElement && !observedVideos.has(element)) {
        observedVideos.add(element);
        if (typeof element.requestVideoFrameCallback === "function") {
          element.requestVideoFrameCallback(() => {
            if (finished) return;
            finished = true;
            onFrame();
            stop();
          });
        }
      }
      if (element.shadowRoot) watch(element.shadowRoot);
    }
  };

  const watch = (root: ParentNode) => {
    if (observedRoots.has(root)) return;
    observedRoots.add(root);
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node instanceof Element) {
            if (
              node.matches("video") &&
              !observedVideos.has(node as HTMLVideoElement)
            ) {
              scan(node.parentNode ?? root);
            } else {
              scan(node);
            }
          }
        }
      }
    });
    if (root instanceof Node) {
      observer.observe(root, { childList: true, subtree: true });
    }
    observers.push(observer);
    scan(root);
  };

  const stop = () => {
    finished = true;
    for (const observer of observers) observer.disconnect();
    observers.length = 0;
  };

  watch(root);
  return stop;
}
