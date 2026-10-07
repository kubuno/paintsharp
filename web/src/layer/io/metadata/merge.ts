// Metadata reconciliation (spec 05 §6.5).
//
// The same logical field lives in three places and they contradict each other constantly.
// The industry convention (Metadata Working Group) is XMP > IPTC > EXIF, and that order
// is applied here — documented and testable rather than re-decided at each call site.

import { EXIF_TAG, exifString } from './exif'
import { IPTC_FIELD, iptcValue, iptcValues } from './iptc'
import type { ImageMetadata } from './types'
import { XMP_PROPERTY, xmpGet } from './xmp'

export interface MergedFields {
  readonly title?: string
  readonly description?: string
  readonly creator?: string
  readonly copyright?: string
  readonly headline?: string
  readonly keywords: readonly string[]
  readonly city?: string
  readonly country?: string
  readonly dateTime?: string
  readonly make?: string
  readonly model?: string
  readonly software?: string
}

/** Resolves the user-visible fields, XMP first, then IPTC, then EXIF. */
export function mergeMetadataFields(metadata: ImageMetadata): MergedFields {
  const first = (...candidates: (string | undefined)[]): string | undefined =>
    candidates.find((c) => c !== undefined && c.trim().length > 0)

  const xmp = (property: string): string | undefined => xmpGet(metadata.xmp, property)[0]

  const keywords =
    xmpGet(metadata.xmp, XMP_PROPERTY.Subject).length > 0
      ? xmpGet(metadata.xmp, XMP_PROPERTY.Subject)
      : iptcValues(metadata.iptc, IPTC_FIELD.Keywords)

  return {
    title: first(xmp(XMP_PROPERTY.Title), iptcValue(metadata.iptc, IPTC_FIELD.ObjectName)),
    description: first(
      xmp(XMP_PROPERTY.Description),
      iptcValue(metadata.iptc, IPTC_FIELD.Caption),
      metadata.text?.get('Description'),
    ),
    creator: first(
      xmp(XMP_PROPERTY.Creator),
      iptcValue(metadata.iptc, IPTC_FIELD.Byline),
      exifString(metadata.exif?.ifd0, EXIF_TAG.Artist),
    ),
    copyright: first(
      xmp(XMP_PROPERTY.Rights),
      iptcValue(metadata.iptc, IPTC_FIELD.Copyright),
      exifString(metadata.exif?.ifd0, EXIF_TAG.Copyright),
    ),
    headline: first(xmp(XMP_PROPERTY.Headline), iptcValue(metadata.iptc, IPTC_FIELD.Headline)),
    keywords,
    city: iptcValue(metadata.iptc, IPTC_FIELD.City),
    country: iptcValue(metadata.iptc, IPTC_FIELD.Country),
    dateTime: first(
      xmp(XMP_PROPERTY.CreateDate),
      exifString(metadata.exif?.exifIfd, EXIF_TAG.DateTimeOriginal),
      exifString(metadata.exif?.ifd0, EXIF_TAG.DateTime),
      metadata.text?.get('DateTime'),
    ),
    make: first(exifString(metadata.exif?.ifd0, EXIF_TAG.Make), metadata.text?.get('Make')),
    model: first(exifString(metadata.exif?.ifd0, EXIF_TAG.Model), metadata.text?.get('Model')),
    software: first(exifString(metadata.exif?.ifd0, EXIF_TAG.Software), metadata.text?.get('Software')),
  }
}
