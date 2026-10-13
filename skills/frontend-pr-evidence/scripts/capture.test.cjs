// End-to-end check of capture.cjs against a local fixture server. Pixel assertions use fixed
// coordinates and colour thresholds tuned for the fixture layout; retune them if a different
// OS, font, or Playwright overlay style shifts the rendering.
const assert = require('node:assert/strict');
const { mkdtemp, readFile, rm, mkdir, writeFile } = require('node:fs/promises');
const { createServer } = require('node:http');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const os = require('node:os');
const path = require('node:path');
const { capture, loadChromium } = require('./capture.cjs');
const { publish } = require('./publish.cjs');
const runNode = promisify(execFile);

async function inspectArtifacts(directory, chromium) {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 960 } });
    const images = await Promise.all(['before.png', 'after.png', 'comparison.png', 'video-contact-sheet.png'].map(async file =>
      `data:image/png;base64,${(await readFile(path.join(directory, file))).toString('base64')}`,
    ));
    const video = `data:video/webm;base64,${(await readFile(path.join(directory, 'comparison.webm'))).toString('base64')}`;
    const inspection = await page.evaluate(async ({ images, video }) => {
      const decoded = await Promise.all(images.map(async src => {
        const image = new Image();
        image.src = src;
        await image.decode();
        return image;
      }));
      const canvas = document.createElement('canvas');
      canvas.width = 1280;
      canvas.height = 960;
      const context = canvas.getContext('2d');
      const count = (x, y, width, height, predicate) => {
        const pixels = context.getImageData(x, y, width, height).data;
        let total = 0;
        for (let i = 0; i < pixels.length; i += 4) {
          if (predicate(pixels[i], pixels[i + 1], pixels[i + 2])) total++;
        }
        return total;
      };
      const red = (r, g, b) => r > 150 && g < 100 && b < 100;
      const orange = (r, g, b) => r > 180 && g > 60 && g < 160 && b < 80;
      const dark = (r, g, b) => r < 80 && g < 80 && b < 80;
      const stills = decoded.slice(0, 2).map(image => {
        context.clearRect(0, 0, 1280, 960);
        context.drawImage(image, 0, 0);
        return {
          width: image.width, height: image.height,
          border: count(70, 130, 500, 200, red),
          caption: count(8, 430, 250, 40, dark),
          interiorRed: count(90, 150, 460, 160, red),
        };
      });
      const player = document.createElement('video');
      player.src = video;
      player.muted = true;
      document.body.append(player);
      await new Promise((resolve, reject) => {
        player.onloadeddata = resolve;
        player.onerror = () => reject(new Error('Chromium could not decode comparison.webm'));
      });
      const duration = player.duration;
      if (!Number.isFinite(duration) || duration <= 0) throw new Error(`Invalid video duration: ${duration}`);
      const frames = [];
      for (let time = 0.1; time < duration; time += 0.04) {
        await new Promise(resolve => {
          player.onseeked = resolve;
          player.currentTime = time;
        });
        context.clearRect(0, 0, 1280, 960);
        context.drawImage(player, 0, 0);
        // This blank band lies between the button and panel, away from app text.
        const band = context.getImageData(160, 105, 200, 65).data;
        const cursorPixels = [];
        for (let i = 0; i < band.length; i += 4) {
          if (dark(band[i], band[i + 1], band[i + 2])) cursorPixels.push(i / 4 % 200 + 160);
        }
        frames.push({
          time,
          cursorX: cursorPixels.length > 5 ? cursorPixels.reduce((sum, x) => sum + x, 0) / cursorPixels.length : null,
          orange: count(0, 0, 640, 400, orange),
          red: count(70, 130, 500, 200, red),
          caption: count(8, 430, 250, 40, dark),
          // Both asserted final states contain text in this otherwise blank panel.
          text: count(100, 180, 420, 60, dark),
        });
      }
      return {
        stills,
        comparison: { width: decoded[2].width, height: decoded[2].height },
        sheet: { width: decoded[3].width, height: decoded[3].height },
        video: { width: player.videoWidth, height: player.videoHeight, duration, frames },
      };
    }, { images, video });
    for (const still of inspection.stills) {
      assert.equal(still.width, 640);
      assert.equal(still.height, 480);
      assert.ok(still.border > 3000, `Native red highlight missing: ${JSON.stringify(still)}`);
      assert.equal(still.interiorRed, 0, 'Highlight must not cover panel content');
      assert.ok(still.caption > 5000, 'Phase caption missing from screenshot');
    }
    // Highlights span the full 640px width, so the crop keeps width but drops rows far from the panel.
    assert.equal(inspection.comparison.width, 1280);
    assert.ok(inspection.comparison.height < 480, `Comparison not cropped: ${JSON.stringify(inspection.comparison)}`);
    assert.equal(inspection.sheet.width, 1440);
    assert.ok(inspection.sheet.height > 300);
    assert.equal(inspection.video.width, 640);
    assert.equal(inspection.video.height, 480);
    assert.ok(inspection.video.duration > 8);
    assert.ok(inspection.video.frames.some(frame => frame.orange > 30), 'Native action marker missing from video');
    const middle = inspection.video.duration / 2;
    for (const frames of [
      inspection.video.frames.filter(frame => frame.time < middle),
      inspection.video.frames.filter(frame => frame.time >= middle),
    ]) {
      const cursorPositions = frames.filter(frame => frame.cursorX !== null).map(frame => frame.cursorX);
      assert.ok(cursorPositions.length >= 2 && Math.max(...cursorPositions) - Math.min(...cursorPositions) > 10,
        'Each phase must contain intermediate native cursor positions between targets');
      assert.ok(frames.some(frame => frame.red > 2500 && frame.text > 100 && frame.caption > 5000),
        'Video must show highlighted, readable final state and caption in both phases');
    }
    await writeFile(path.join(directory, 'inspection.json'), JSON.stringify(inspection, null, 2));
    return inspection;
  } finally {
    await browser.close();
  }
}

(async () => {
  const chromium = loadChromium();
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'pr-evidence-test-'));
  const directory = process.env.CAPTURE_TEST_OUTPUT ? path.resolve(process.env.CAPTURE_TEST_OUTPUT) : path.join(temporary, 'success');
  const server = createServer((request, response) => {
    if (request.url === '/redirect') {
      // Stands in for an identity provider redirect on another origin.
      response.writeHead(302, { Location: `http://localhost:${server.address().port}/login` });
      return response.end();
    }
    if (request.url.startsWith('/api/')) {
      response.statusCode = request.url === '/api/missing' ? 404 : 200;
      response.setHeader('Content-Type', 'application/json');
      return response.end(JSON.stringify({ source: 'real' }));
    }
    if (request.url === '/isolation') {
      response.setHeader('Content-Type', 'text/html');
      // Loads data on startup, polls forever, and reports any state leaked from the previous phase.
      return response.end(`<!doctype html><output style="display:block;margin:40px;font:20px sans-serif">loading</output><script>
        setInterval(() => fetch('/api/poll'), 200);
        fetch('/api/missing');
        fetch('/api/state').then(r => r.json()).then(data => {
          document.querySelector('output').textContent = JSON.stringify({
            source: data.source, cookie: document.cookie, stored: localStorage.getItem('seed'), init: window.seeded ?? null,
          });
          localStorage.setItem('seed', 'leaked');
        });
      </script>`);
    }
    const after = request.url === '/after';
    response.setHeader('Content-Type', 'text/html');
    response.end(`<!doctype html><style>
      body { margin:0; background:#f5f7fa; color:#172233; font:20px sans-serif; }
      button { position:absolute; left:80px; top:60px; padding:12px; }
      section { position:absolute; box-sizing:border-box; left:80px; top:140px; width:480px; height:180px; padding:20px; background:white; }
      h1 { margin:20px 0; font-size:28px; }
    </style><button onclick="document.querySelector('section').hidden=false">Open details</button>
    <section hidden aria-label="Details"><h1>${after ? 'Updated details' : 'Original details'}</h1><p>${after ? 'Head fixture' : 'Base fixture'}</p></section>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const calls = [];
  const observedChromium = {
    launch: async () => {
      const browser = await chromium.launch();
      const newContext = browser.newContext.bind(browser);
      browser.newContext = async options => {
        assert.equal(options.recordVideo, undefined, 'Use native Screencast recording');
        const context = await newContext(options);
        const newPage = context.newPage.bind(context);
        context.newPage = async () => {
          const page = await newPage();
          for (const name of ['start', 'stop', 'showActions', 'showOverlay']) {
            const original = page.screencast[name].bind(page.screencast);
            page.screencast[name] = async (...args) => {
              calls.push({ name, args });
              return original(...args);
            };
          }
          return page;
        };
        return context;
      };
      return browser;
    },
  };
  const outputs = ['before.png', 'after.png', 'comparison.png', 'comparison.webm', 'video-contact-sheet.png', 'manifest.json', 'comment.md'];
  const description = 'Opens the details panel with fixture data.';
  try {
    await assert.rejects(capture({ phases: [] }, temporary, chromium), /Exactly two/);
    assert.throws(() => loadChromium(path.join(temporary, 'absent')), /npm install --prefix .*playwright@~1.64/);
    const oldModule = path.join(temporary, 'old-playwright');
    await mkdir(oldModule);
    await writeFile(path.join(oldModule, 'index.js'), 'module.exports = {};');
    await writeFile(path.join(oldModule, 'package.json'), JSON.stringify({ version: '1.63.0', main: 'index.js' }));
    assert.throws(() => loadChromium(oldModule), />= 1.64.*1.63.0/);
    const phases = ['Before <base>', 'After & head'].map((label, index) => ({
      label, revision: `test-${index}`, url: `${url}/${index ? 'after' : 'before'}`,
      run: async (page, tools) => {
        const panel = page.getByRole('region', { name: 'Details' });
        assert.equal(await panel.isVisible(), false);
        await tools.click(page.getByRole('button', { name: 'Open details' }));
        assert.equal(await panel.isVisible(), true);
        assert.equal(await panel.getByRole('heading').innerText(), index ? 'Updated details' : 'Original details');
        await tools.point(panel);
        const style = await panel.getAttribute('style');
        await tools.highlight(panel, 'Details <panel>');
        assert.equal(await panel.getAttribute('style'), style, 'Highlights must not mutate app styles');
      },
    }));
    const result = await capture({ description, phases, viewport: { width: 640, height: 480 } }, directory, observedChromium);
    const highlights = [{ x: 80, y: 140, width: 480, height: 180, label: 'Details <panel>' }];
    assert.deepEqual(result.phases, phases.map(({ label, revision, url }) => ({ label, revision, url, highlights })));
    assert.deepEqual(result.pageErrors, []);
    assert.deepEqual(result.network, []);
    assert.equal(result.comparison.layout, 'side-by-side');
    const comment = await readFile(path.join(directory, 'comment.md'), 'utf8');
    assert.match(result.captureId, /^[0-9a-f-]{36}$/);
    for (const text of [`<!-- frontend-pr-evidence:test-1:${result.captureId} -->`, description, '`test-0`', '`test-1`']) assert.ok(comment.includes(text), text);
    assert.deepEqual(JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8')), result);
    assert.equal(calls.filter(call => call.name === 'start').length, 1);
    assert.equal(calls.filter(call => call.name === 'stop').length, 1);
    assert.equal(calls.find(call => call.name === 'showActions').args[0].cursor, 'pointer');
    assert.ok(calls.find(call => call.name === 'showActions').args[0].style.point.includes('#ff6a00'));
    const overlays = calls.filter(call => call.name === 'showOverlay').map(call => call.args[0]);
    const boxes = overlays.filter(html => html.includes('data-evidence="highlight"'));
    assert.equal(boxes.length, 2);
    assert.ok(boxes.every(html => html.includes('Details &lt;panel&gt;')), 'Highlight labels must be escaped');
    const captions = overlays.filter(html => !html.includes('data-evidence'));
    assert.ok(captions[0].includes('Before &lt;base&gt; · test-0'));
    assert.ok(captions[1].includes('After &amp; head · test-1'));
    for (const file of outputs) {
      assert.ok((await readFile(path.join(directory, file))).length > 0, file);
    }
    const inspection = await inspectArtifacts(directory, chromium);
    console.log(`PASS: native calls, escaped captions and labels, unchanged app styles, seven outputs, cropped comparison, PNG bounds, decoded ${inspection.video.duration.toFixed(2)}s Chromium video`);
    const cliFlow = path.join(temporary, 'flow.cjs');
    await writeFile(cliFlow, `module.exports = {
      description: ${JSON.stringify(description)},
      viewport: { width: 640, height: 480 },
      phases: ${JSON.stringify(phases.map(({ label, revision, url }) => ({ label, revision, url })))}.map(phase => ({
        ...phase,
        run: async (page, tools) => {
          await tools.click(page.getByRole('button', { name: 'Open details' }));
          await tools.highlight(page.getByRole('region', { name: 'Details' }), 'Details <panel>');
        },
      })),
    };`);
    const cliDirectory = path.join(temporary, 'cli');
    const cli = await runNode(process.execPath, [path.join(__dirname, 'capture.cjs'), cliFlow, cliDirectory]);
    assert.deepEqual(JSON.parse(cli.stdout).phases, result.phases);
    for (const file of outputs) {
      assert.ok((await readFile(path.join(cliDirectory, file))).length > 0, file);
    }
    await assert.rejects(runNode(process.execPath, [path.join(__dirname, 'capture.cjs'), cliFlow, cliDirectory], {
      env: { ...process.env, PLAYWRIGHT_MODULE: oldModule },
    }), />= 1.64.*1.63.0/);
    console.log('PASS: CLI capture and unsupported-version rejection');
    await assert.rejects(capture({
      description,
      phases: phases.map(phase => ({ ...phase, run: async () => {} })),
    }, path.join(temporary, 'missing-highlight'), chromium), /No highlights in Before/);
    await assert.rejects(capture({
      description,
      phases: phases.map(phase => ({
        ...phase,
        run: async (page, tools) => {
          await page.evaluate(() => setTimeout(() => { throw new Error('fixture page error'); }, 0));
          await tools.highlight(page.getByRole('button'));
        },
      })),
    }, path.join(temporary, 'page-error'), chromium), /Page errors:.*fixture page error/);
    await assert.rejects(capture({
      description,
      viewport: { width: 640, height: 150 },
      phases: phases.map(phase => ({
        ...phase,
        run: async (page, tools) => {
          await tools.click(page.getByRole('button', { name: 'Open details' }));
          await tools.highlight(page.getByRole('region', { name: 'Details' }), 'Tall panel');
        },
      })),
    }, path.join(temporary, 'offscreen'), chromium), /Highlight Tall panel in Before .* not fully inside the 640x150 viewport/);
    console.log('PASS: missing-highlight, page-error, and off-screen highlight failures');
    // Before seeds a mock, cookie, storage, and init script in setup; After seeds nothing and must see none of it.
    const seen = {};
    const isolation = await capture({
      description,
      viewport: { width: 640, height: 480 },
      setup: async (page, phase) => {
        if (phase.label !== 'Before') return;
        await page.route('**/api/state', route => route.fulfill({ json: { source: 'mock' } }));
        await page.context().route('**/api/poll', route => route.fulfill({ json: {} }));
        await page.context().addCookies([{ name: 'seed', value: 'before', url }]);
        await page.context().addInitScript(() => { window.seeded = 'before'; });
      },
      phases: ['Before', 'After'].map(label => ({
        label, revision: label.toLowerCase(), url: `${url}/isolation`,
        run: async (page, tools) => {
          const output = page.locator('output');
          await output.filter({ hasNotText: 'loading' }).waitFor();
          seen[label] = JSON.parse(await output.innerText());
          await tools.highlight(output);
        },
      })),
    }, path.join(temporary, 'isolation'), chromium);
    assert.deepEqual(seen.Before, { source: 'mock', cookie: 'seed=before', stored: null, init: 'before' });
    assert.deepEqual(seen.After, { source: 'real', cookie: '', stored: null, init: null });
    assert.deepEqual(isolation.network.map(({ phase, status }) => [phase, status]), [['Before', 404], ['After', 404]]);
    console.log('PASS: setup mocks first load, phases isolated, polling app captured, 404s recorded');
    // Built output folders: client routes fall back to index.html, and each phase gets its own origin.
    const builds = await Promise.all(['before', 'after'].map(async name => {
      const dir = path.join(temporary, `dist-${name}`);
      await mkdir(path.join(dir, 'assets'), { recursive: true });
      await writeFile(path.join(dir, 'assets', 'app.js'), `document.querySelector('main').textContent = '${name} ' + location.pathname;`);
      await writeFile(path.join(dir, 'index.html'), '<!doctype html><main style="margin:40px;font:20px sans-serif"></main><script src="/assets/app.js"></script>');
      return dir;
    }));
    const served = await capture({
      description,
      viewport: { width: 640, height: 480 },
      phases: builds.map((dir, index) => ({
        label: index ? 'After' : 'Before', revision: `dir-${index}`, dir,
        run: async (page, tools) => {
          await page.goto(new URL('/queue/7', page.url()).href);
          const main = page.locator('main');
          await main.filter({ hasText: `${index ? 'after' : 'before'} /queue/7` }).waitFor();
          await tools.highlight(main);
        },
      })),
    }, path.join(temporary, 'dir'), chromium);
    assert.deepEqual(served.phases.map(phase => phase.dir), builds);
    assert.notEqual(new URL(served.phases[0].url).origin, new URL(served.phases[1].url).origin);
    console.log('PASS: built folders served in-process with client-route fallback');
    const failed = path.join(temporary, 'failed');
    await mkdir(failed);
    for (const file of ['manifest.json', 'comment.md']) await writeFile(path.join(failed, file), 'from an earlier run');
    const started = Date.now();
    await assert.rejects(capture({
      description,
      phases: phases.map(phase => ({
        ...phase,
        run: async (page, tools) => tools.click(page.getByRole('button', { name: 'Missing button' })),
      })),
    }, failed, chromium), error => {
      assert.match(error.message, /Before <base> failed: .*Missing button/s);
      assert.match(error.message, /URL: http:\/\/127\.0\.0\.1:\d+\/before/);
      assert.match(error.message, /Failure artifacts: .*failure\.png, .*failure-aria\.yml/);
      return true;
    });
    assert.ok(Date.now() - started < 25_000, 'Action timeout must stay short');
    // A failed rerun must not leave an earlier capture publishable.
    for (const file of ['manifest.json', 'comment.md']) await assert.rejects(readFile(path.join(failed, file)), { code: 'ENOENT' });
    assert.match(await readFile(path.join(failed, 'failure-aria.yml'), 'utf8'), /button "Open details"/);
    await assert.rejects(capture({
      description,
      phases: phases.map(phase => ({ ...phase, url: `${url}/redirect` })),
    }, path.join(temporary, 'redirect'), chromium), /Before <base> warm-up failed: .*navigated away to http:\/\/localhost:\d+\/login/s);
    console.log('PASS: failure screenshot and accessibility dump, short timeout, stale outputs cleared, login redirect named');
    // A stub gh on PATH: no test ever reaches GitHub.
    const evidence = path.join(temporary, 'evidence');
    await mkdir(evidence);
    await writeFile(path.join(evidence, 'manifest.json'), JSON.stringify({
      captureId: 'id-1', description, phases: [{ label: 'Before', revision: 'aaaaaaa' }, { label: 'After', revision: 'bbbbbbb1' }],
    }));
    for (const file of ['comment.md', 'comparison.png', 'comparison.webm']) await writeFile(path.join(evidence, file), 'stub');
    const bin = path.join(temporary, 'bin');
    await mkdir(bin);
    await writeFile(path.join(bin, 'gh'), `#!/usr/bin/env node
const args = process.argv.slice(2);
const scenario = process.env.STUB_SCENARIO;
require('node:fs').appendFileSync(process.env.STUB_LOG, JSON.stringify(args) + '\\n');
const out = value => process.stdout.write(typeof value === 'string' ? value : JSON.stringify(value));
const last = args.at(-1);
const marker = '<!-- frontend-pr-evidence:bbbbbbb1:id-1 -->';
if (args[1] === 'comment' && last === '--help') out('--attach file   Attach an image or video file');
else if (args[1] === 'view') out({ headRefOid: scenario === 'stale' ? 'ccccccc9' : 'bbbbbbb1ffff', baseRefName: 'main' });
else if (last.includes('/compare/')) out({ merge_base_commit: { sha: 'aaaaaaa0000' } });
else if (last.endsWith('/comments')) out(
  scenario === 'existing' ? [[{ id: 7, body: marker }]]
    : scenario === 'recaptured' ? [[{ id: 6, body: '<!-- frontend-pr-evidence:bbbbbbb1:id-0 -->' }]] : [[]],
);
else if (args[1] === 'comment') out('https://github.com/o/r/pull/5#issuecomment-42\\n');
else if (/issues\\/comments\\/\\d+$/.test(last)) out({
  html_url: 'https://github.com/o/r/pull/5#issuecomment-' + last.split('/').pop(),
  body: marker + '\\n\`aaaaaaa\` \`bbbbbbb1\`\\nhttps://github.com/user-attachments/assets/1\\nhttps://github.com/user-attachments/assets/2',
});
else { process.stderr.write('unexpected gh ' + args.join(' ')); process.exit(1); }
`, { mode: 0o755 });
    const pathBefore = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${pathBefore}`;
    const publishWith = async scenario => {
      const log = path.join(temporary, `gh-${scenario}.log`);
      await writeFile(log, '');
      process.env.STUB_SCENARIO = scenario;
      process.env.STUB_LOG = log;
      const outcome = await publish(evidence, 'https://github.com/o/r/pull/5').catch(error => error);
      const calls = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      return { outcome, posts: calls.filter(args => args[1] === 'comment' && args.includes('--body-file')) };
    };
    try {
      const fresh = await publishWith('fresh');
      assert.deepEqual(fresh.outcome, { url: 'https://github.com/o/r/pull/5#issuecomment-42', commentId: 42, reused: false });
      assert.equal(fresh.posts.length, 1);
      assert.ok(fresh.posts[0].includes(`${path.join(evidence, 'comparison.png')}#Before and after UI comparison`));
      const stale = await publishWith('stale');
      assert.match(stale.outcome.message, /PR head is ccccccc9; recapture at the current head/);
      assert.equal(stale.posts.length, 0);
      const existing = await publishWith('existing');
      assert.deepEqual(existing.outcome, { url: 'https://github.com/o/r/pull/5#issuecomment-7', commentId: 7, reused: true });
      assert.equal(existing.posts.length, 0);
      const recaptured = await publishWith('recaptured');
      assert.equal(recaptured.outcome.commentId, 42);
      assert.equal(recaptured.posts.length, 1);
    } finally {
      process.env.PATH = pathBefore;
    }
    console.log('PASS: publish posts once, refuses stale heads, reuses its own comment, posts anew after a recapture');
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(temporary, { recursive: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
