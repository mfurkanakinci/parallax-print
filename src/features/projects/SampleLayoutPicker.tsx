import { SAMPLE_LAYOUTS, type SampleLayout } from '../../assets/sampleLayouts';
import type { Vec3 } from '../../core/types';

/** Small axonometric diagrams of the actual example dimensions. */
function LayoutDiagram({ layout }: { readonly layout: SampleLayout }) {
  const { panelA: a, panelB: b, angleDeg, includeBase } = layout.corner;
  const theta = angleDeg * Math.PI / 180;
  const origin: Vec3 = [0, 0, 0];
  const endA: Vec3 = [a.widthMm, 0, 0];
  const endB: Vec3 = [Math.cos(theta) * b.widthMm, 0, Math.sin(theta) * b.widthMm];
  const wallA: Vec3[] = [origin, endA, [endA[0], a.heightMm, 0], [0, a.heightMm, 0]];
  const wallB: Vec3[] = [origin, endB, [endB[0], b.heightMm, endB[2]], [0, b.heightMm, 0]];
  const floor: Vec3[] = [origin, endA, [endA[0] + endB[0], 0, endB[2]], endB];
  const planes = includeBase ? [floor, wallA, wallB] : [wallA, wallB];
  const project = ([x, y, z]: Vec3) => [0.8 * (x - z), 0.32 * (x + z) - y] as const;
  const projected = planes.map((plane) => plane.map(project));
  const points = projected.flat();
  const minX = Math.min(...points.map(([x]) => x));
  const minY = Math.min(...points.map(([, y]) => y));
  const width = Math.max(...points.map(([x]) => x)) - minX;
  const height = Math.max(...points.map(([, y]) => y)) - minY;
  const scale = Math.min(58 / width, 38 / height);
  const fit = ([x, y]: readonly [number, number]) =>
    `${(32 + (x - minX - width / 2) * scale).toFixed(2)},${(22 + (y - minY - height / 2) * scale).toFixed(2)}`;

  return (
    <svg viewBox="0 0 64 44" aria-hidden="true" focusable="false">
      {projected.map((plane, index) => (
        <polygon
          key={index}
          points={plane.map(fit).join(' ')}
          fill="currentColor"
          fillOpacity={includeBase && index === 0 ? 0.05 : index === projected.length - 1 ? 0.2 : 0.1}
          stroke="currentColor"
          strokeWidth="1.1"
          strokeLinejoin="round"
        />
      ))}
    </svg>
  );
}

export function SampleLayoutPicker({
  value,
  onChange,
  disabled,
}: {
  readonly value: SampleLayout;
  readonly onChange: (layout: SampleLayout) => void;
  readonly disabled: boolean;
}) {
  return (
    <div className="sample-layouts" role="group" aria-label="Example wall layouts">
      <p className="sample-layouts__heading">Explore a wall layout</p>
      <div className="sample-layouts__choices">
        {SAMPLE_LAYOUTS.map((layout) => (
          <button
            key={layout.id}
            type="button"
            className="sample-layout-choice"
            aria-label={`Select ${layout.label} layout`}
            aria-pressed={layout.id === value.id}
            aria-describedby={layout.id === value.id ? 'sample-layout-description' : undefined}
            title={layout.description}
            disabled={disabled}
            onClick={() => onChange(layout)}
          >
            <LayoutDiagram layout={layout} />
            <span>{layout.label}</span>
            <span className="sample-layout-choice__angle">{layout.corner.angleDeg}°</span>
          </button>
        ))}
      </div>
      <p id="sample-layout-description" className="sample-layouts__description" aria-live="polite">
        <strong>{value.label}.</strong> {value.description}
        <span>Choose artwork above; “Try a sample” opens this layout to edit.</span>
      </p>
    </div>
  );
}
