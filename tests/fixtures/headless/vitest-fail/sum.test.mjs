import { describe, expect, it } from 'vitest';

describe('headless fixture', () => {
  it('adds numbers', () => {
    expect(1 + 1).toBe(2);
  });

  it('is deliberately red', () => {
    expect(1 + 1).toBe(3);
  });
});
