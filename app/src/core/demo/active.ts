/**
 * Whether this process runs on demo data. Kept apart from the generator so the actions that must
 * refuse network work in demo mode do not pull in the generator.
 */

export function demoActive(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.CURLEW_DEMO?.trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}
