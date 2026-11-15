import { KeelError } from './errors';

// ADR 0005, section 4: a list's cover is an SVG or a PNG you set, at most 200 KB.
// An SVG is a page that can run script, so it is cleaned before it is saved: only
// drawing elements and attributes are kept. (It is also only ever shown through an
// <img> tag, which does not run script; this is the second lock.)

/** The most one cover may take, in bytes. */
export const MAX_COVER_BYTES = 200 * 1024;
/** When all covers together pass this, Keel suggests moving them to object storage. */
export const COVER_STORAGE_NOTICE_BYTES = 10 * 1024 * 1024;

export type CoverKind = 'svg' | 'png';

export interface Cover {
  kind: CoverKind;
  /** SVG source, or base64 of a PNG. */
  data: string;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

const ELEMENTS = new Set([
  'svg', 'g', 'defs', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon',
  'text', 'tspan', 'title', 'desc', 'linearGradient', 'radialGradient', 'stop', 'clipPath', 'mask', 'symbol', 'use',
]);

const ATTRIBUTES = new Set([
  'id', 'class', 'xmlns', 'version', 'viewBox', 'width', 'height', 'preserveAspectRatio',
  'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'fx', 'fy', 'd', 'points',
  'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit', 'stroke-dasharray', 'stroke-dashoffset',
  'fill-opacity', 'stroke-opacity', 'opacity', 'fill-rule', 'clip-rule', 'transform', 'gradientTransform', 'gradientUnits',
  'spreadMethod', 'offset', 'stop-color', 'stop-opacity', 'clip-path', 'mask', 'clipPathUnits', 'maskUnits',
  'font-family', 'font-size', 'font-weight', 'text-anchor', 'dominant-baseline', 'href', 'xlink:href', 'xmlns:xlink',
]);

/** Elements whose text is shown; text anywhere else is dropped. */
const TEXT_ELEMENTS = new Set(['text', 'tspan', 'title', 'desc']);

const TAG = /<\/?[A-Za-z][^\s/>]*(?:\s+[^\s=/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*\s*\/?>/y;
const ATTR = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
const COMMENT = /<!--[\s\S]*?-->/y;
const PROLOG = /<\?[\s\S]*?\?>|<!DOCTYPE[^>[]*(?:\[[\s\S]*?\])?\s*>|<!\[CDATA\[[\s\S]*?\]\]>/iy;
const BAD_ENTITY = /&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);)/i;

const invalid = (why: string) => new KeelError(`That isn't an SVG Keel can use: ${why}.`, 'Export a plain SVG (shapes, paths and text), without scripts or linked images.');

/** An attribute value that could load or run something. */
function unsafeValue(name: string, value: string): boolean {
  if (/[<>]/.test(value) || BAD_ENTITY.test(value)) return true;
  if (/javascript:|data:|vbscript:/i.test(value)) return true;
  // References are fine only inside the file: url(#id) and href="#id".
  for (const m of value.matchAll(/url\(\s*([^)]*)\)/gi)) if (!/^["']?#/.test(m[1]!.trim())) return true;
  if ((name === 'href' || name === 'xlink:href') && !value.trim().startsWith('#')) return true;
  return false;
}

/**
 * Returns a cleaned copy of an SVG: drawing elements and attributes only, no script,
 * styles, event handlers, links, images or references outside the file. Throws when
 * the text isn't an SVG at all, or is too big.
 */
export function sanitizeSvg(source: string): string {
  if (Buffer.byteLength(source) > MAX_COVER_BYTES) throw tooBig(Buffer.byteLength(source));
  const text = source.replace(/^﻿/, '');
  let out = '';
  const stack: string[] = [];
  let skipping: { name: string; depth: number } | null = null;
  let rootDone = false;
  let pos = 0;

  while (pos < text.length) {
    let m: RegExpExecArray | null = null;
    if (text[pos] !== '<') {
      const end = text.indexOf('<', pos);
      const chunk = text.slice(pos, end === -1 ? text.length : end);
      pos += chunk.length;
      if (BAD_ENTITY.test(chunk)) throw invalid('it uses an entity Keel does not allow');
      if (!skipping && stack.length && TEXT_ELEMENTS.has(stack[stack.length - 1]!)) out += chunk;
      else if (!skipping && chunk.trim() && (!stack.length || rootDone)) throw invalid('there is text outside the <svg> element');
      continue;
    }
    for (const re of [COMMENT, PROLOG]) {
      re.lastIndex = pos;
      if ((m = re.exec(text)) && m.index === pos) break;
      m = null;
    }
    if (m) {
      pos += m[0].length;
      continue;
    }
    TAG.lastIndex = pos;
    m = TAG.exec(text);
    if (!m || m.index !== pos) throw invalid('it has a broken tag');
    pos += m[0].length;

    const tag = m[0];
    const closing = tag.startsWith('</');
    const selfClosing = tag.endsWith('/>');
    const name = /^<\/?([^\s/>]+)/.exec(tag)![1]!;

    if (skipping) {
      if (name === skipping.name) {
        if (closing) skipping.depth--;
        else if (!selfClosing) skipping.depth++;
        if (skipping.depth === 0) skipping = null;
      }
      continue;
    }

    if (closing) {
      if (stack.pop() !== name) throw invalid('its tags do not match');
      out += `</${name}>`;
      if (!stack.length) rootDone = true;
      continue;
    }

    if (!ELEMENTS.has(name)) {
      // Not a drawing element (script, style, image, foreignObject, a, animate ...): drop it with what is inside.
      if (!selfClosing) skipping = { name, depth: 1 };
      continue;
    }
    if (!stack.length && (name !== 'svg' || rootDone)) throw invalid('it must be one <svg> element');

    let attrs = '';
    let hasNs = false;
    const body = tag.slice(1 + name.length, tag.length - (selfClosing ? 2 : 1));
    for (const a of body.matchAll(ATTR)) {
      const attr = a[1]!;
      const value = a[2] ?? a[3] ?? a[4] ?? '';
      if (!ATTRIBUTES.has(attr) || unsafeValue(attr, value)) continue;
      if (attr === 'xmlns') {
        if (value !== SVG_NS) continue;
        hasNs = true;
      }
      attrs += ` ${attr}="${value.replace(/"/g, '&quot;')}"`;
    }
    if (name === 'svg' && !stack.length && !hasNs) attrs = ` xmlns="${SVG_NS}"${attrs}`;
    out += `<${name}${attrs}${selfClosing ? '/>' : '>'}`;
    if (!selfClosing) stack.push(name);
    else if (!stack.length) rootDone = true;
  }

  if (skipping || stack.length) throw invalid('its tags are not closed');
  if (!rootDone) throw invalid('there is no <svg> element');
  if (Buffer.byteLength(out) > MAX_COVER_BYTES) throw tooBig(Buffer.byteLength(out));
  return out;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const tooBig = (bytes: number) => new KeelError(`That cover is ${Math.ceil(bytes / 1024)} KB, and the most is ${MAX_COVER_BYTES / 1024} KB.`, 'Make the image smaller or simpler (for a PNG, fewer colors and a smaller size).');

/** A PNG's bytes as a stored cover, after checking it is a PNG and fits. */
export function pngCover(bytes: Uint8Array): Cover {
  const buf = Buffer.from(bytes);
  if (buf.length < PNG_SIGNATURE.length || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) throw new KeelError("That isn't a PNG image.", 'Covers are SVG or PNG files.');
  if (buf.length > MAX_COVER_BYTES) throw tooBig(buf.length);
  return { kind: 'png', data: buf.toString('base64') };
}

/** An SVG or PNG file's bytes as a stored cover. The format is read from the content, not the file name. */
export function coverFromBytes(bytes: Uint8Array): Cover {
  const buf = Buffer.from(bytes);
  if (buf.length >= 4 && buf.subarray(0, 4).equals(PNG_SIGNATURE.subarray(0, 4))) return pngCover(buf);
  const head = buf.subarray(0, 512).toString('utf8').replace(/^﻿/, '').trimStart();
  if (/^(<\?xml|<!--|<!DOCTYPE|<svg)/i.test(head)) return { kind: 'svg', data: sanitizeSvg(buf.toString('utf8')) };
  throw new KeelError("That file isn't an SVG or a PNG.", 'Covers are SVG or PNG files, up to 200 KB.');
}

/** Checks a cover already in text form (SVG source, or base64 PNG) before it is saved. */
export function checkCover(kind: CoverKind, data: string): Cover {
  if (kind === 'svg') return { kind, data: sanitizeSvg(data) };
  if (kind === 'png') {
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw new KeelError("That isn't a PNG image.", 'Covers are SVG or PNG files.');
    return pngCover(Buffer.from(data, 'base64'));
  }
  throw new KeelError(`Unknown cover type "${String(kind)}".`, 'Use svg or png.');
}

/** "3.2 MB", "120 KB". */
export function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
