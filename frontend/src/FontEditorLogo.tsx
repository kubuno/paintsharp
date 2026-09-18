interface FontEditorLogoProps {
  size?:      number
  className?: string
  title?:     string
}

/** FontEditor logo (designer artwork, raster). Served by the host from
 *  `/paintsharp-fonteditor-logo.png`; rendered as a square image so it weighs the
 *  same as its neighbours in the waffle menu. */
export function FontEditorLogo({ size = 24, className, title = 'FontEditor' }: FontEditorLogoProps) {
  return (
    <img
      src="/paintsharp-fonteditor-logo.png"
      width={size}
      height={size}
      alt={title}
      className={className}
      style={{ display: 'block', objectFit: 'contain' }}
    />
  )
}

export default FontEditorLogo
