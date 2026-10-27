/**
 * Drag-and-drop file dropping, extracted from the component so the event
 * sequencing is testable. Every one of these rules is a bug class
 * that has actually shipped somewhere:
 *
 * - `dragover` must be default-prevented, or `drop` never fires at all and
 *   the browser navigates to the dropped file instead.
 * - `dragenter`/`dragleave` must be *counted*, not toggled: each child
 *   element the pointer crosses fires its own pair, so a naive boolean
 *   flickers the active state on and off across the zone's contents.
 * - Leaving the window fires a `dragleave` with a null `relatedTarget` and
 *   no matching `drop`, so the counter has to be zeroed there or the zone
 *   stays lit forever.
 * - A drop that *misses* the zone still has to be cancelled at the window
 *   level, otherwise the browser replaces the page with the file.
 *
 * @param {{
 *   onFiles: (files: FileList | File[]) => void,
 *   onActiveChange: (active: boolean) => void,
 *   onStrayDrop?: () => void,
 * }} options
 */
export function createDropZone({ onFiles, onActiveChange, onStrayDrop }) {
  let depth = 0;
  let active = false;

  /** @param {boolean} next */
  const setActive = (next) => {
    if (next === active) return;
    active = next;
    onActiveChange(active);
  };

  const reset = () => {
    depth = 0;
    setActive(false);
  };

  /** @param {DragEvent} event */
  const hasFiles = (event) =>
    Boolean(event?.dataTransfer?.types?.includes?.("Files"));

  /**
   * dragenter / dragover / dragleave on the zone itself.
   * @param {DragEvent} event
   */
  const handleZoneDrag = (event) => {
    event.preventDefault();
    event.stopPropagation();

    if (!hasFiles(event)) return;

    if (event.type === "dragenter") {
      depth += 1;
      setActive(true);
    } else if (event.type === "dragover") {
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
      setActive(true);
    } else if (event.type === "dragleave") {
      depth = Math.max(0, depth - 1);
      if (depth === 0) setActive(false);
    }
  };

  /**
   * drop on the zone: this is the one that starts an upload.
   * @param {DragEvent} event
   */
  const handleZoneDrop = (event) => {
    event.preventDefault();
    event.stopPropagation();
    reset();
    const files = event.dataTransfer?.files;
    if (files?.length) onFiles(files);
  };

  /** @param {DragEvent} event */
  const handleWindowDragOver = (event) => {
    if (!hasFiles(event)) return;
    // Claim the drag so the drop below is ours to cancel.
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "none";
  };

  /** @param {DragEvent} event */
  const handleWindowDragLeave = (event) => {
    if (event.relatedTarget === null) reset();
  };

  /** @param {DragEvent} event */
  const handleWindowDrop = (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    reset();
    onStrayDrop?.();
  };

  return {
    handleZoneDrag,
    handleZoneDrop,
    handleWindowDragOver,
    handleWindowDragLeave,
    handleWindowDrop,
    reset,
  };
}
