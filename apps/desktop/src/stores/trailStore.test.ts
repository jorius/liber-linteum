import { beforeEach, describe, expect, it } from 'vitest';
import { useTrailStore } from './trailStore';

const trail = () => useTrailStore.getState();
const e = (path: string, heading: string | null = null) => ({ path, heading });

beforeEach(() => trail().reset());

describe('link trail (M2b §3)', () => {
  it('following links builds the trail; back and forward walk it', () => {
    trail().followed(e('A.md'));
    trail().followed(e('B.md'));
    expect(trail().back).toEqual([e('A.md'), e('B.md')]);
    expect(trail().goBack(e('C.md'))).toEqual(e('B.md'));
    expect(trail().forward).toEqual([e('C.md')]);
    expect(trail().goBack(e('B.md'))).toEqual(e('A.md'));
    expect(trail().goBack(e('A.md'))).toBeNull();
    expect(trail().goForward(e('A.md'))).toEqual(e('B.md'));
    expect(trail().goForward(e('B.md'))).toEqual(e('C.md'));
    expect(trail().goForward(e('C.md'))).toBeNull();
  });

  it('a new link after going back drops the forward branch', () => {
    trail().followed(e('A.md'));
    trail().goBack(e('B.md'));
    trail().followed(e('A.md'));
    expect(trail().forward).toEqual([]);
  });

  it('reset clears both directions', () => {
    trail().followed(e('A.md'));
    trail().goBack(e('B.md'));
    trail().reset();
    expect(trail().back).toEqual([]);
    expect(trail().forward).toEqual([]);
  });

  it('renames (files and folders) are followed', () => {
    trail().followed(e('Notes/A.md', 'Intro'));
    trail().followed(e('B.md'));
    trail().renamed('Notes', 'Archive');
    trail().renamed('B.md', 'Bee.md');
    expect(trail().back).toEqual([e('Archive/A.md', 'Intro'), e('Bee.md')]);
  });

  it('deleted pages leave the trail, without two equal pages next to each other', () => {
    trail().followed(e('A.md'));
    trail().followed(e('B.md'));
    trail().followed(e('A.md'));
    trail().goBack(e('C.md'));
    trail().removed('B.md');
    expect(trail().back).toEqual([e('A.md')]);
    trail().removed('C.md');
    expect(trail().forward).toEqual([]);
  });

  it('final review m3: pruning never leaves the current page next on either side', () => {
    trail().followed(e('A.md'));
    trail().followed(e('B.md'));
    trail().removed('B.md', { current: 'A.md' });
    expect(trail().back).toEqual([]);
    useTrailStore.setState({ forward: [e('C.md'), e('A.md'), e('B.md')] });
    trail().removed('B.md', { current: 'A.md' });
    expect(trail().forward).toEqual([e('C.md')]);
  });
});
