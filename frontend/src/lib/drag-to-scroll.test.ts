import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { setTimeout as nextTask } from 'node:timers/promises';
import { attachDragToScroll } from './drag-to-scroll';

class ScrollElement extends EventTarget {
  scrollWidth = 1000;
  clientWidth = 500;
  scrollLeft = 0;
  interactive = false;
  closest() {
    return this.interactive ? this : null;
  }
}

let element: ScrollElement;
let documentTarget: EventTarget;
let dragging: boolean;
let detach: () => void;
const originalGlobals = ['document', 'Element', 'HTMLTableRowElement'].map((name) => ({
  name,
  descriptor: Object.getOwnPropertyDescriptor(globalThis, name),
}));

beforeEach(() => {
  documentTarget = new EventTarget();
  element = new ScrollElement();
  dragging = false;
  Object.defineProperty(globalThis, 'document', { configurable: true, value: documentTarget });
  Object.defineProperty(globalThis, 'Element', { configurable: true, value: ScrollElement });
  Object.defineProperty(globalThis, 'HTMLTableRowElement', {
    configurable: true,
    value: class extends ScrollElement {},
  });
  detach = attachDragToScroll(element as unknown as HTMLElement, (value) => {
    dragging = value;
  });
});

afterEach(() => {
  detach();
  for (const { name, descriptor } of originalGlobals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

function pointer(target: EventTarget, type: string, pageX: number, pageY = 0) {
  target.dispatchEvent(
    Object.assign(new Event(type, { cancelable: true }), {
      pointerId: 1,
      pointerType: 'mouse',
      button: 0,
      pageX,
      pageY,
    }),
  );
}

function click() {
  const event = Object.assign(new Event('click', { cancelable: true }), { detail: 1 });
  element.dispatchEvent(event);
  return event;
}

function startDrag() {
  pointer(element, 'pointerdown', 300);
  pointer(documentTarget, 'pointermove', 100);
  assert.equal(element.scrollLeft, 200);
  assert.equal(dragging, true);
}

test('a completed drag suppresses its own click but not the next click', () => {
  startDrag();
  pointer(documentTarget, 'pointerup', 100);
  assert.equal(dragging, false);
  assert.equal(click().defaultPrevented, true);
  assert.equal(click().defaultPrevented, false);
});

test('release outside the table does not suppress a later action click', async () => {
  startDrag();
  pointer(documentTarget, 'pointerup', 100);
  // The release outside has no click on this element during the current task.
  await nextTask(10);
  assert.equal(click().defaultPrevented, false);
});

test('pointer cancellation does not suppress an unrelated action click', () => {
  startDrag();
  pointer(documentTarget, 'pointercancel', 100);
  assert.equal(click().defaultPrevented, false);
});

test('detaching removes pending click suppression', () => {
  startDrag();
  pointer(documentTarget, 'pointerup', 100);
  detach();
  assert.equal(click().defaultPrevented, false);
});

test('movement below the drag threshold preserves row activation', () => {
  pointer(element, 'pointerdown', 300);
  pointer(documentTarget, 'pointermove', 298);
  pointer(documentTarget, 'pointerup', 298);
  assert.equal(element.scrollLeft, 0);
  assert.equal(click().defaultPrevented, false);
});

test('vertical gestures preserve native scrolling and row activation', () => {
  pointer(element, 'pointerdown', 300);
  pointer(documentTarget, 'pointermove', 298, 30);
  pointer(documentTarget, 'pointermove', 100, 30);
  pointer(documentTarget, 'pointerup', 100, 30);
  assert.equal(element.scrollLeft, 0);
  assert.equal(click().defaultPrevented, false);
});

test('interactive controls never start a table drag', () => {
  element.interactive = true;
  pointer(element, 'pointerdown', 300);
  pointer(documentTarget, 'pointermove', 100);
  pointer(documentTarget, 'pointerup', 100);
  assert.equal(element.scrollLeft, 0);
  assert.equal(dragging, false);
  assert.equal(click().defaultPrevented, false);
});

test('a new pointer gesture clears suppression from an outside release immediately', () => {
  startDrag();
  pointer(documentTarget, 'pointerup', 100);
  element.interactive = true;
  pointer(element, 'pointerdown', 300);
  assert.equal(click().defaultPrevented, false);
});

test('a table without horizontal overflow keeps native behavior', () => {
  element.scrollWidth = element.clientWidth;
  pointer(element, 'pointerdown', 300);
  pointer(documentTarget, 'pointermove', 100);
  pointer(documentTarget, 'pointerup', 100);
  assert.equal(element.scrollLeft, 0);
  assert.equal(click().defaultPrevented, false);
});
