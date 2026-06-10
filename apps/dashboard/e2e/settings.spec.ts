import { test, expect, type Route, type Request } from '@playwright/test';
import { loginAs } from './helpers/api-mock';

test.describe('settings', () => {
  test('i18n: switching to Français translates the UI', async ({ page }) => {
    await loginAs(page);
    // Appearance tab hosts the language selector.
    await page.goto('/dashboard/settings?tab=appearance');

    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
    await page.getByRole('button', { name: /Français/ }).click();

    // Page heading + a sidebar item flip to the FR strings.
    await expect(page.getByRole('heading', { name: 'Paramètres' })).toBeVisible();
    await expect(page.getByRole('navigation').getByRole('link', { name: 'Projets' })).toBeVisible();
  });

  test('notification toggle PUTs the expected body', async ({ page }) => {
    let putBody: unknown = null;

    await loginAs(page, {
      handlers: [
        {
          path: '/users/me/notification-preferences',
          body: { prefs: {} },
        },
        {
          method: 'PUT',
          path: '/users/me/notification-preferences',
          body: (_route: Route, request: Request) => {
            putBody = request.postDataJSON();
            return putBody as object; // echo, like the real API
          },
        },
      ],
    });
    await page.goto('/dashboard/settings?tab=notifications');

    // First row = 'Deployment completed' event; first toggle = email channel.
    const firstRow = page.getByRole('row', { name: /Deployment completed/ });
    await expect(firstRow).toBeVisible();

    const putDone = page.waitForRequest(
      (req) => req.method() === 'PUT' && req.url().includes('/users/me/notification-preferences'),
    );
    await firstRow.getByRole('button').first().click();
    await putDone;

    expect(putBody).toEqual({ prefs: { deployOk: { email: true } } });
  });
});
