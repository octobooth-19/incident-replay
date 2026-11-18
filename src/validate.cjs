'use strict';

const eventSchema = require('./schemas/event.schema.json');
const hypothesisSchema = require('./schemas/hypothesis.schema.json');
const analysisSchema = require('./schemas/analysis.schema.json');

const typeChecks = {
  object: (value) => value !== null && typeof value === 'object' && !Array.isArray(value),
  array: Array.isArray,
  string: (value) => typeof value === 'string',
  number: Number.isFinite,
};

// Implements only the keywords used by the repository's schemas.
function check(schema, value, path, errors) {
  if (schema.$ref === 'hypothesis.schema.json') schema = hypothesisSchema;
  const report = (message) => errors.push(`${path}: ${message}`);
  if (!typeChecks[schema.type](value)) {
    report(`must be of type ${schema.type}`);
    return;
  }

  if (schema.type === 'object') {
    for (const key of schema.required) {
      if (!Object.hasOwn(value, key)) errors.push(`${path}.${key}: is required`);
    }
    for (const [key, property] of Object.entries(schema.properties)) {
      if (Object.hasOwn(value, key)) check(property, value[key], `${path}.${key}`, errors);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(schema.properties, key)) {
          errors.push(`${path}.${key}: is not allowed`);
        }
      }
    }
  } else if (schema.type === 'array') {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      report(`must contain at least ${schema.minItems} item(s)`);
    }
    if (schema.uniqueItems && new Set(value).size !== value.length) report('must contain unique items');
    for (const [index, item] of value.entries()) {
      check(schema.items, item, `${path}[${index}]`, errors);
    }
  } else if (schema.type === 'number') {
    if (value < schema.minimum || value > schema.maximum) {
      report(`must be between ${schema.minimum} and ${schema.maximum}`);
    }
  } else if (schema.type === 'string') {
    if (schema.minLength !== undefined && [...value].length < schema.minLength) {
      report(`must contain at least ${schema.minLength} character(s)`);
    }
    if (schema.enum && !schema.enum.includes(value)) report(`must be one of ${schema.enum.join(', ')}`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
      report('must be a UTC timestamp (YYYY-MM-DDTHH:mm:ss[.fraction]Z)');
    } else if (schema.format === 'date-time') {
      const date = new Date(value);
      // Date can normalize an impossible day into the next month.
      if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 19) !== value.slice(0, 19)) {
        report('must be a real calendar date and time');
      }
    }
  }
}

function validate(schema, value) {
  const errors = [];
  check(schema, value, '$', errors);
  return { valid: errors.length === 0, errors };
}

module.exports = {
  validateEvent: (value) => validate(eventSchema, value),
  validateHypothesis: (value) => validate(hypothesisSchema, value),
  validateAnalysis: (value) => validate(analysisSchema, value),
};
