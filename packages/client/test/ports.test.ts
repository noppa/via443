import { describe, expect, it } from 'vitest';
import { parsePorts } from '../src/ports.ts';

describe('parsePorts', () => {
  it('parses plain and named ports', () => {
    expect(parsePorts(['3000', 'api=3001'])).toEqual([
      { name: '3000', port: 3000 },
      { name: 'api', port: 3001 },
    ]);
  });

  it('rejects invalid ports and names', () => {
    for (const value of ['', 'abc', '0', '65536', '30.5', 'api=', '=3000', 'a b=3000', 'api=x']) {
      expect(() => parsePorts([value]), value).toThrow();
    }
  });

  it('rejects duplicate names', () => {
    expect(() => parsePorts(['api=3000', 'api=3001'])).toThrow(/used twice/);
    expect(() => parsePorts(['3000', '3000'])).toThrow(/used twice/);
  });
});
