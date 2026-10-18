import { describe, expect, it } from 'vitest';
import * as connectors from './index';

describe('@foresite/connectors', () => {
  it('has an empty public API until the first connector lands', () => {
    expect(Object.keys(connectors)).toEqual([]);
  });
});
