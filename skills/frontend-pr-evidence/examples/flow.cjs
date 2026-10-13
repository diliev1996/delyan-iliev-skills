const fixtures = { items: [{ id: 1, name: 'Fixture item' }] };
// Cross-origin API calls need CORS headers on the mocked response too.
const cors = { 'Access-Control-Allow-Origin': '*' };

module.exports = {
  description: 'Opens the details panel for one item. API responses are mocked with identical fixtures in both phases.',
  viewport: { width: 1440, height: 900 },
  // Runs before each phase's first navigation, on a page reset between phases.
  setup: async page => {
    // Registered first, so it runs last: any unmocked backend call fails and lands in manifest.network.
    await page.route('**/api/**', route => route.abort());
    await page.route('**/api/items', route => route.fulfill({ json: fixtures, headers: cors }));
    // Login-gated apps: seed the token cache the auth library reads, for example
    //   await page.addInitScript(() => localStorage.setItem('auth.token', JSON.stringify({ expiresOn: '2099-01-01' })));
    // or strip the guard from the served bundle:
    //   await page.route('**/main.js', async route => {
    //     const response = await route.fetch();
    //     await route.fulfill({ response, body: (await response.text()).replace('GUARD_SOURCE', '') });
    //   });
  },
  phases: [
    // `dir` serves a built output folder; use `url` instead for a running dev server.
    { label: 'Before', revision: 'abc1234', dir: '/absolute/path/to/base/dist' },
    { label: 'After', revision: 'def5678', dir: '/absolute/path/to/head/dist' },
  ].map(phase => ({ ...phase, run: review })),
};

async function review(page, tools) {
  await tools.click(page.getByRole('button', { name: 'Open details' }));
  const region = page.getByRole('heading', { name: 'Details' });
  await region.waitFor({ state: 'visible' });
  // Replace with assertions for the real change, separately for each phase.
  await tools.point(region);
  await tools.highlight(region, 'Details heading');
}
