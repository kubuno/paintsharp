interface PdfWriterLogoProps {
  size?:      number
  className?: string
  title?:     string
}

/** PdfWriter logo (designer artwork, raster). Served by the host from
 *  `/paintsharp-pdfwriter-logo.png`; rendered as a square image so it weighs the
 *  same as its neighbours in the waffle menu. */
export function PdfWriterLogo({ size = 24, className, title = 'PdfWriter' }: PdfWriterLogoProps) {
  return (
    <img
      src="/paintsharp-pdfwriter-logo.png"
      width={size}
      height={size}
      alt={title}
      className={className}
      style={{ display: 'block', objectFit: 'contain' }}
    />
  )
}

export default PdfWriterLogo
