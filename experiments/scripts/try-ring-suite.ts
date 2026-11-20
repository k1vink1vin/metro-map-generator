for (const f of [() => import('./qa-render.tsx'), () => import('./qa-design-principles.tsx'), () => import('./qa-layouts.ts'), () => import('./qa-geography.ts')]) {
 try { await f(); } catch (e) { console.error(e); process.exitCode = 1; }
}
