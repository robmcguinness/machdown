import { z } from 'zod';

/** Any value `JSON.parse` can produce. Named so a boundary reader never has to say `unknown`. */
export type Json = boolean | number | string | null | readonly Json[] | JsonObject;

export type JsonObject = { readonly [key: string]: Json };

export const JsonSchema: z.ZodType<Json> = z.lazy(() =>
  z.union([
    z.boolean(),
    z.number(),
    z.string(),
    z.null(),
    z.array(JsonSchema),
    z.record(z.string(), JsonSchema),
  ]),
);

/** A type guard, not a bare `typeof`: the object branch of `Json`, not `Array` or `null`. */
export const isJsonObject = (value: Json): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
