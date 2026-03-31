/**
 * Schema definition — define node and value types in TypeScript.
 *
 * This is the TS equivalent of Python's @node decorator + atomdoc_schema().
 * Define your document schema, then export it for clients or use it
 * to create a local document.
 *
 * Usage:
 *
 *   const Color = defineValue("Color", {
 *     r: { type: "integer", default: 0 },
 *     g: { type: "integer", default: 0 },
 *     b: { type: "integer", default: 0 },
 *   }, { frozen: true });
 *
 *   const Annotation = defineNode("Annotation", {
 *     label: { type: "string", default: "" },
 *     color: { type: "object", schema: Color, tier: "atomic", default: { r: 0, g: 0, b: 0 } },
 *   });
 *
 *   const Page = defineNode("Page", {
 *     title: { type: "string", default: "" },
 *   }, {
 *     slots: { annotations: "Annotation" },
 *   });
 *
 *   const schema = buildSchema("Page", [Page, Annotation], [Color]);
 */

import type { AtomDocSchema, NodeTypeDef, ValueTypeDef } from "./types.js";

// ---------------------------------------------------------------------------
// Field definition
// ---------------------------------------------------------------------------

export type FieldType =
  | "string"
  | "integer"
  | "number"
  | "boolean"
  | "object"
  | "array";

export interface FieldDef {
  type: FieldType;
  /** Default value for this field. */
  default?: unknown;
  /** Tier: "mergeable" (default), "atomic", or "opaque". */
  tier?: "mergeable" | "atomic" | "opaque";
  /** For object fields: a ValueDef or NodeDef to reference. */
  schema?: ValueDef;
  /** For array fields: item type. */
  items?: FieldDef;
}

// ---------------------------------------------------------------------------
// Value type definition (frozen compound types like Color)
// ---------------------------------------------------------------------------

export interface ValueDef {
  name: string;
  fields: Record<string, FieldDef>;
  frozen: boolean;
}

export function defineValue(
  name: string,
  fields: Record<string, FieldDef>,
  options: { frozen?: boolean } = {},
): ValueDef {
  return {
    name,
    fields,
    frozen: options.frozen ?? true,
  };
}

// ---------------------------------------------------------------------------
// Node type definition
// ---------------------------------------------------------------------------

export interface NodeDef {
  name: string;
  fields: Record<string, FieldDef>;
  slots: Record<string, string | null>;
}

export function defineNode(
  name: string,
  fields: Record<string, FieldDef>,
  options: { slots?: Record<string, string | null> } = {},
): NodeDef {
  return {
    name,
    fields,
    slots: options.slots ?? {},
  };
}

// ---------------------------------------------------------------------------
// Schema builder
// ---------------------------------------------------------------------------

function fieldToJsonSchema(field: FieldDef): Record<string, unknown> {
  const result: Record<string, unknown> = { type: field.type };

  if (field.default !== undefined) {
    result.default = field.default;
  }

  if (field.type === "object" && field.schema) {
    result.properties = {};
    for (const [k, f] of Object.entries(field.schema.fields)) {
      (result.properties as Record<string, unknown>)[k] = fieldToJsonSchema(f);
    }
  }

  if (field.type === "array" && field.items) {
    result.items = fieldToJsonSchema(field.items);
  }

  return result;
}

function nodeDefToTypeDef(node: NodeDef): NodeTypeDef {
  const properties: Record<string, Record<string, unknown>> = {};
  const fieldTiers: Record<string, string> = {};
  const fieldDefaults: Record<string, unknown> = {};

  for (const [name, field] of Object.entries(node.fields)) {
    properties[name] = fieldToJsonSchema(field);
    fieldTiers[name] = field.tier ?? "mergeable";
    if (field.default !== undefined) {
      fieldDefaults[name] = field.default;
    }
  }

  const slots: Record<string, { allowed_type: string | null }> = {};
  for (const [name, allowedType] of Object.entries(node.slots)) {
    slots[name] = { allowed_type: allowedType };
  }

  return {
    json_schema: { type: "object", properties },
    field_tiers: fieldTiers,
    slots,
    field_defaults: fieldDefaults,
  };
}

function valueDefToTypeDef(value: ValueDef): ValueTypeDef {
  const properties: Record<string, Record<string, unknown>> = {};
  for (const [name, field] of Object.entries(value.fields)) {
    properties[name] = fieldToJsonSchema(field);
  }

  return {
    json_schema: { type: "object", properties },
    frozen: value.frozen,
  };
}

/**
 * Build an AtomDocSchema from node and value type definitions.
 *
 * This produces the same schema format as Python's `doc.atomdoc_schema()`.
 */
export function buildSchema(
  rootType: string,
  nodes: NodeDef[],
  values: ValueDef[] = [],
): AtomDocSchema {
  const nodeTypes: Record<string, NodeTypeDef> = {};
  for (const node of nodes) {
    nodeTypes[node.name] = nodeDefToTypeDef(node);
  }

  const valueTypes: Record<string, ValueTypeDef> = {};
  for (const value of values) {
    valueTypes[value.name] = valueDefToTypeDef(value);
  }

  return {
    version: 1,
    root_type: rootType,
    node_types: nodeTypes,
    value_types: valueTypes,
  };
}
