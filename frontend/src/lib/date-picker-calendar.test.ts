import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildCalendarWeeks,
  defaultCustomDateRange,
  formatCalendarDisplay,
  isCalendarDayDisabled,
  isCalendarMonthOutOfBounds,
  parseCalendarDate,
  resolveCalendarMonth,
} from './date-picker-calendar';

describe('report date picker calendar', () => {
  it('builds whole weeks that start on Monday', () => {
    const weeks = buildCalendarWeeks(new Date(2026, 7, 1));
    assert.equal(weeks[0].length, 7);
    assert.equal(weeks[0][0].getDay(), 1);
    assert.ok(weeks.flat().some((day) => day.getMonth() === 7 && day.getDate() === 1));
  });

  it('pads the grid with neighbouring days so no row is short', () => {
    for (const month of [new Date(2026, 1, 1), new Date(2027, 1, 1), new Date(2026, 10, 1)]) {
      assert.ok(buildCalendarWeeks(month).every((week) => week.length === 7));
    }
  });

  it('rejects a date string that is not a real day', () => {
    assert.equal(parseCalendarDate('2026-02-30'), null);
    assert.equal(parseCalendarDate(''), null);
    assert.equal(parseCalendarDate('not-a-date'), null);
  });

  it('shows a chosen day in a form no locale can misread', () => {
    assert.equal(formatCalendarDisplay('2026-08-24'), '24 Aug 2026');
    assert.equal(formatCalendarDisplay(''), null);
  });

  it('disables days outside the inclusive bounds', () => {
    const bounds = { min: '2026-08-10', max: '2026-08-20' };
    assert.equal(isCalendarDayDisabled(new Date(2026, 7, 9), bounds), true);
    assert.equal(isCalendarDayDisabled(new Date(2026, 7, 10), bounds), false);
    assert.equal(isCalendarDayDisabled(new Date(2026, 7, 20), bounds), false);
    assert.equal(isCalendarDayDisabled(new Date(2026, 7, 21), bounds), true);
  });

  it('stops paging past a month that holds no allowed day', () => {
    const bounds = { max: '2026-08-24' };
    assert.equal(isCalendarMonthOutOfBounds(new Date(2026, 7, 1), 1, bounds), true);
    assert.equal(isCalendarMonthOutOfBounds(new Date(2026, 6, 1), 1, bounds), false);
    assert.equal(isCalendarMonthOutOfBounds(new Date(2026, 7, 1), -1, {}), false);
  });

  it('opens on the chosen month, and otherwise on the nearest allowed one', () => {
    const today = new Date(2026, 7, 24);
    assert.equal(resolveCalendarMonth('2026-03-05', {}, today).getMonth(), 2);
    assert.equal(resolveCalendarMonth('', { max: '2026-05-31' }, today).getMonth(), 4);
    assert.equal(resolveCalendarMonth('', {}, today).getMonth(), 7);
  });

  it('offers the last thirty days when a custom period starts empty', () => {
    const range = defaultCustomDateRange(new Date(2026, 7, 24, 13, 45));
    assert.deepEqual(range, { start: '2026-07-26', end: '2026-08-24' });
  });
});
