interface VertexLogoProps {
  size?:      number
  className?: string
  title?:     string
}

/** Vertex logo (designer artwork, raster). Served by the host from
 *  `/paintsharp-vertex-logo.png`; rendered as a square image so it weighs the
 *  same as its neighbours in the waffle menu. */
export function VertexLogo({ size = 24, className, title = 'Vertex' }: VertexLogoProps) {
  return (
    <img
      src="/paintsharp-vertex-logo.png"
      width={size}
      height={size}
      alt={title}
      className={className}
      style={{ display: 'block', objectFit: 'contain' }}
    />
  )
}

export default VertexLogo
