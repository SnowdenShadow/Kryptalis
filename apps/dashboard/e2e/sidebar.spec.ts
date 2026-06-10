import { test, expect } from '@playwright/test';
import { loginAs } from './helpers/api-mock';

/**
 * Role comes from the persisted zustand user (`kryptalis-auth`), which
 * loginAs seeds; the sidebar reads `useAuthStore().user.role` directly
 * (no /auth/me round-trip needed for the nav itself).
 */
test.describe('sidebar role gating', () => {
  test('USER does not see Docker / Monitoring / Server / Admin items', async ({ page }) => {
    await loginAs(page, { role: 'USER' });
    await page.goto('/dashboard');

    const nav = page.getByRole('navigation');
    // Anchor on an item everyone has, so we know the sidebar rendered.
    await expect(nav.getByRole('link', { name: 'Projects' })).toBeVisible();

    await expect(nav.getByRole('link', { name: 'Docker' })).toHaveCount(0);
    await expect(nav.getByRole('link', { name: 'Monitoring' })).toHaveCount(0);
    // 'Server' entry is multiOnly AND adminOnly — absent for USER either way.
    await expect(nav.getByRole('link', { name: 'Server', exact: true })).toHaveCount(0);
    await expect(nav.getByRole('link', { name: 'Admin' })).toHaveCount(0);
  });

  test('ADMIN sees Docker / Monitoring / Admin items', async ({ page }) => {
    await loginAs(page, { role: 'ADMIN' });
    await page.goto('/dashboard');

    const nav = page.getByRole('navigation');
    await expect(nav.getByRole('link', { name: 'Docker' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Monitoring' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Admin' })).toBeVisible();
  });

  test('ADMIN sees Server item in MULTI deployment mode', async ({ page }) => {
    await loginAs(page, {
      role: 'ADMIN',
      handlers: [{ path: '/settings/public', body: { deployment_mode: 'MULTI' } }],
    });
    await page.goto('/dashboard');

    const nav = page.getByRole('navigation');
    await expect(nav.getByRole('link', { name: 'Server', exact: true })).toBeVisible();
  });
});
