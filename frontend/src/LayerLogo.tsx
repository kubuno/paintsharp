interface LayerLogoProps {
  size?:      number
  className?: string
  title?:     string
}

/** Layer logo (designer artwork, raster). Served by the host from
 *  `/paintsharp-layer-logo.png`; rendered as a square image so it weighs the
 *  same as its neighbours in the waffle menu. */
export function LayerLogo({ size = 24, className, title = 'Layer' }: LayerLogoProps) {
  return (
    <img
      src="/paintsharp-layer-logo.png"
      width={size}
      height={size}
      alt={title}
      className={className}
      style={{ display: 'block', objectFit: 'contain' }}
    />
  )
}

export default LayerLogo
