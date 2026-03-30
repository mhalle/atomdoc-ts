/**
 * Schema registry — hydrates the atomdoc schema into Zod validators.
 */

import { z } from "zod";
import type { AtomDocSchema, NodeTypeDef, ValueTypeDef } from "./types.js";

export class SchemaRegistry {
  private nodeTypes: Map<string, NodeTypeDef>;
  private valueTypes: Map<string, ValueTypeDef>;
  private zodSchemas = new Map<string, z.ZodType>();

  constructor(schema: AtomDocSchema) {
    this.nodeTypes = new Map(Object.entries(schema.node_types));
    this.valueTypes = new Map(Object.entries(schema.value_types));
  }

  getNodeType(name: string): NodeTypeDef | undefined {
    return this.nodeTypes.get(name);
  }

  getValueType(name: string): ValueTypeDef | undefined {
    return this.valueTypes.get(name);
  }

  getFieldTier(
    nodeType: string,
    field: string,
  ): string | undefined {
    return this.nodeTypes.get(nodeType)?.field_tiers[field];
  }

  getSlots(
    nodeType: string,
  ): Record<string, { allowed_type: string | null }> {
    return this.nodeTypes.get(nodeType)?.slots ?? {};
  }

  getDefaults(nodeType: string): Record<string, unknown> {
    return this.nodeTypes.get(nodeType)?.field_defaults ?? {};
  }

  /** Get or build a Zod schema for a node or value type. */
  getZodSchema(typeName: string): z.ZodType | undefined {
    const cached = this.zodSchemas.get(typeName);
    if (cached) return cached;

    const nodeDef = this.nodeTypes.get(typeName);
    if (nodeDef) {
      const schema = jsonSchemaToZod(nodeDef.json_schema);
      this.zodSchemas.set(typeName, schema);
      return schema;
    }

    const valueDef = this.valueTypes.get(typeName);
    if (valueDef) {
      const schema = jsonSchemaToZod(valueDef.json_schema);
      const frozen = valueDef.frozen ? schema.readonly() : schema;
      this.zodSchemas.set(typeName, frozen);
      return frozen;
    }

    return undefined;
  }

  /** Validate data against a named type's schema. */
  validate(typeName: string, data: unknown): unknown {
    const schema = this.getZodSchema(typeName);
    if (!schema) {
      throw new Error(`Unknown type: ${typeName}`);
    }
    return schema.parse(data);
  }

  /** List all node type names. */
  nodeTypeNames(): string[] {
    return [...this.nodeTypes.keys()];
  }

  /** List all value type names. */
  valueTypeNames(): string[] {
    return [...this.valueTypes.keys()];
  }
}

/**
 * Convert a JSON Schema object (the subset atomdoc uses) to a Zod schema.
 *
 * Supports: object with properties, string, number/integer, boolean,
 * arrays of primitives, nested objects, and defaults.
 */
function jsonSchemaToZod(jsonSchema: Record<string, unknown>): z.ZodType {
  const type = jsonSchema.type as string | undefined;

  if (type === "string") {
    let s: z.ZodType = z.string();
    if ("default" in jsonSchema) s = (s as z.ZodString).default(jsonSchema.default as string);
    return s;
  }
  if (type === "integer") {
    let n: z.ZodType = z.number().int();
    if ("default" in jsonSchema) n = (n as z.ZodNumber).default(jsonSchema.default as number);
    return n;
  }
  if (type === "number") {
    let n: z.ZodType = z.number();
    if ("default" in jsonSchema) n = (n as z.ZodNumber).default(jsonSchema.default as number);
    return n;
  }
  if (type === "boolean") {
    let b: z.ZodType = z.boolean();
    if ("default" in jsonSchema) b = (b as z.ZodBoolean).default(jsonSchema.default as boolean);
    return b;
  }
  if (type === "array") {
    const items = (jsonSchema.items ?? {}) as Record<string, unknown>;
    return z.array(jsonSchemaToZod(items));
  }
  if (type === "object" || jsonSchema.properties) {
    const properties = (jsonSchema.properties ?? {}) as Record<
      string,
      Record<string, unknown>
    >;
    const shape: Record<string, z.ZodType> = {};
    for (const [key, propSchema] of Object.entries(properties)) {
      shape[key] = jsonSchemaToZod(propSchema);
    }
    return z.object(shape);
  }

  // Fallback: accept anything
  return z.unknown();
}
