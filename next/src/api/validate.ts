/**
 * A small JSON Schema validator for the subset tool schemas use: object with
 * properties/required/additionalProperties (a boolean, or a schema every
 * undeclared value must match), string/number/integer/boolean, enum, arrays
 * with items, minimum/maximum, oneOf-free. Zero dependencies.
 *
 * Property lookups are own-property only, and the prototype-named keys
 * `__proto__`, `constructor` and `prototype` are refused in every object — the
 * ones the schema walks and, inside values it does not describe, the ones it
 * would not have looked into — so nothing inherited from Object.prototype can
 * pass as a declared parameter.
 */
import { distance } from '../core/keys.js';

export interface Schema {
  type?: 'object' | 'string' | 'number' | 'integer' | 'boolean' | 'array';
  description?: string;
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: boolean | Schema;
  enum?: Array<string | number | boolean>;
  items?: Schema;
  minimum?: number;
  maximum?: number;
  minLength?: number;
}

export class ValidationError extends Error {
  constructor(public readonly path: string, message: string) {
    super(`${path || '$'}: ${message}`);
    this.name = 'ValidationError';
  }
}

/** Keys that name Object.prototype machinery; never a parameter, anywhere. */
const RESERVED_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

const own = <T>(o: Record<string, T> | undefined, key: string): T | undefined => (o !== undefined && Object.hasOwn(o, key) ? o[key] : undefined);

/**
 * Why `key` is not a parameter: the declared names within a small edit distance (`wiat` →
 * `wait`), or all of them, the way an unknown key name is answered (the house's read of 1cabc6a, #22).
 */
function unknownKey(key: string, properties: Record<string, Schema> | undefined): string {
  const names = Object.keys(properties ?? {});
  const k = key.toLowerCase();
  const close = names.filter((n) => distance(k, n.toLowerCase()) <= (n.length >= 4 ? 2 : 1)).slice(0, 3);
  if (close.length) return `is not a known parameter; did you mean ${close.map((c) => `\`${c}\``).join(' or ')}?`;
  return names.length ? `is not a known parameter; the parameters are ${names.join(', ')}` : 'is not a known parameter; this tool takes none';
}

/** Reserved names refused inside a value the schema does not describe (an array, a nested object). */
function rejectReserved(value: unknown, path: string): void {
  if (Array.isArray(value)) value.forEach((v, i) => rejectReserved(v, `${path}[${i}]`));
  else if (typeof value === 'object' && value !== null) {
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (RESERVED_KEYS.has(key)) throw new ValidationError(`${path}.${key}`, 'is a reserved name');
      rejectReserved(v, `${path}.${key}`);
    }
  }
}

export function validate(value: unknown, schema: Schema, path = ''): void {
  if (schema.enum && !schema.enum.includes(value as string)) throw new ValidationError(path, `must be one of ${schema.enum.map(String).join(', ')}`);
  switch (schema.type) {
    case 'object': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new ValidationError(path, 'must be an object');
      const obj = value as Record<string, unknown>;
      for (const key of schema.required ?? []) if (!Object.hasOwn(obj, key)) throw new ValidationError(`${path}.${key}`, 'is required');
      for (const [key, v] of Object.entries(obj)) {
        if (RESERVED_KEYS.has(key)) throw new ValidationError(`${path}.${key}`, 'is a reserved name');
        const sub = own(schema.properties, key);
        if (!sub) {
          const extra = schema.additionalProperties;
          if (extra === false) throw new ValidationError(`${path}.${key}`, unknownKey(key, schema.properties));
          if (typeof extra === 'object' && v !== undefined) validate(v, extra, `${path}.${key}`);
          else rejectReserved(v, `${path}.${key}`);
          continue;
        }
        if (v !== undefined) validate(v, sub, `${path}.${key}`);
      }
      return;
    }
    case 'string':
      if (typeof value !== 'string') throw new ValidationError(path, 'must be a string');
      if (schema.minLength !== undefined && value.length < schema.minLength) throw new ValidationError(path, `must be at least ${schema.minLength} characters`);
      return;
    case 'number':
    case 'integer':
      if (typeof value !== 'number' || Number.isNaN(value)) throw new ValidationError(path, 'must be a number');
      if (schema.type === 'integer' && !Number.isInteger(value)) throw new ValidationError(path, 'must be an integer');
      if (schema.minimum !== undefined && value < schema.minimum) throw new ValidationError(path, `must be >= ${schema.minimum}`);
      if (schema.maximum !== undefined && value > schema.maximum) throw new ValidationError(path, `must be <= ${schema.maximum}`);
      return;
    case 'boolean':
      if (typeof value !== 'boolean') throw new ValidationError(path, 'must be a boolean');
      return;
    case 'array':
      if (!Array.isArray(value)) throw new ValidationError(path, 'must be an array');
      if (schema.items) value.forEach((v, i) => validate(v, schema.items!, `${path}[${i}]`));
      else rejectReserved(value, path);
      return;
    default:
      // A value the schema leaves undescribed is still no place for a reserved name.
      rejectReserved(value, path);
      return;
  }
}
