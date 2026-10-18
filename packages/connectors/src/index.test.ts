import { describe, expect, it } from 'vitest';
import * as connectors from './index';

describe('@foresite/connectors', () => {
  it('exposes the counters namespace and nothing else yet', () => {
    expect(Object.keys(connectors)).toEqual(['counters']);
    expect(connectors.counters.counterProviders()).toEqual(['milesight']);
  });
});
