import { test, expect, type Route, type Request } from '@playwright/test';
import { loginAs, type MockHandler } from './helpers/api-mock';

const NOW = new Date().toISOString();

/**
 * Project-creation flow in LOCAL mode. The page decides LOCAL vs MULTI from
 * GET /settings/public (`deployment_mode`) — the helper default is already
 * LOCAL — and auto-selects the server from GET /servers/local-public
 * (helper default: { id: 'srv-local', name: 'local' }), so the dialog needs
 * no server interaction here.
 */

function makeCreatedProject(name: string, description: string | null) {
  return {
    id: 'proj-new',
    name,
    description,
    serverId: 'srv-local',
    createdAt: NOW,
    updatedAt: NOW,
    server: { id: 'srv-local', name: 'local' },
    applications: [],
  };
}

test.describe('project creation', () => {
  test('dialog opens prefilled for LOCAL mode (server fixed, no dropdown)', async ({ page }) => {
    await loginAs(page);
    await page.goto('/dashboard/projects');

    await page.getByRole('button', { name: 'New Project' }).first().click();

    await expect(page.getByRole('heading', { name: 'New Project' })).toBeVisible();
    await expect(page.getByLabel(/Name/)).toBeVisible();
    await expect(page.getByLabel('Description')).toBeVisible();
    // LOCAL mode: server is displayed read-only, not selectable.
    await expect(page.getByText('platform is in LOCAL mode')).toBeVisible();
    await expect(page.getByText('local', { exact: true })).toBeVisible();
  });

  test('submit POSTs /projects with the right body and the list refreshes', async ({ page }) => {
    // GET /projects flips from empty to the created project after the POST —
    // mirrors the real backend so the react-query invalidation refetch
    // actually has something new to render.
    let projects: unknown[] = [];
    let postBody: unknown = null;

    const handlers: MockHandler[] = [
      { path: '/projects', body: () => projects },
      {
        method: 'POST',
        path: '/projects',
        status: 201,
        body: (_route: Route, request: Request) => {
          postBody = request.postDataJSON();
          const { name, description } = postBody as { name: string; description?: string };
          const created = makeCreatedProject(name, description ?? null);
          projects = [created];
          return created;
        },
      },
    ];

    await loginAs(page, { handlers });
    await page.goto('/dashboard/projects');

    await page.getByRole('button', { name: 'New Project' }).first().click();
    await page.getByLabel(/Name/).fill('Borealis');
    await page.getByLabel('Description').fill('Northern services');

    const posted = page.waitForRequest(
      (req) => req.method() === 'POST' && new URL(req.url()).pathname.endsWith('/projects'),
    );
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    await posted;

    expect(postBody).toEqual({
      name: 'Borealis',
      description: 'Northern services',
      serverId: 'srv-local',
    });

    // Dialog closes + invalidated list refetch shows the new project.
    await expect(page.getByRole('heading', { name: 'New Project' })).toBeHidden();
    await expect(page.getByRole('heading', { name: 'Borealis' })).toBeVisible();
    await expect(page.getByText('Northern services')).toBeVisible();
  });

  test('description is omitted from the body when left empty', async ({ page }) => {
    let postBody: unknown = null;

    await loginAs(page, {
      handlers: [
        {
          method: 'POST',
          path: '/projects',
          status: 201,
          body: (_route: Route, request: Request) => {
            postBody = request.postDataJSON();
            return makeCreatedProject('Cassini', null);
          },
        },
      ],
    });
    await page.goto('/dashboard/projects');

    await page.getByRole('button', { name: 'New Project' }).first().click();
    await page.getByLabel(/Name/).fill('Cassini');

    const posted = page.waitForRequest(
      (req) => req.method() === 'POST' && new URL(req.url()).pathname.endsWith('/projects'),
    );
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    await posted;

    expect(postBody).toEqual({ name: 'Cassini', serverId: 'srv-local' });
  });
});
