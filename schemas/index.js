'use strict';

const seller = require('./seller');
const expert = require('./expert');
const agency = require('./agency');

const SCHEMAS = { seller, expert, agency };

function getSchema(briefType) {
  return SCHEMAS[briefType] || null;
}

// Валидный whitelist полей для конкретного типа — все name из всех fields,
// плюс служебные ключи (_other, channels-row).
function getFieldNames(briefType) {
  const schema = SCHEMAS[briefType];
  if (!schema) return [];
  const names = new Set();
  walk(schema.steps, (f) => {
    if (f.name) names.add(f.name);
  });
  return [...names];
}

function walk(steps, cb) {
  for (const step of steps) {
    walkFields(step.fields || [], cb);
  }
}

function walkFields(fields, cb) {
  for (const f of fields) {
    if (f.kind === 'group') {
      walkFields(f.fields || [], cb);
      continue;
    }
    cb(f);
  }
}

module.exports = { SCHEMAS, getSchema, getFieldNames };
