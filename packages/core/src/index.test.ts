import { describe, expect, it } from 'vitest';
import * as core from './index';

describe('@foresite/core', () => {
  it('has an empty public API until the model PR lands', () => {
    expect(Object.keys(core)).toEqual([]);
  });
});
