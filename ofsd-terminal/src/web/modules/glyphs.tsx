// Small line drawings for empty states. Static, quiet, on-palette.

export const SpiderGlyph = () => {
  const legs = [
    [-1, -0.9, -2.1, -1.6, -2.9, -0.7],
    [-1, -0.3, -2.4, -0.6, -3.2, 0.5],
    [-1, 0.3, -2.2, 0.8, -2.8, 1.9],
    [-0.8, 0.8, -1.6, 1.8, -1.9, 2.9],
  ];
  const s = 12;
  return (
    <svg viewBox="-60 -45 120 90" width="120" height="90" fill="none">
      <line x1="0" y1="-45" x2="0" y2="-8" stroke="var(--magenta)" strokeWidth="0.8" opacity="0.7" />
      {[1, -1].map((side) =>
        legs.map((l, i) => {
          const p = l.map((v, j) => (j % 2 === 0 ? v * s * side : v * s));
          return (
            <g key={`${side}${i}`}>
              <polyline points={`${p[0]},${p[1]} ${p[2]},${p[3]} ${p[4]},${p[5]}`} stroke="var(--cyan)" strokeWidth="1.1" opacity="0.85" />
              <circle cx={p[2]} cy={p[3]} r="1.4" fill="var(--cyan)" />
              <circle cx={p[4]} cy={p[5]} r="1.6" fill="var(--magenta)" />
            </g>
          );
        }),
      )}
      <ellipse cx="0" cy="0" rx="7" ry="10" stroke="var(--cyan)" strokeWidth="1.2" fill="var(--bg)" />
      <circle cx="0" cy="-12" r="3" fill="var(--cyan)" />
    </svg>
  );
};

export const ClusterGlyph = () => {
  const pts = Array.from({ length: 46 }, (_, i) => {
    const a = i * 2.399;
    const r = 4 + Math.sqrt(i) * 4.6;
    const cx = i % 3 === 0 ? -18 : i % 3 === 1 ? 16 : 0;
    const cy = i % 3 === 2 ? 14 : -6;
    return [cx + Math.cos(a) * r * 0.55, cy + Math.sin(a) * r * 0.45, i];
  });
  return (
    <svg viewBox="-60 -45 120 90" width="120" height="90">
      {pts.map(([x, y, i]) => (
        <circle key={i} cx={x} cy={y} r={i % 7 === 0 ? 1.8 : 1.1} fill={i === 5 ? 'var(--lime)' : 'var(--text-dim)'} opacity={0.4 + (i % 5) * 0.12} />
      ))}
    </svg>
  );
};

export const NetworkGlyph = () => {
  const n = [
    [-36, -18], [-14, -30], [12, -22], [34, -8], [-28, 10], [-4, 0], [22, 16], [-10, 26], [40, 22],
  ];
  const e = [[0, 1], [1, 2], [2, 3], [0, 4], [4, 5], [5, 2], [5, 6], [6, 3], [4, 7], [7, 6], [6, 8], [1, 5]];
  return (
    <svg viewBox="-60 -45 120 90" width="120" height="90">
      {e.map(([a, b], i) => (
        <line key={i} x1={n[a][0]} y1={n[a][1]} x2={n[b][0]} y2={n[b][1]} stroke="var(--border-strong)" strokeWidth="0.8" />
      ))}
      {n.map(([x, y], i) => (
        <circle key={i} cx={x} cy={y} r={i === 5 ? 3 : 2} fill={i === 5 ? 'var(--lime)' : 'var(--text-dim)'} />
      ))}
    </svg>
  );
};

export const LinesGlyph = () => (
  <svg viewBox="-60 -45 120 90" width="120" height="90">
    {[-24, -12, 0, 12, 24].map((y, i) => (
      <g key={y}>
        <circle cx="-40" cy={y} r="2" fill={i === 0 ? 'var(--red)' : 'var(--text-faint)'} />
        <rect x="-32" y={y - 1.5} width={50 - i * 6} height="3" rx="1" fill="var(--border-strong)" />
        <rect x="26" y={y - 1.5} width="14" height="3" rx="1" fill="var(--panel-3)" />
      </g>
    ))}
  </svg>
);
