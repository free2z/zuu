import React from "react";
import { createRoot } from "react-dom/client";
import DyteCreator from "../../src/components/DyteCreator";
import DyteLeave from "../../src/components/DyteLeave";

const listeners = new Map();
window.rtkContract = {
  navigate: [],
  leaves: 0,
  emit(event, payload) {
    listeners.get(event)?.forEach((fn) => fn(payload));
  },
  meeting: {
    self: {
      on(event, fn) {
        if (!listeners.has(event)) listeners.set(event, new Set());
        listeners.get(event).add(fn);
      },
      removeListener(event, fn) {
        listeners.get(event)?.delete(fn);
      },
    },
    async leave() {
      window.rtkContract.leaves++;
    },
  },
};
window.mountRtk = () => {
  window.rtkRoot = createRoot(document.getElementById("root"));
  window.rtkRoot.render(
    <>
      <DyteCreator />
      <DyteLeave />
    </>
  );
};
window.mountRtk();
