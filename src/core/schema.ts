import { z } from 'zod';
import { LIMITS } from './limits';
import type { ProjectV1 } from './types';

const finite = z.number().finite();

// XML 1.0 Char production: #x9 | #xA | #xD | [#x20-#xD7FF] | [#xE000-#xFFFD] |
// [#x10000-#x10FFFF]. Rejects C0/C1 controls (except tab/LF/CR), lone
// surrogates, and the noncharacters U+FFFE/U+FFFF while preserving the rest
// of Unicode, including supplementary planes.
export function isXml10Text(text: string): boolean {
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    const allowed =
      cp === 0x09 ||
      cp === 0x0a ||
      cp === 0x0d ||
      (cp >= 0x20 && cp <= 0xd7ff) ||
      (cp >= 0xe000 && cp <= 0xfffd) ||
      (cp >= 0x10000 && cp <= 0x10ffff);
    if (!allowed) return false;
  }
  return true;
}

const titleSchema = z
  .string()
  .max(LIMITS.titleMaxLength)
  .refine(isXml10Text, 'title contains characters outside the XML 1.0 range');

const vec2Schema = z.tuple([finite, finite]);
const vec3Schema = z.tuple([finite, finite, finite]);
const mat3Schema = z.tuple([
  finite, finite, finite,
  finite, finite, finite,
  finite, finite, finite,
]);

const displayUnitSchema = z.enum(['mm', 'cm', 'in']);
const surfaceIdSchema = z.enum(['A', 'B', 'C']);

const cornerSchema = z.object({
  kind: z.literal('interior-corner'),
  panelA: z.object({ widthMm: finite, heightMm: finite }),
  panelB: z.object({ widthMm: finite, heightMm: finite }),
  angleDeg: finite,
  includeBase: z.boolean(),
  angleMeasurement: z
    .object({
      method: z.literal('tape-triangle'),
      offsetAMm: finite,
      offsetBMm: finite,
      chordMm: finite,
      measurementHeightMm: finite,
    })
    .optional(),
});

const viewpointSchema = z.object({
  eyeMm: vec3Schema,
  aimHeightMm: finite,
});

const artworkSchema = z.object({
  assetId: z.string().min(1),
  centerSlope: vec2Schema,
  heightSlope: finite,
  rotationDeg: finite,
});

const printSchema = z.object({
  paper: z.enum(['a4', 'letter', 'a3']),
  orientation: z.enum(['portrait', 'landscape']),
  marginMm: z.object({
    top: finite,
    right: finite,
    bottom: finite,
    left: finite,
  }),
  overlapMm: finite,
  dpi: z.union([z.literal(150), z.literal(300)]),
  surfaceIds: z.array(surfaceIdSchema),
});

export const projectV1Schema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  title: titleSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  displayUnit: displayUnitSchema,
  corner: cornerSchema,
  viewpoint: viewpointSchema,
  artwork: artworkSchema.nullable(),
  print: printSchema,
});

export { vec2Schema, vec3Schema, mat3Schema, surfaceIdSchema };

export type ParseProjectResult =
  | { ok: true; project: ProjectV1 }
  | { ok: false; message: string };

export function parseProject(data: unknown): ParseProjectResult {
  const result = projectV1Schema.safeParse(data);
  if (!result.success) {
    return { ok: false, message: result.error.issues[0]?.message ?? 'invalid project' };
  }
  return { ok: true, project: result.data as ProjectV1 };
}
