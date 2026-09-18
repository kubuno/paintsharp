interface KeyframeLogoProps {
  size?:      number
  className?: string
  title?:     string
}

/** Keyframe logo (designer artwork, raster). Served by the host from
 *  `/paintsharp-keyframe-logo.png`; rendered as a square image so it weighs the
 *  same as its neighbours in the waffle menu. */
export function KeyframeLogo({ size = 24, className, title = 'Keyframe' }: KeyframeLogoProps) {
  return (
    <img
      src="/paintsharp-keyframe-logo.png"
      width={size}
      height={size}
      alt={title}
      className={className}
      style={{ display: 'block', objectFit: 'contain' }}
    />
  )
}

export default KeyframeLogo
