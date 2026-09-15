import { useRef, useState } from 'react';
import type { CornerSpec, Vec3 } from '../core/types';
import { buildSurfaces } from '../core/geometry/surfaces';
import { add3, scale3 } from '../core/math/vector';

export type DiagramFocus =
  | 'panelA'
  | 'panelB'
  | 'base'
  | 'angle'
  | 'eye'
  | 'aim'
  | null;

const W = 300;
const H = 220;
const PAD = 34;

const FOCUS_SURFACE: Record<Exclude<DiagramFocus, null | 'eye' | 'aim'>, string> = {
  panelA: 'A',
  panelB: 'B',
  base: 'C',
  angle: '',
};

export function SurfaceDiagram({
  corner,
  eyeMm,
  focused,
  onEyeCommit,
}: {
  readonly corner: CornerSpec;
  readonly eyeMm?: Vec3 | undefined;
  readonly focused?: DiagramFocus | undefined;
  readonly onEyeCommit?: ((xMm: number, zMm: number) => void) | undefined;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [dragEye, setDragEye] = useState<{ x: number; y: number } | null>(null);
  const surfaces = buildSurfaces(corner);
  const toPlan = (u: number, v: number, s: (typeof surfaces)[number]) => {
    const w = add3(
      s.originMm,
      add3(scale3(s.axisU, u), scale3(s.axisV, v)),
    );
    return { x: w[0], y: w[2] };
  };

  const pts: { x: number; y: number }[] = [];
  const traces = surfaces.map((s) => {
    const isWall = Math.abs(s.axisV[1] ?? 0) > 0.9;
    if (isWall) {
      const a = toPlan(s.polygonMm[0]![0], s.polygonMm[0]![1], s);
      const b = toPlan(s.polygonMm[1]![0], s.polygonMm[1]![1], s);
      pts.push(a, b);
      return { id: s.id, kind: 'wall' as const, a, b };
    }
    const polygon = s.polygonMm.map(([u, v]) => toPlan(u, v, s));
    for (const p of polygon) pts.push(p);
    return { id: s.id, kind: 'base' as const, polygon };
  });
  if (eyeMm) pts.push({ x: eyeMm[0], y: eyeMm[2] });
  pts.push({ x: 0, y: 0 });

  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const spanX = Math.max(maxX - minX, 1);
  const spanY = Math.max(maxY - minY, 1);
  const scale = Math.min((W - PAD * 2) / spanX, (H - PAD * 2) / spanY);
  const ox = PAD + (W - PAD * 2 - spanX * scale) / 2 - minX * scale;
  const oy = PAD + (H - PAD * 2 - spanY * scale) / 2 - minY * scale;
  const px = (p: { x: number; y: number }) => ({
    x: p.x * scale + ox,
    y: p.y * scale + oy,
  });

  const eyePlan = dragEye ?? (eyeMm ? { x: eyeMm[0], y: eyeMm[2] } : null);

  const toPlanCoords = (e: React.PointerEvent) => {
    const svg = svgRef.current;
    const ctm = svg?.getScreenCTM();
    if (!svg || !ctm) return null;
    const pt = new DOMPoint(e.clientX, e.clientY).matrixTransform(
      ctm.inverse(),
    );
    return { x: (pt.x - ox) / scale, y: (pt.y - oy) / scale };
  };

  const o = px({ x: 0, y: 0 });
  const focusedId =
    focused && focused !== 'eye' && focused !== 'aim'
      ? FOCUS_SURFACE[focused]
      : null;
  const focusKey = (id: string) =>
    focusedId === id || (focused === 'angle' && (id === 'A' || id === 'B'));

  const norm = (v: { x: number; y: number }) => {
    const l = Math.hypot(v.x, v.y) || 1;
    return { x: v.x / l, y: v.y / l };
  };
  const perp = (v: { x: number; y: number }) => ({ x: -v.y, y: v.x });
  const outward = (
    dir: { x: number; y: number },
    interior: { x: number; y: number },
  ) => {
    const n = perp(dir);
    return n.x * interior.x + n.y * interior.y > 0
      ? { x: -n.x, y: -n.y }
      : n;
  };

  const wallById = new Map(
    traces.filter((t) => t.kind === 'wall').map((t) => [t.id, t]),
  );
  const wallA = wallById.get('A');
  const wallB = wallById.get('B');
  let angleArc: React.ReactNode = null;
  let dimLabels: React.ReactNode = null;
  if (wallA && wallB && wallA.kind === 'wall' && wallB.kind === 'wall') {
    // Each wall runs from the shared origin O to its far corner. Use the far
    // corner (the endpoint that is not O) so direction is unambiguous.
    const aEnd =
      Math.hypot(wallA.a.x, wallA.a.y) > Math.hypot(wallA.b.x, wallA.b.y)
        ? px(wallA.a)
        : px(wallA.b);
    const bEnd =
      Math.hypot(wallB.a.x, wallB.a.y) > Math.hypot(wallB.b.x, wallB.b.y)
        ? px(wallB.a)
        : px(wallB.b);
    const dA = norm({ x: aEnd.x - o.x, y: aEnd.y - o.y });
    const dB = norm({ x: bEnd.x - o.x, y: bEnd.y - o.y });

    const cross = dA.x * dB.y - dA.y * dB.x;
    const sweep = cross >= 0 ? 1 : 0;
    const largeArc = Math.abs(corner.angleDeg) > 180 ? 1 : 0;
    const R = 24;
    const start = { x: o.x + dA.x * R, y: o.y + dA.y * R };
    const end = { x: o.x + dB.x * R, y: o.y + dB.y * R };
    let bis = norm({ x: dA.x + dB.x, y: dA.y + dB.y });
    if (Math.hypot(dA.x + dB.x, dA.y + dB.y) < 1e-3) {
      bis = outward(dA, dB);
    }
    const lp = { x: o.x + bis.x * (R + 16), y: o.y + bis.y * (R + 16) };
    angleArc = (
      <>
        <path
          d={`M ${start.x} ${start.y} A ${R} ${R} 0 ${largeArc} ${sweep} ${end.x} ${end.y}`}
          className={`diagram-arc${focused === 'angle' ? ' diagram-focused' : ''}`}
        />
        <text
          x={lp.x}
          y={lp.y}
          className="diagram-angle-label"
          textAnchor="middle"
          dominantBaseline="middle"
        >
          {`${corner.angleDeg}°`}
        </text>
      </>
    );

    const dims: { id: 'A' | 'B'; mm: number; end: { x: number; y: number }; dir: { x: number; y: number }; interior: { x: number; y: number } }[] = [
      { id: 'A', mm: corner.panelA.widthMm, end: aEnd, dir: dA, interior: dB },
      { id: 'B', mm: corner.panelB.widthMm, end: bEnd, dir: dB, interior: dA },
    ];
    dimLabels = dims.map(({ id, mm, end, dir, interior }) => {
      const n = outward(dir, interior);
      const mid = { x: (o.x + end.x) / 2, y: (o.y + end.y) / 2 };
      return (
        <text
          key={`dim-${id}`}
          x={mid.x + n.x * 17}
          y={mid.y + n.y * 17}
          className="diagram-dim-label"
          textAnchor="middle"
          dominantBaseline="middle"
        >
          {`${id} · ${mm} mm`}
        </text>
      );
    });
  }

  return (
    <svg
      ref={svgRef}
      className="surface-diagram"
      viewBox={`0 0 ${W} ${H}`}
      role={onEyeCommit ? 'group' : 'img'}
      aria-label="Plan view of the measured corner"
    >
      {traces.map((t) =>
        t.kind === 'base' ? (
          <polygon
            key={t.id}
            points={t.polygon.map((p) => `${px(p).x},${px(p).y}`).join(' ')}
            className={`diagram-base${focusKey('C') ? ' diagram-focused' : ''}`}
          />
        ) : (
          <line
            key={t.id}
            x1={px(t.a).x}
            y1={px(t.a).y}
            x2={px(t.b).x}
            y2={px(t.b).y}
            className={`diagram-wall${focusKey(t.id) ? ' diagram-focused' : ''}`}
            strokeWidth={focusKey(t.id) ? 3 : 2}
          />
        ),
      )}
      {angleArc}
      {dimLabels}
      {traces
        .filter((t) => t.kind === 'base')
        .map((t) => {
          if (t.kind !== 'base') return null;
          const cx =
            t.polygon.reduce((s, p) => s + p.x, 0) / t.polygon.length;
          const cy =
            t.polygon.reduce((s, p) => s + p.y, 0) / t.polygon.length;
          const c = px({ x: cx, y: cy });
          return (
            <text key="label-C" x={c.x - 4} y={c.y + 4} className="diagram-label">
              C
            </text>
          );
        })}
      <circle cx={o.x} cy={o.y} r={4} className="diagram-origin" />
      <text x={o.x - 12} y={o.y + 14} className="diagram-label">
        O
      </text>
      {eyePlan ? (
        <line
          x1={o.x}
          y1={o.y}
          x2={px(eyePlan).x}
          y2={px(eyePlan).y}
          className="diagram-eye-line"
        />
      ) : null}
      {eyePlan ? (
        <g
          className={`diagram-eye-group${focused === 'eye' || dragEye ? ' diagram-focused' : ''}${onEyeCommit ? ' diagram-draggable' : ''}`}
          role={onEyeCommit ? 'button' : undefined}
          tabIndex={onEyeCommit ? 0 : undefined}
          aria-label={
            onEyeCommit
              ? 'Viewing point on the floor plan. Drag to move it, or use arrow keys for 10 mm and Shift plus arrows for 50 mm. Enter commits, Escape cancels.'
              : undefined
          }
          onKeyDown={
            onEyeCommit
              ? (e) => {
                  const cur = dragEye ?? eyePlan;
                  if (!cur) return;
                  const stepMm = e.shiftKey ? 50 : 10;
                  let dx = 0;
                  let dy = 0;
                  if (e.key === 'ArrowLeft') dx = -stepMm;
                  else if (e.key === 'ArrowRight') dx = stepMm;
                  else if (e.key === 'ArrowUp') dy = -stepMm;
                  else if (e.key === 'ArrowDown') dy = stepMm;
                  else if (e.key === 'Enter') {
                    e.preventDefault();
                    if (dragEye) {
                      setDragEye(null);
                      onEyeCommit(dragEye.x, dragEye.y);
                    }
                    return;
                  } else if (e.key === 'Escape') {
                    e.preventDefault();
                    setDragEye(null);
                    return;
                  } else return;
                  e.preventDefault();
                  setDragEye({ x: cur.x + dx, y: cur.y + dy });
                }
              : undefined
          }
          onPointerDown={
            onEyeCommit
              ? (e) => {
                  e.currentTarget.setPointerCapture(e.pointerId);
                  const p = toPlanCoords(e);
                  if (p) setDragEye(p);
                }
              : undefined
          }
          onPointerMove={
            onEyeCommit
              ? (e) => {
                  if (!dragEye) return;
                  const p = toPlanCoords(e);
                  if (p) setDragEye(p);
                }
              : undefined
          }
          onPointerUp={
            onEyeCommit
              ? (e) => {
                  if (!dragEye) return;
                  const p = toPlanCoords(e) ?? dragEye;
                  setDragEye(null);
                  onEyeCommit(p.x, p.y);
                }
              : undefined
          }
          onPointerCancel={onEyeCommit ? () => setDragEye(null) : undefined}
        >
          <circle
            cx={px(eyePlan).x}
            cy={px(eyePlan).y}
            r={22}
            fill="transparent"
          />
          <circle
            cx={px(eyePlan).x}
            cy={px(eyePlan).y}
            r={5}
            className="diagram-eye"
          />
          <text
            x={px(eyePlan).x + 8}
            y={px(eyePlan).y - 6}
            className="diagram-label"
          >
            Eye
          </text>
        </g>
      ) : null}
    </svg>
  );
}

export function ElevationDiagram({
  corner,
  eyeMm,
  aimHeightMm,
  focused,
}: {
  readonly corner: CornerSpec;
  readonly eyeMm: Vec3;
  readonly aimHeightMm: number;
  readonly focused?: DiagramFocus | undefined;
}) {
  const wallHeight = Math.max(corner.panelA.heightMm, corner.panelB.heightMm);
  const eyeDist = Math.hypot(eyeMm[0], eyeMm[2]);
  const pts = [
    { x: 0, y: 0 },
    { x: 0, y: wallHeight },
    { x: eyeDist, y: eyeMm[1] },
    { x: 0, y: aimHeightMm },
  ];
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const maxY = Math.max(...ys);
  const spanX = Math.max(maxX - minX, 1);
  const spanY = Math.max(maxY, 1);
  const scale = Math.min((W - PAD * 2) / spanX, (H - PAD * 2) / spanY);
  const ox = PAD + (W - PAD * 2 - spanX * scale) / 2 - minX * scale;
  const py = (yMm: number) =>
    H - PAD - (H - PAD * 2 - spanY * scale) / 2 - yMm * scale;
  const px2 = (xMm: number) => xMm * scale + ox;

  const seam = { x: px2(0), y1: py(0), y2: py(wallHeight) };
  const eye = { x: px2(eyeDist), y: py(eyeMm[1]) };
  const aim = { x: px2(0), y: py(aimHeightMm) };

  return (
    <svg
      className="surface-diagram"
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label="Elevation view of the seam, eye height, and aim point"
    >
      <line
        x1={seam.x}
        y1={seam.y1}
        x2={seam.x}
        y2={seam.y2}
        className={`diagram-wall${focused === 'aim' ? ' diagram-focused' : ''}`}
        strokeWidth={2}
      />
      <line
        x1={seam.x}
        y1={aim.y}
        x2={eye.x}
        y2={eye.y}
        className="diagram-sightline"
      />
      <circle cx={aim.x} cy={aim.y} r={4} className="diagram-aim" />
      <text x={aim.x + 7} y={aim.y - 6} className="diagram-label">
        Aim
      </text>
      <circle
        cx={eye.x}
        cy={eye.y}
        r={5}
        className={`diagram-eye${focused === 'eye' ? ' diagram-focused' : ''}`}
      />
      <text x={eye.x - 34} y={eye.y - 8} className="diagram-label">
        Eye
      </text>
      <text x={seam.x - 14} y={seam.y2 - 6} className="diagram-label">
        O
      </text>
      <line
        x1={PAD - 10}
        y1={py(0)}
        x2={W - PAD + 10}
        y2={py(0)}
        className="diagram-floor"
      />
    </svg>
  );
}
