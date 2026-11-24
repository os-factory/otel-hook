/**
 * Internal: shared by `OTEL_EXPORTER_OTLP_*HEADERS` parsing and the
 * `exporter.destinations[].headers` schema. Not re-exported from the package.
 */

/**
 * Characters an HTTP field value must not contain once decoded. CR and LF would
 * split the request; the other controls and anything beyond Latin-1 are refused
 * by Node's HTTP client anyway, and refusing them here turns a failed export into
 * a reported, skipped entry.
 */
export const isUnsafeHeaderValue = (value: string): boolean =>
  [...value].some((char) => {
    const code = char.codePointAt(0) ?? 0;
    return (code < 0x20 && code !== 0x09) || code === 0x7f || code > 0xff;
  });
