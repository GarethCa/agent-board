import { describe, expect, it } from 'vitest';
import { classifyDrop, classifyPaste, imageBoardSize, imageProblem } from './paste';

const file = (type: string, size = 10) => ({ type, size }) as File;

describe('classifyPaste', () => {
  it('takes pasted image files over any text', () => {
    const png = file('image/png');
    expect(classifyPaste({ files: [png], text: 'https://x.test' })).toEqual({ type: 'images', files: [png] });
  });

  it('takes one https URL, trimmed and normalised', () => {
    expect(classifyPaste({ files: [], text: '  https://Example.com/a?b=1  \n' })).toEqual({
      type: 'link',
      url: 'https://example.com/a?b=1',
    });
  });

  it('leaves other text alone, including a URL among words', () => {
    expect(classifyPaste({ files: [], text: 'see https://example.com' })).toEqual({ type: 'nothing' });
    expect(classifyPaste({ files: [], text: 'hello' })).toEqual({ type: 'nothing' });
    expect(classifyPaste({ files: [], text: 'mailto:a@b.test' })).toEqual({ type: 'nothing' });
    expect(classifyPaste({ files: [], text: '' })).toEqual({ type: 'nothing' });
  });

  it('refuses an http link, which would not open from the app, and one that is too long', () => {
    expect(classifyPaste({ files: [], text: 'http://example.com' })).toMatchObject({ type: 'refused' });
    expect(classifyPaste({ files: [], text: `https://example.com/${'a'.repeat(3000)}` })).toMatchObject({ type: 'refused' });
  });
});

describe('classifyDrop', () => {
  it('takes the images among the files and refuses a drop of none', () => {
    const png = file('image/png');
    expect(classifyDrop([file('text/plain'), png])).toEqual({ type: 'images', files: [png] });
    expect(classifyDrop([file('text/plain')])).toMatchObject({ type: 'refused' });
    expect(classifyDrop([])).toEqual({ type: 'nothing' });
  });
});

describe('imageProblem', () => {
  it('names a file over 20 MB or of a type the board does not take', () => {
    expect(imageProblem(file('image/png', 5))).toBeUndefined();
    expect(imageProblem(file('image/png', 20 * 1024 * 1024 + 1))).toBe('the image is over 20 MB');
    expect(imageProblem(file('image/svg+xml'))).toMatch(/only PNG/);
  });
});

describe('imageBoardSize', () => {
  it('shrinks a big image to fit, keeping its aspect ratio, and never grows a small one', () => {
    expect(imageBoardSize({ width: 1800, height: 900 })).toEqual({ width: 360, height: 180 });
    expect(imageBoardSize({ width: 100, height: 50 })).toEqual({ width: 100, height: 50 });
    expect(imageBoardSize({ width: 1, height: 5000 })).toEqual({ width: 1, height: 360 });
  });
});
