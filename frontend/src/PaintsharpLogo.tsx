import { PAINTSHARP_LOGO_PNG } from './paintsharpLogoData'

// Logo PaintSharp — purple hexagonal badge holding the multicolour mark, as a
// raster image supplied by the user. Embedded as a data URI (see
// `paintsharpLogoData.ts`) so the component is entirely self-contained: it
// carries no external asset URL to resolve, which is what lets the host render
// it in the app launcher and title bars regardless of where the module's own
// assets are served. Signature compatible with the icon slots (size + className).
interface PaintsharpLogoProps {
  /** Height AND width in px — the artwork is square (512×512). */
  size?:      number
  className?: string
  title?:     string
}

export function PaintsharpLogo({ size = 24, className, title = 'PaintSharp' }: PaintsharpLogoProps) {
  return (
    <img
      src={PAINTSHARP_LOGO_PNG}
      width={size}
      height={size}
      alt={title}
      className={className}
      draggable={false}
      style={{ objectFit: 'contain' }}
    />
  )
}

export default PaintsharpLogo
