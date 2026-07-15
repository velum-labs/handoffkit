/**
 * RFC 8785 (JSON Canonicalization Scheme) subset for protocol objects: members
 * sorted by UTF-16 code units, ES number serialization, and no insignificant
 * whitespace.
 */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export function canonicalize(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number": {
      if (!Number.isFinite(value)) {
        throw new Error("non-finite numbers are not representable in JCS");
      }
      return JSON.stringify(value);
    }
    case "string":
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) {
        return `[${value.map((item) => canonicalize(item === undefined ? null : item)).join(",")}]`;
      }
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record)
        .filter((key) => record[key] !== undefined)
        .sort();
      const members = keys.map(
        (key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`
      );
      return `{${members.join(",")}}`;
    }
    case "undefined":
    case "function":
    case "symbol":
    case "bigint":
      throw new Error(`type ${typeof value} is not representable in JCS`);
    default: {
      const exhausted: never = typeof value as never;
      throw new Error(`unreachable: ${String(exhausted)}`);
    }
  }
}
