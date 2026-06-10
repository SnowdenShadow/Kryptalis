import { test, expect } from '@playwright/test';
import { loginAs, type MockHandler } from './helpers/api-mock';

const NOW = new Date().toISOString();

/**
 * Two apps in two states so both the Stop (running) and Start (stopped)
 * action buttons render on the list page at the same time.
 */
const runningApp = {
  id: 'app-1',
  name: 'atlas-web',
  slugName: 'atlas-web',
  projectId: 'proj-1',
  framework: 'NEXTJS',
  status: 'RUNNING',
  gitUrl: 'https://github.com/acme/atlas-web.git',
  gitBranch: 'main',
  dockerImage: null,
  buildCommand: 'npm run build',
  startCommand: 'npm start',
  port: 3000,
  createdAt: NOW,
  updatedAt: NOW,
  project: { id: 'proj-1', name: 'Atlas' },
  domains: [],
  portBindings: [],
};

const stoppedApp = {
  id: 'app-2',
  name: 'atlas-worker',
  slugName: 'atlas-worker',
  projectId: 'proj-1',
  framework: 'EXPRESS',
  status: 'STOPPED',
  gitUrl: null,
  gitBranch: null,
  dockerImage: null,
  buildCommand: null,
  startCommand: null,
  port: 4001,
  createdAt: NOW,
  updatedAt: NOW,
  project: { id: 'proj-1', name: 'Atlas' },
  domains: [],
  portBindings: [],
};

const handlers: MockHandler[] = [
  { path: '/applications', body: [runningApp, stoppedApp] },
  // Detail page fires GET /applications/:id on mount (plus GET /domains,
  // covered by the helper defaults). Deployments/logs queries are
  // tab-gated (`enabled: activeTab === ...`) so they don't fire here.
  { path: '/applications/app-1', body: runningApp },
  { path: '/applications/app-1/deployments', body: [] },
];

test.describe('applications', () => {
  test('renders the mocked list with RUNNING and STOPPED statuses', async ({ page }) => {
    await loginAs(page, { handlers });
    await page.goto('/dashboard/applications');

    await expect(page.getByRole('heading', { name: 'Applications' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'atlas-web' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'atlas-worker' })).toBeVisible();
    // Status labels on the cards. `span:text-is(...)` keeps the locator off
    // the identical strings inside the status-filter <option> elements.
    await expect(page.locator('span:text-is("Running")')).toBeVisible();
    await expect(page.locator('span:text-is("Stopped")')).toBeVisible();
  });

  test('clicking an app card opens its detail page', async ({ page }) => {
    await loginAs(page, { handlers });
    await page.goto('/dashboard/applications');

    await page.getByRole('heading', { name: 'atlas-web' }).click();

    await expect(page).toHaveURL(/\/dashboard\/applications\/app-1$/);
    await expect(page.getByRole('heading', { name: 'atlas-web' })).toBeVisible();
    // Overview tab content confirms the detail queries resolved.
    await expect(page.getByText('Connection Info')).toBeVisible();
  });

  test('detail page Redeploy button POSTs /applications/:id/redeploy', async ({ page }) => {
    await loginAs(page, {
      handlers: [
        ...handlers,
        { method: 'POST', path: '/applications/app-1/redeploy', body: { id: 'dep-1', status: 'PENDING' } },
      ],
    });
    await page.goto('/dashboard/applications/app-1');

    const posted = page.waitForRequest(
      (req) => req.method() === 'POST' && new URL(req.url()).pathname.endsWith('/applications/app-1/redeploy'),
    );
    await page.getByRole('button', { name: 'Redeploy' }).click();
    await posted;
  });

  test('detail page Stop button POSTs /applications/:id/stop', async ({ page }) => {
    await loginAs(page, {
      handlers: [
        ...handlers,
        { method: 'POST', path: '/applications/app-1/stop', body: {} },
      ],
    });
    await page.goto('/dashboard/applications/app-1');
    await expect(page.getByRole('heading', { name: 'atlas-web' })).toBeVisible();

    const posted = page.waitForRequest(
      (req) => req.method() === 'POST' && new URL(req.url()).pathname.endsWith('/applications/app-1/stop'),
    );
    await page.getByRole('button', { name: 'Stop' }).click();
    await posted;
  });

  test('list Start button on a stopped app POSTs /applications/:id/start', async ({ page }) => {
    await loginAs(page, {
      handlers: [
        ...handlers,
        { method: 'POST', path: '/applications/app-2/start', body: {} },
      ],
    });
    await page.goto('/dashboard/applications');
    await expect(page.getByRole('heading', { name: 'atlas-worker' })).toBeVisible();

    const posted = page.waitForRequest(
      (req) => req.method() === 'POST' && new URL(req.url()).pathname.endsWith('/applications/app-2/start'),
    );
    // Only the STOPPED app renders a Start button; `exact` keeps the
    // running app's "Restart" button out of the match.
    await page.getByRole('button', { name: 'Start', exact: true }).click();
    await posted;
  });
});
