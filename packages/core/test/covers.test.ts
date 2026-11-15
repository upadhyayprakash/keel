import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkCover, coverFromBytes, MAX_COVER_BYTES, pngCover, sanitizeSvg } from '../src/covers';
import { KeelError } from '../src/errors';

const clean = (body: string, attrs = '') => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"${attrs}>${body}</svg>`;
// 1x1 transparent PNG.
const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

describe('sanitizeSvg', () => {
  it('keeps plain drawings as they are', () => {
    const svg = clean('<g stroke="#000" stroke-width="4"><path d="M0 0 L10 10"/><circle cx="5" cy="5" r="2" fill="#fff"/></g>');
    expect(sanitizeSvg(svg)).toBe(svg);
  });

  it('adds the namespace an <img> needs, and drops a wrong one', () => {
    expect(sanitizeSvg('<svg viewBox="0 0 1 1"><rect width="1" height="1"/></svg>')).toBe('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect width="1" height="1"/></svg>');
    expect(sanitizeSvg('<svg xmlns="http://evil.example/" viewBox="0 0 1 1"/>')).toContain('xmlns="http://www.w3.org/2000/svg"');
  });

  it('removes script with everything inside it', () => {
    const out = sanitizeSvg(clean('<script>alert(1)</script><rect width="1" height="1"/>'));
    expect(out).not.toMatch(/script|alert/i);
    expect(out).toContain('<rect');
  });

  it('removes nested foreignObject, style, image, links and animation', () => {
    const body = [
      '<foreignObject><div><foreignObject>x</foreignObject>html</div></foreignObject>',
      '<style>@import url(http://evil.example/a.css);</style>',
      '<image href="http://evil.example/a.png"/>',
      '<a href="javascript:alert(1)"><rect width="1" height="1"/></a>',
      '<animate attributeName="href" to="javascript:alert(1)"/>',
      '<set attributeName="href" to="x"/>',
      '<iframe src="x"></iframe>',
      '<circle r="1"/>',
    ].join('');
    const out = sanitizeSvg(clean(body));
    expect(out).toBe(clean('<circle r="1"/>'));
  });

  it('removes event handlers, styles and scripted or external references from attributes', () => {
    const out = sanitizeSvg(
      clean('<rect onclick="alert(1)" onload="x()" style="fill:red" width="1" fill="url(http://evil.example/x)" stroke="url(#ok)" href="javascript:1"/><use href="http://evil.example/a.svg#x"/><use href="#ok"/>'),
    );
    expect(out).not.toMatch(/onclick|onload|style=|evil|javascript/i);
    expect(out).toContain('stroke="url(#ok)"');
    expect(out).toContain('<use href="#ok"/>');
  });

  it('drops the xml prolog, doctype and entity definitions, and refuses unknown entities', () => {
    const out = sanitizeSvg('<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY x "boom">]><svg viewBox="0 0 1 1"><text>a &amp; b</text></svg>');
    expect(out).toBe('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><text>a &amp; b</text></svg>');
    expect(() => sanitizeSvg(clean('<text>&x;</text>'))).toThrow(KeelError);
  });

  it('refuses what is not one SVG', () => {
    for (const bad of ['', 'hello', '<div></div>', '<svg><g></svg>', '<svg></svg><svg></svg>', '<svg viewBox="0 0 1 1"><rect', 'text<svg/>']) {
      expect(() => sanitizeSvg(bad), bad).toThrow(KeelError);
    }
  });

  it('refuses a cover over 200 KB', () => {
    const big = clean(`<path d="${'M0 0 L1 1 '.repeat(MAX_COVER_BYTES / 8)}"/>`);
    expect(() => sanitizeSvg(big)).toThrow(/200 KB/);
  });

  it('accepts the placeholder drafts from ADR 0005', () => {
    const dir = join(__dirname, '../../../docs/adr/0005-cover-test');
    for (const file of ['cover-placeholder.svg', 'cover-placeholder-dark.svg', 'grocery.svg', 'release-dark.svg', 'trip.svg']) {
      const src = readFileSync(join(dir, file), 'utf8');
      const out = sanitizeSvg(src);
      expect(out).toContain('<svg');
      expect(out).not.toContain('<script');
      // Drawings keep their shapes.
      expect((out.match(/<(path|rect|circle)\b/g) ?? []).length).toBe((src.match(/<(path|rect|circle)\b/g) ?? []).length);
    }
  });
});

describe('png and file covers', () => {
  it('accepts a real PNG and refuses other bytes or a big one', () => {
    expect(pngCover(PNG_1X1).kind).toBe('png');
    expect(() => pngCover(Buffer.from('not a png'))).toThrow(/PNG/);
    expect(() => pngCover(Buffer.concat([PNG_1X1, Buffer.alloc(MAX_COVER_BYTES)]))).toThrow(/200 KB/);
  });

  it('reads the format from the content', () => {
    expect(coverFromBytes(PNG_1X1).kind).toBe('png');
    expect(coverFromBytes(Buffer.from(clean('<rect width="1" height="1"/>'))).kind).toBe('svg');
    expect(() => coverFromBytes(Buffer.from('GIF89a....'))).toThrow(/SVG or a PNG/);
  });

  it('checks stored covers by kind', () => {
    expect(checkCover('png', PNG_1X1.toString('base64')).kind).toBe('png');
    expect(() => checkCover('png', 'not base64!')).toThrow(KeelError);
    expect(checkCover('svg', clean('<rect/>')).data).toContain('<rect/>');
  });
});

describe('the built-in placeholder', () => {
  it('is a clean SVG in a light and a dark version', async () => {
    const { COVER_PLACEHOLDER } = await import('../src/cover-placeholder');
    for (const svg of [COVER_PLACEHOLDER.light, COVER_PLACEHOLDER.dark]) {
      // Cleaning removes nothing but the whitespace between tags.
      expect(sanitizeSvg(svg)).toBe(svg.replace(/>\s+</g, '><'));
      expect(Buffer.byteLength(svg)).toBeLessThan(2048);
    }
    expect(COVER_PLACEHOLDER.light).not.toBe(COVER_PLACEHOLDER.dark);
  });
});
