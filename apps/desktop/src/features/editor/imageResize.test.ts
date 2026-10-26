import { describe, expect, it } from 'vitest';
import { withWidth } from './imageResize';

describe('0.1.2: the width an image resize writes into its link', () => {
  it('sets or replaces a wiki embed size, keeping its target and heading', () => {
    expect(withWidth('![[moon.png]] after', 420)).toEqual({ to: 13, insert: '![[moon.png|420]]' });
    expect(withWidth('![[a/moon.png|300]]', 200)?.insert).toBe('![[a/moon.png|200]]');
    expect(withWidth('![[moon.png|300x200]]', 150)?.insert).toBe('![[moon.png|150]]');
    expect(withWidth('![[Page#Pic|300]]', 150)?.insert).toBe('![[Page#Pic|150]]');
  });

  it('a wiki embed whose `|…` is text stays as written', () => {
    expect(withWidth('![[moon.png|The moon]]', 300)).toBeNull();
  });

  it('puts the size after a Markdown image alt, the way Obsidian reads it', () => {
    expect(withWidth('![moon](file:///v/moon.png)', 300)).toEqual({
      to: 8,
      insert: '![moon|300](',
    });
    expect(withWidth('![moon|120x80](x.png)', 300)?.insert).toBe('![moon|300](');
    expect(withWidth('![](x.png)', 64)?.insert).toBe('![|64](');
  });

  it('anything that does not start with an image link is not resized', () => {
    expect(withWidth('| a | ![[x.png]] |', 300)).toBeNull();
    expect(withWidth('> ![[x.png]]', 300)).toBeNull();
    expect(withWidth('[[x.png]]', 300)).toBeNull();
  });
});
