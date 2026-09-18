interface ApexLogoProps {
  size?:      number
  className?: string
  title?:     string
}

/** Apex logo (designer artwork, raster). Served by the host from
 *  `/paintsharp-apex-logo.png`; rendered as a square image so it weighs the
 *  same as its neighbours in the waffle menu. */
export function ApexLogo({ size = 24, className, title = 'Apex' }: ApexLogoProps) {
  return (
    <img
      src="/paintsharp-apex-logo.png"
      width={size}
      height={size}
      alt={title}
      className={className}
      style={{ display: 'block', objectFit: 'contain' }}
    />
  )
}

export default ApexLogo
