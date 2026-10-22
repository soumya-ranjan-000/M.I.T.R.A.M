/**
 * SauceDemo — login test cases (standalone Playwright script, no test runner needed).
 *
 * Run headless:   node tests/saucedemo-login.test.js
 * Run visible:    HEADED=1 node tests/saucedemo-login.test.js
 *
 * If `playwright` is not resolvable from this folder, prefix with NODE_PATH, e.g.
 *   NODE_PATH=/home/so-ra-gh/.npm/_npx/361ceb562f3b3235/node_modules node tests/saucedemo-login.test.js
 */
const { chromium } = require('playwright');

const BASE_URL = 'https://www.saucedemo.com';
const PASSWORD = 'secret_sauce';

// ---------------------------------------------------------------- tiny harness
let passed = 0;
let failed = 0;
const failures = [];

function check(condition, message) {
  if (condition) {
    passed++;
    console.log(`    ok   ${message}`);
  } else {
    failed++;
    failures.push(message);
    console.log(`    FAIL ${message}`);
  }
}

function equal(actual, expected, message) {
  check(
    actual === expected,
    `${message}\n         expected: ${JSON.stringify(expected)}\n         actual:   ${JSON.stringify(actual)}`
  );
}

async function test(name, fn, context) {
  console.log(`\n  ${name}`);
  const page = await context.newPage();
  try {
    await fn(page);
  } catch (err) {
    failed++;
    failures.push(`${name} — threw: ${err.message}`);
    console.log(`    FAIL threw: ${err.message}`);
  } finally {
    await page.close();
  }
}

// ---------------------------------------------------------------- page object
const login = {
  async open(page) {
    await page.goto(BASE_URL);
  },
  async submit(page, username, password) {
    await page.locator('#user-name').fill(username);
    await page.locator('#password').fill(password);
    await page.locator('#login-button').click();
  },
  errorText(page) {
    return page.locator('h3[data-test="error"]').textContent();
  },
};

// ---------------------------------------------------------------- test cases
async function run() {
  const browser = await chromium.launch({
    headless: !process.env.HEADED,
    slowMo: process.env.HEADED ? 400 : 0,
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 760 } });

  console.log('\nSauceDemo login suite');

  // TC-01 — the happy path
  await test('TC-01 valid credentials log the user in', async (page) => {
    await login.open(page);
    equal(await page.title(), 'Swag Labs', 'login page title');

    await login.submit(page, 'standard_user', PASSWORD);
    await page.waitForURL('**/inventory.html', { timeout: 10000 });

    check(page.url().includes('/inventory.html'), 'redirected to the inventory page');
    equal((await page.locator('.title').textContent()).trim(), 'Products', 'page heading');
    equal(await page.locator('.inventory_item').count(), 6, 'product count');
    check(await page.locator('.shopping_cart_link').isVisible(), 'cart icon is visible');
  }, context);

  // TC-02 — a locked account is rejected
  await test('TC-02 locked out user is refused', async (page) => {
    await login.open(page);
    await login.submit(page, 'locked_out_user', PASSWORD);

    equal(
      await login.errorText(page),
      'Epic sadface: Sorry, this user has been locked out.',
      'locked-out error message'
    );
    check(!page.url().includes('/inventory.html'), 'stayed on the login page');
  }, context);

  // TC-03 — wrong password is rejected
  await test('TC-03 wrong password is refused', async (page) => {
    await login.open(page);
    await login.submit(page, 'standard_user', 'wrong_password');

    equal(
      await login.errorText(page),
      'Epic sadface: Username and password do not match any user in this service',
      'bad-credentials error message'
    );
    check(!page.url().includes('/inventory.html'), 'stayed on the login page');
  }, context);

  // TC-04 — empty username is rejected
  await test('TC-04 empty username is refused', async (page) => {
    await login.open(page);
    await page.locator('#login-button').click();

    equal(await login.errorText(page), 'Epic sadface: Username is required', 'missing-username error');
  }, context);

  // TC-05 — logging out returns to the login screen
  await test('TC-05 logout returns to the login screen', async (page) => {
    await login.open(page);
    await login.submit(page, 'standard_user', PASSWORD);
    await page.waitForURL('**/inventory.html', { timeout: 10000 });

    await page.locator('#react-burger-menu-btn').click();
    await page.locator('#logout_sidebar_link').click();
    await page.waitForURL(`${BASE_URL}/`, { timeout: 10000 });

    check(await page.locator('#login-button').isVisible(), 'login button is visible again');
  }, context);

  await browser.close();

  // ------------------------------------------------------------- summary
  console.log(`\n${'-'.repeat(50)}`);
  console.log(`  ${passed} passed, ${failed} failed`);
  if (failures.length) {
    console.log('\n  Failures:');
    failures.forEach((f) => console.log(`   - ${f}`));
  }
  console.log('');
  process.exitCode = failed ? 1 : 0;
}

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
