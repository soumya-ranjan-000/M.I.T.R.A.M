/**
 * Visible (headed) SauceDemo login demo.
 * Run:  node tests/saucedemo-login.headed.js
 * A real Chromium window opens on your desktop so you can watch the steps.
 */
const { chromium } = require('playwright');

const BASE_URL = 'https://www.saucedemo.com';
const USER = 'standard_user';
const PASS = 'secret_sauce';

function assert(condition, message) {
  if (!condition) {
    throw new Error(`ASSERTION FAILED: ${message}`);
  }
  console.log(`  PASS  ${message}`);
}

(async () => {
  const browser = await chromium.launch({
    headless: false,
    slowMo: 450, // slow down so each action is visible
    args: ['--window-size=1280,860', '--window-position=60,40'],
  });

  const context = await browser.newContext({ viewport: { width: 1280, height: 760 } });
  const page = await context.newPage();

  try {
    console.log('\n=== TEST: valid login (standard_user) ===');
    await page.goto(BASE_URL);
    assert((await page.title()) === 'Swag Labs', 'login page title is "Swag Labs"');

    await page.locator('#user-name').fill(USER);
    await page.locator('#password').fill(PASS);
    await page.locator('#login-button').click();

    await page.waitForURL('**/inventory.html', { timeout: 10000 });
    assert(page.url().includes('/inventory.html'), 'redirected to /inventory.html');

    const heading = (await page.locator('.title').textContent()).trim();
    assert(heading === 'Products', 'page heading is "Products"');

    const itemCount = await page.locator('.inventory_item').count();
    assert(itemCount === 6, `inventory shows 6 products (got ${itemCount})`);

    assert(await page.locator('.shopping_cart_link').isVisible(), 'cart icon is visible');
    await page.waitForTimeout(1500);

    console.log('\n=== TEST: logout ===');
    await page.locator('#react-burger-menu-btn').click();
    await page.locator('#logout_sidebar_link').click();
    await page.waitForURL(BASE_URL + '/', { timeout: 10000 });
    assert(await page.locator('#login-button').isVisible(), 'back on the login page after logout');
    await page.waitForTimeout(1500);

    console.log('\nAll checks passed.\n');
  } catch (err) {
    console.error(`\n${err.message}\n`);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
