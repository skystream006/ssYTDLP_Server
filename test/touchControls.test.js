import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createServer } from 'vite';

let server;
let controls;

before(async () => {
  server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
  controls = await server.ssrLoadModule('/src/touchControls.js');
});

after(async () => { await server?.close(); });

test('touch dragging recognizes playlist grips, names and song grips but not other controls', () => {
  for (const selector of ['.library-entry-drag', '.library-entry-select', '.song-drag']) {
    const draggable = {};
    const handle = { disabled: false, closest: () => draggable };
    const event = { touches: [{}], target: { closest: (selectors) => selectors.split(', ').includes(selector) ? handle : null } };
    assert.equal(controls.findTouchDraggable(event), draggable);
    handle.disabled = true;
    assert.equal(controls.findTouchDraggable(event), undefined);
    handle.disabled = false;
    handle.closest = () => null;
    assert.equal(controls.findTouchDraggable(event), undefined);
  }
  assert.equal(controls.findTouchDraggable({ touches: [{}], target: { closest: () => null } }), undefined);
  assert.equal(controls.findTouchDraggable({ touches: [{}, {}] }), undefined);
});

test('drop targets accept allowed drags and remove insertion markers when leaving the row', () => {
  const target = { dataset: {}, contains: (element) => element === 'child' };
  let prevented = false;
  let stopped = false;
  const event = { currentTarget: target, dataTransfer: {},
    preventDefault: () => { prevented = true; }, stopPropagation: () => { stopped = true; } };
  controls.allowDrop(event, false);
  assert.equal(prevented, false);
  controls.allowDrop(event, true);
  assert.equal(prevented, true);
  assert.equal(stopped, true);
  assert.equal(event.dataTransfer.dropEffect, 'move');
  assert.equal(target.dataset.dragOver, 'true');
  target.dataset.dropPosition = 'after';
  controls.leaveDrop({ ...event, relatedTarget: 'child' });
  assert.equal(target.dataset.dropPosition, 'after');
  controls.leaveDrop({ ...event, relatedTarget: null });
  assert.deepEqual(target.dataset, {});
});