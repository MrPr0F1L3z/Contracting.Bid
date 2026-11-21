import { describe, expect, it } from 'vitest';
import { PRIVATE_PATHS, robotsRules } from '../src/lib/robots';

describe('robotsRules', () => {
  it('blocks only the private screens on the live site', () => {
    expect(robotsRules(undefined)).toEqual({ rules: [{ userAgent: '*', allow: '/', disallow: PRIVATE_PATHS }] });
    expect(robotsRules('production')).toEqual(robotsRules(undefined));
  });

  it('blocks every crawler on staging, whatever the case or spacing', () => {
    expect(robotsRules('staging')).toEqual({ rules: [{ userAgent: '*', disallow: '/' }] });
    expect(robotsRules(' Staging ')).toEqual(robotsRules('staging'));
  });

  it('keeps the workspace, onboarding, reset and trial-ended screens private', () => {
    expect(PRIVATE_PATHS).toEqual(['/app', '/onboarding', '/reset', '/trial-ended']);
  });
});
