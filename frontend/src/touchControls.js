import dragDrop from 'mobile-drag-drop';
import scroll from 'mobile-drag-drop/scroll-behaviour.js';
import 'mobile-drag-drop/default.css';

export function findTouchDraggable(event) {
  if (event.touches.length !== 1) return;
  const handle = event.target.closest('.song-drag, .library-entry-select');
  const draggable = handle?.closest('[draggable="true"]');
  return handle && !handle.disabled ? draggable || undefined : undefined;
}

export function allowDrop(event, allowed) {
  if (!allowed) return;
  event.preventDefault();
  event.stopPropagation();
  event.dataTransfer.dropEffect = 'move';
  event.currentTarget.dataset.dragOver = 'true';
}

export function leaveDrop(event) {
  if (!event.currentTarget.contains(event.relatedTarget)) delete event.currentTarget.dataset.dragOver;
}

export function initializeTouchControls() {
  dragDrop.polyfill({
    forceApply: true,
    holdToDrag: 300,
    tryFindDraggableTarget: findTouchDraggable,
    dragImageTranslateOverride: scroll.scrollBehaviourDragImageTranslateOverride
  });
  window.addEventListener('touchmove', () => {}, { passive: false });
  const clearDrag = () => {
    document.querySelectorAll('[data-drag-over], [data-dragging]').forEach((element) => {
      delete element.dataset.dragOver;
      delete element.dataset.dragging;
    });
  };
  document.addEventListener('dragend', clearDrag);
  document.addEventListener('drop', clearDrag);
  document.addEventListener('touchcancel', clearDrag);
}