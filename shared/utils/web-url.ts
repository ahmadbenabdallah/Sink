/**
 * Whether a link target is an http or https address. Anything else, such as
 * `javascript:` or `data:`, would run as script on this origin when framed or
 * linked to, so only web addresses get the cloaking page, the preview page or
 * a clickable link in the dashboard.
 *
 * The rule is the one the link schemas apply to new targets: a literal
 * `http://` or `https://` prefix. URL parsing alone is not enough, because it
 * skips leading control characters that the browser's HTML parser keeps, and
 * the browser would then read the rest as a path on this origin.
 */
export function isWebUrl(value: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /^https?:\/\//i.test(value) && !/[\u0000-\u001F\u007F]/.test(value) && URL.canParse(value)
}
