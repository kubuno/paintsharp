interface MotionLogoProps {
  size?:      number
  className?: string
  title?:     string
}

/** Motion logo (designer artwork, raster). Served by the host from
 *  `/paintsharp-motion-logo.png`; rendered as a square image so it weighs the
 *  same as its neighbours in the waffle menu. */
export function MotionLogo({ size = 24, className, title = 'Motion' }: MotionLogoProps) {
  return (
    <img
      src="/paintsharp-motion-logo.png"
      width={size}
      height={size}
      alt={title}
      className={className}
      style={{ display: 'block', objectFit: 'contain' }}
    />
  )
}

export default MotionLogo
