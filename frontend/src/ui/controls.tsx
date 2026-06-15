// Paintsharp primitive: small shared form controls for editor options bars / panels.

// Compact label + numeric field for an options bar (Photoshop-style).
export function OptNum({ label, value, min, max, suffix, onChange, C }: {
  label: string; value: number; min: number; max: number; suffix?: string
  onChange: (v: number) => void
  C: { text: string; textDim: string; border: string }
}) {
  return (
    <label className="flex items-center gap-1" style={{ color: C.textDim }}>
      <span className="text-[11px]">{label}</span>
      <input type="number" min={min} max={max} value={value}
             onChange={e => onChange(Math.max(min, Math.min(max, +e.target.value)))}
             className="w-11 h-5 text-[11px] text-center outline-none"
             style={{ background:'#252525', color:C.text, border:`1px solid ${C.border}`, borderRadius:2 }} />
      {suffix && <span className="text-[10px]" style={{ color:C.textDim }}>{suffix}</span>}
    </label>
  )
}
