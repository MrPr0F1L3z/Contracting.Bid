import { expect, test, type Page } from '@playwright/test';

// What a visitor does, start to finish. Runs against the production build, in whichever template it was built.
const TEMPLATE = (process.env.NEXT_PUBLIC_CB_TEMPLATE ?? '').trim().toLowerCase() === 'hivis' ? 'hivis' : 'blueprint';

async function events(page: Page): Promise<string[]> {
  return page.evaluate(() => ((window as { dataLayer?: { event: string }[] }).dataLayer ?? []).map((e) => e.event));
}

test('sign up from the home page, set up, import a bid and submit it', async ({ page }) => {
  await page.goto('/');
  // Blueprint's headline or Hi-Vis's, whichever template was built.
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/Every bid, sub and dollar on one sheet\.|Find it\. Bid it\./);
  await expect(page.locator('html')).toHaveAttribute('data-theme', TEMPLATE);

  await page.getByLabel('Work email').fill('sam@example.com');
  await page.locator('.cb-signup').getByRole('button', { name: 'Start free trial' }).click();
  await expect(page).toHaveURL(/\/signup$/); // the email is not put in the URL
  await expect(page.getByLabel('Work email')).toHaveValue('sam@example.com');
  expect(await events(page)).toContain('cb_signup_submit');

  await page.getByLabel('Your name').fill('Sam Rivera');
  await page.getByLabel('Password').fill('correct horse battery');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(/\/onboarding$/);

  await page.getByLabel('Company name').fill('Rivera Mechanical');
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Roofing' }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('radio', { name: /Import a bid in progress/ })).toBeChecked();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText('3 trades selected')).toBeVisible();
  await page.getByRole('button', { name: 'Open my workspace' }).click();

  await expect(page).toHaveURL(/\/app\/import-bid$/);
  await page.getByRole('button', { name: 'Choose a file' }).click();
  await expect(page.locator('tbody tr')).toHaveCount(5);
  await page.getByRole('button', { name: 'Create bid' }).click();
  await expect(page).toHaveURL(/\/app\/bid-detail$/);

  await page.getByRole('button', { name: 'Submit bid' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await page.getByRole('button', { name: 'Submit bid' }).click();
  await dialog.getByRole('button', { name: 'Submit bid' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Bid submitted' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Submitted' })).toBeDisabled();
});

test('workspace navigation changes the URL and survives a reload', async ({ page }) => {
  await page.goto('/app');
  await page.getByRole('navigation', { name: 'Workspace' }).getByRole('link', { name: 'Money' }).click();
  await expect(page).toHaveURL(/\/app\/money$/);
  await page.reload();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Money');
  await expect(page.getByRole('link', { name: 'Money' })).toHaveAttribute('aria-current', 'page');

  await page.getByRole('button', { name: 'Pay subs and vendors' }).click();
  await expect(page).toHaveURL(/\/app\/pay-run$/);
  await page.getByRole('checkbox', { name: 'Pay Brightline Electric' }).uncheck();
  await page.getByRole('button', { name: 'Pay selected' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Pay now' }).click();
  await expect(page.getByText('1 payment scheduled, $38,400.00.')).toBeVisible();

  await page.goBack();
  await expect(page).toHaveURL(/\/app\/money$/);
});

test('password reset, legal pages and unknown URLs', async ({ page }) => {
  await page.goto('/signin');
  await page.getByRole('link', { name: 'Forgot your password?' }).click();
  await expect(page).toHaveURL(/\/reset$/);
  await page.getByLabel('Work email').fill('sam@example.com');
  await page.getByRole('button', { name: 'Send reset link' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Check your email');

  await page.goto('/');
  await page.getByRole('contentinfo').getByRole('link', { name: 'Privacy' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Privacy policy');

  for (const url of ['/nope', '/app/nope', '/app/overview', '/app/bids/extra']) {
    const response = await page.goto(url);
    expect(response?.status(), url).toBe(404);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('We can’t find that page');
  }
});

test('pages fit a phone without sideways scrolling', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  for (const url of ['/', '/pricing', '/signup', '/onboarding', '/app', '/app/schedule', '/app/pay-run', '/app/change-order']) {
    await page.goto(url);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, url).toBeLessThanOrEqual(0);
  }
});

test('no page logs a console error', async ({ page }) => {
  const problems: string[] = [];
  page.on('pageerror', (e) => problems.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') problems.push(m.text()); });
  for (const url of ['/', '/pricing', '/signin', '/signup', '/reset', '/reset/new', '/reset/sent', '/onboarding', '/terms', '/privacy', '/trial-ended', '/app', '/app/welcome', '/app/find-work', '/app/bids', '/app/projects', '/app/settings']) {
    await page.goto(url);
    await expect(page.locator(`[data-template="${TEMPLATE}"]`).first()).toBeVisible();
  }
  expect(problems).toEqual([]);
});

test('Hi-Vis: a contractor name opens and closes that award\'s details', async ({ page }) => {
  test.skip(TEMPLATE !== 'hivis', 'award history is shown in Hi-Vis only');
  await page.goto('/app/find-work');
  const name = page.getByRole('button', { name: 'Marlow Builders' });
  await expect(name).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByText('COA-21-088, Library east wing restroom remodel')).toBeHidden();
  await name.click();
  await expect(name).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByText('COA-21-088, Library east wing restroom remodel')).toBeVisible();
  await expect(page.getByText('[5 mos.]')).toBeVisible();
  await name.click();
  await expect(page.getByText('COA-21-088, Library east wing restroom remodel')).toBeHidden();
});

test('Hi-Vis: a task on the overview opens the screen that deals with it', async ({ page }) => {
  test.skip(TEMPLATE !== 'hivis', 'the task overview is the Hi-Vis home screen');
  await page.goto('/app');
  await page.getByRole('button', { name: 'Pay now' }).click();
  await expect(page).toHaveURL(/\/app\/pay-run$/);
  await page.goto('/app/welcome');
  await expect(page.getByText('From SAM.gov, matched to your settings')).toBeVisible();
  await expect(page.getByText('No jobs open.')).toBeVisible();
});
