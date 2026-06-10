import { test, expect } from '@playwright/test';
import { mockApi, loginAs, makeUser } from './helpers/api-mock';

test.describe('login page', () => {
  test('renders the login form', async ({ page }) => {
    await mockApi(page);
    await page.goto('/login');

    await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
    await expect(page.getByLabel('Email')).toBeVisible();
    await expect(page.getByLabel('Password')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  });

  test('shows an error toast on invalid credentials (401)', async ({ page }) => {
    await mockApi(page, [
      {
        method: 'POST',
        path: '/auth/login',
        status: 401,
        body: { message: 'Invalid credentials', statusCode: 401 },
      },
    ]);
    await page.goto('/login');

    await page.getByLabel('Email').fill('wrong@e2e.test');
    await page.getByLabel('Password').fill('bad-password');
    await page.getByRole('button', { name: 'Sign in' }).click();

    // sonner renders toasts in [data-sonner-toast] elements
    await expect(page.locator('[data-sonner-toast]')).toContainText('Invalid credentials');
    await expect(page).toHaveURL(/\/login/);
  });

  test('redirects to /dashboard on successful login', async ({ page }) => {
    const user = makeUser('USER');
    await mockApi(page, [
      {
        method: 'POST',
        path: '/auth/login',
        // Real response shape (see login/page.tsx): { user, accessToken }.
        body: { user, accessToken: 'e2e-access-token' },
      },
    ]);
    await page.goto('/login');

    await page.getByLabel('Email').fill(user.email);
    await page.getByLabel('Password').fill('correct-horse');
    await page.getByRole('button', { name: 'Sign in' }).click();

    await expect(page).toHaveURL(/\/dashboard$/);
  });
});

test.describe('route guards', () => {
  test('unauthenticated visit to /dashboard redirects to /login', async ({ page }) => {
    await mockApi(page);
    await page.goto('/dashboard');

    await expect(page).toHaveURL(/\/login/);
  });

  test('authenticated visit to /login redirects to /dashboard', async ({ page }) => {
    await loginAs(page, { role: 'USER' });
    await page.goto('/login');

    await expect(page).toHaveURL(/\/dashboard$/);
  });
});
