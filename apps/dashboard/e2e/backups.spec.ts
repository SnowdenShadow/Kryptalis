import { test, expect, type Route, type Request } from '@playwright/test';
import { loginAs, type MockHandler } from './helpers/api-mock';

const NOW = new Date().toISOString();

function makeBackup(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'bk-1',
    name: 'nightly',
    serverId: 'srv-local',
    target: 'LOCAL',
    status: 'COMPLETED',
    size: null,
    sizeBytes: '1048576',
    sha256: null,
    encryptedAt: false,
    includeApplications: true,
    includeDatabases: true,
    includeVolumes: true,
    schedule: null,
    lastRunAt: NOW,
    createdAt: NOW,
    ...overrides,
  };
}

const backupList = [
  // Scheduled template (daily) → "Daily" badge
  makeBackup({ id: 'bk-tpl', name: 'nightly', schedule: '@daily' }),
  // Custom-cron template → "03:30 daily" badge
  makeBackup({ id: 'bk-cron', name: 'custom-dump', schedule: '30 3 * * *' }),
  // Child row spawned by the scheduler (schedule null, suffixed name) → "—"
  makeBackup({ id: 'bk-child', name: 'nightly (2026-06-09 00:00)' }),
];

function handlers(extra: MockHandler[] = []): MockHandler[] {
  return [
    ...extra,
    { path: '/backups', body: backupList },
    { path: '/backups/targets', body: { targets: ['LOCAL'], s3Configured: false } },
    { path: '/servers/local', body: { id: 'srv-local', name: 'local', status: 'ONLINE' } },
  ];
}

test.describe('backups', () => {
  test('lists backups with schedule badges for templates and a dash for one-off rows', async ({ page }) => {
    await loginAs(page, { handlers: handlers() });
    await page.goto('/dashboard/backups');

    await expect(page.getByRole('heading', { name: 'Backups' })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'nightly', exact: true })).toBeVisible();
    await expect(page.getByText('Daily', { exact: true })).toBeVisible();
    await expect(page.getByText('03:30 daily')).toBeVisible();

    // Scheduler child row renders without a schedule badge.
    const childRow = page.getByRole('row', { name: /nightly \(2026-06-09 00:00\)/ });
    await expect(childRow).toBeVisible();
    await expect(childRow.getByText('Daily', { exact: true })).toHaveCount(0);
  });

  test('create dialog shows schedule presets and submits the chosen preset', async ({ page }) => {
    let createdBody: Record<string, unknown> | null = null;
    await loginAs(page, {
      handlers: handlers([
        {
          method: 'POST',
          path: '/backups',
          status: 201,
          body: (_route: Route, request: Request) => {
            createdBody = request.postDataJSON();
            return makeBackup({ id: 'bk-new', name: 'weekly-dump', schedule: '@weekly' });
          },
        },
      ]),
    });
    await page.goto('/dashboard/backups');

    await page.getByRole('button', { name: 'Create Backup' }).first().click();
    await page.getByLabel('Name').fill('weekly-dump');

    const scheduleSelect = page.getByLabel('Schedule');
    await expect(scheduleSelect.locator('option')).toHaveText([
      'None (manual only)',
      'Every hour',
      'Every day',
      'Every week',
      'Custom time…',
    ]);
    await scheduleSelect.selectOption('@weekly');

    await page.getByRole('button', { name: 'Create', exact: true }).click();

    await expect.poll(() => createdBody).not.toBeNull();
    expect(createdBody).toMatchObject({
      name: 'weekly-dump',
      serverId: 'srv-local',
      target: 'LOCAL',
      schedule: '@weekly',
    });
  });

  test('custom preset reveals a time input and submits a 5-field cron', async ({ page }) => {
    let createdBody: Record<string, unknown> | null = null;
    await loginAs(page, {
      handlers: handlers([
        {
          method: 'POST',
          path: '/backups',
          status: 201,
          body: (_route: Route, request: Request) => {
            createdBody = request.postDataJSON();
            return makeBackup({ id: 'bk-new', name: 'custom', schedule: '45 4 * * *' });
          },
        },
      ]),
    });
    await page.goto('/dashboard/backups');

    await page.getByRole('button', { name: 'Create Backup' }).first().click();
    await page.getByLabel('Name').fill('custom');
    await page.getByLabel('Schedule').selectOption('custom');

    const timeInput = page.getByLabel('Run daily at');
    await expect(timeInput).toBeVisible();
    await timeInput.fill('04:45');
    await expect(page.getByText('cron: 45 4 * * *')).toBeVisible();

    await page.getByRole('button', { name: 'Create', exact: true }).click();

    await expect.poll(() => createdBody).not.toBeNull();
    expect(createdBody).toMatchObject({ name: 'custom', schedule: '45 4 * * *' });
  });

  test('manual-only preset omits the schedule field entirely', async ({ page }) => {
    let createdBody: Record<string, unknown> | null = null;
    await loginAs(page, {
      handlers: handlers([
        {
          method: 'POST',
          path: '/backups',
          status: 201,
          body: (_route: Route, request: Request) => {
            createdBody = request.postDataJSON();
            return makeBackup({ id: 'bk-new', name: 'oneoff' });
          },
        },
      ]),
    });
    await page.goto('/dashboard/backups');

    await page.getByRole('button', { name: 'Create Backup' }).first().click();
    await page.getByLabel('Name').fill('oneoff');
    await page.getByRole('button', { name: 'Create', exact: true }).click();

    await expect.poll(() => createdBody).not.toBeNull();
    expect(createdBody).toMatchObject({ name: 'oneoff', target: 'LOCAL' });
    expect(createdBody).not.toHaveProperty('schedule');
  });
});
