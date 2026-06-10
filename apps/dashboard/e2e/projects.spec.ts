import { test, expect } from '@playwright/test';
import { loginAs, type MockHandler } from './helpers/api-mock';

const NOW = new Date().toISOString();

const projectList = [
  {
    id: 'proj-1',
    name: 'Atlas',
    description: 'Main platform',
    serverId: 'srv-local',
    createdAt: NOW,
    updatedAt: NOW,
    server: { id: 'srv-local', name: 'local' },
    applications: [
      {
        id: 'app-1',
        name: 'atlas-web',
        status: 'RUNNING',
        framework: 'NEXTJS',
        port: 3000,
        domains: [{ domain: 'atlas.example.com' }],
      },
    ],
  },
  {
    id: 'proj-2',
    name: 'Borealis',
    description: null,
    serverId: 'srv-local',
    createdAt: NOW,
    updatedAt: NOW,
    server: { id: 'srv-local', name: 'local' },
    applications: [],
  },
];

const handlers: MockHandler[] = [
  { path: '/projects', body: projectList },
  { path: '/projects/proj-1', body: { ...projectList[0], currentRole: 'OWNER' } },
  { path: '/projects/proj-1/members', body: [] },
];

test.describe('projects', () => {
  test('renders the mocked project list', async ({ page }) => {
    await loginAs(page, { handlers });
    await page.goto('/dashboard/projects');

    await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Atlas' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Borealis' })).toBeVisible();
    await expect(page.getByText('atlas-web')).toBeVisible();
  });

  test('clicking a project opens the detail page with its name', async ({ page }) => {
    await loginAs(page, { handlers });
    await page.goto('/dashboard/projects');

    await page.getByRole('link', { name: /Atlas/ }).click();

    await expect(page).toHaveURL(/\/dashboard\/projects\/proj-1$/);
    await expect(page.getByRole('heading', { name: 'Atlas' })).toBeVisible();
    await expect(page.getByText('Main platform')).toBeVisible();
  });
});
