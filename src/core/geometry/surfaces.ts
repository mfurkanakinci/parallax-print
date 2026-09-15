import { scale3 } from '../math/vector';
import type { CornerSpec, Surface, SurfaceDatum, Vec2, Vec3 } from '../types';

function signedArea(polygon: readonly Vec2[]): number {
  let area = 0;
  for (let i = 0; i < polygon.length; i += 1) {
    const p = polygon[i]!;
    const q = polygon[(i + 1) % polygon.length]!;
    area += p[0] * q[1] - q[0] * p[1];
  }
  return area / 2;
}

function normalizeWinding(polygon: readonly Vec2[]): readonly Vec2[] {
  return signedArea(polygon) >= 0 ? polygon : [...polygon].reverse();
}

function buildBase(aMm: number, bMm: number, rB: Vec3): Surface {
  const world: Vec3[] = [
    [0, 0, 0],
    [aMm, 0, 0],
    [aMm + bMm * rB[0], 0, bMm * rB[2]],
    [bMm * rB[0], 0, bMm * rB[2]],
  ];
  const xmin = Math.min(...world.map((p) => p[0]));
  const xmax = Math.max(...world.map((p) => p[0]));
  const zmin = Math.min(...world.map((p) => p[2]));
  const zmax = Math.max(...world.map((p) => p[2]));
  const originMm: Vec3 = [xmin, 0, zmax];
  const axisU: Vec3 = [1, 0, 0];
  const axisV: Vec3 = [0, 0, -1];
  const toLocal = (p: Vec3): Vec2 => [p[0] - xmin, zmax - p[2]];
  const polygonMm = normalizeWinding(world.map(toLocal));
  const cornerLocal = toLocal([0, 0, 0]);
  const datums: SurfaceDatum[] = [
    {
      id: 'shared-corner',
      label: 'Shared bottom corner O',
      kind: 'point',
      localMm: cornerLocal,
    },
    {
      id: 'panel-a-datum',
      label: 'Panel A far bottom corner',
      kind: 'point',
      localMm: toLocal([aMm, 0, 0]),
    },
    {
      id: 'panel-b-datum',
      label: 'Panel B far bottom corner',
      kind: 'point',
      localMm: toLocal([bMm * rB[0], 0, bMm * rB[2]]),
    },
  ];
  return {
    id: 'C',
    originMm,
    axisU,
    axisV,
    frontNormal: [0, 1, 0],
    polygonMm,
    boundsMm: { x: 0, y: 0, width: xmax - xmin, height: zmax - zmin },
    datums,
  };
}

/**
 * Surface-local UV (polygonMm units, millimetres) to world coordinates.
 * Single definition shared by the raster path, the viewport mesh builder,
 * and the resolved-view overlay projection.
 */
export function surfaceUvToWorld(surface: Surface, uv: Vec2): Vec3 {
  return [
    surface.originMm[0] + surface.axisU[0] * uv[0] + surface.axisV[0] * uv[1],
    surface.originMm[1] + surface.axisU[1] * uv[0] + surface.axisV[1] * uv[1],
    surface.originMm[2] + surface.axisU[2] * uv[0] + surface.axisV[2] * uv[1],
  ];
}

export function buildSurfaces(corner: CornerSpec): readonly Surface[] {
  const a = corner.panelA.widthMm;
  const hA = corner.panelA.heightMm;
  const b = corner.panelB.widthMm;
  const hB = corner.panelB.heightMm;
  const theta = (corner.angleDeg * Math.PI) / 180;
  const rB: Vec3 = [Math.cos(theta), 0, Math.sin(theta)];

  const surfaceA: Surface = {
    id: 'A',
    originMm: [0, 0, 0],
    axisU: [1, 0, 0],
    axisV: [0, 1, 0],
    frontNormal: [0, 0, 1],
    polygonMm: [
      [0, 0],
      [a, 0],
      [a, hA],
      [0, hA],
    ],
    boundsMm: { x: 0, y: 0, width: a, height: hA },
    datums: [
      {
        id: 'seam',
        label: 'Shared seam edge (U = 0)',
        kind: 'edge',
        localMm: [0, 0],
        localEndMm: [0, hA],
      },
      {
        id: 'shared-corner',
        label: 'Shared bottom corner O',
        kind: 'point',
        localMm: [0, 0],
      },
    ],
  };

  const originB = scale3(rB, b);
  const surfaceB: Surface = {
    id: 'B',
    originMm: originB,
    axisU: [-rB[0], 0, -rB[2]],
    axisV: [0, 1, 0],
    frontNormal: [Math.sin(theta), 0, -Math.cos(theta)],
    polygonMm: [
      [0, 0],
      [b, 0],
      [b, hB],
      [0, hB],
    ],
    boundsMm: { x: 0, y: 0, width: b, height: hB },
    datums: [
      {
        id: 'seam',
        label: 'Shared seam edge (U = b)',
        kind: 'edge',
        localMm: [b, 0],
        localEndMm: [b, hB],
      },
      {
        id: 'shared-corner',
        label: 'Shared bottom corner O',
        kind: 'point',
        localMm: [b, 0],
      },
    ],
  };

  const surfaces: Surface[] = [surfaceA, surfaceB];
  if (corner.includeBase) {
    surfaces.push(buildBase(a, b, rB));
  }
  return surfaces;
}
