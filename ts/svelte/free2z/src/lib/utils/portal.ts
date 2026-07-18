// Simple portal action that mounts the node under document.body
// On destroy, do NOT move the node back to the placeholder; Svelte is tearing it down.
// Just remove the portaled node from its parent and clean up the placeholder.
export function portal(node: HTMLElement) {
  if (typeof document === 'undefined') return {} as any;

  const target = document.body;
  const placeholder = document.createComment('portal-anchor');

  // Insert a placeholder where the node currently is and move to body
  node.parentNode?.insertBefore(placeholder, node);
  target.appendChild(node);

  // Debug: mark node for easier inspection
  try {
    node.setAttribute('data-portaled', 'true');
  } catch {}

  return {
    destroy() {
      // Remove the portaled node from DOM if it still exists
      try {
        if (node.parentNode) {
          node.parentNode.removeChild(node);
        }
      } catch {}
      // Remove placeholder
      try {
        placeholder.remove();
      } catch {}
    },
  } as any;
}
