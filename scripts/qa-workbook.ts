const failures: unknown[] = [];
for (const run of [
  () => import('./qa-render.tsx'),
  () => import('./qa-design-principles.tsx'),
  () => import('./qa-layouts.ts'),
  () => import('./qa-geography.ts'),
]) {
  try {
    await run();
  } catch (error) {
    console.error(error);
    failures.push(error);
  }
}
if (failures.length) process.exitCode = 1;
