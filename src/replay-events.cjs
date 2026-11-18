'use strict';

const { validateEvent } = require('./validate.cjs');

function assertEvents(events) {
  if (!Array.isArray(events)) throw new TypeError('Expected an array of Events');
  const ids = new Set();
  for (const [index, event] of events.entries()) {
    if (!validateEvent(event).valid) throw new TypeError(`Invalid Event at record ${index + 1}`);
    if (ids.has(event.id)) throw new TypeError(`Duplicate Event ID at record ${index + 1}`);
    ids.add(event.id);
  }
}

function compareStrings(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

module.exports = { assertEvents, compareStrings };
