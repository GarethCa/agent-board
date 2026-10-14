import { describe, expect, it } from 'vitest';
import { splitReviewerName } from './tile-name';

describe('splitReviewerName', () => {
  it('moves the review suffix to a subtitle', () => {
    expect(splitReviewerName('Write the code · review r1')).toEqual({ name: 'Write the code', subtitle: 'Review · r1' });
    expect(splitReviewerName('A · b · review r12')).toEqual({ name: 'A · b', subtitle: 'Review · r12' });
  });

  it('leaves any other name whole', () => {
    expect(splitReviewerName('Write the code')).toEqual({ name: 'Write the code' });
    expect(splitReviewerName('review r1')).toEqual({ name: 'review r1' });
    expect(splitReviewerName(' · review r1')).toEqual({ name: ' · review r1' });
  });
});
