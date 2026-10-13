const { mkdir, writeFile, readFile, stat, rm } = require('node:fs/promises');
const { randomUUID } = require('node:crypto');
const { createServer } = require('node:http');
const os = require('node:os');
const path = require('node:path');

const PAD = 6;
const CROP_MARGIN = 80;
const SIDE_BY_SIDE_MAX_WIDTH = 960;
const ACTION_TIMEOUT = 10_000;
const NAVIGATION_TIMEOUT = 30_000;
const OUTPUTS = ['before.png', 'after.png', 'comparison.png', 'comparison.webm', 'video-contact-sheet.png', 'manifest.json', 'comment.md', 'failure.png', 'failure-aria.yml'];
const TOOLING = path.join(os.homedir(), '.cache', 'frontend-pr-evidence');
const INSTALL = `npm install --prefix "${TOOLING}" playwright@~1.64 && "${TOOLING}/node_modules/.bin/playwright" install chromium`;

function loadChromium(moduleName = process.env.PLAYWRIGHT_MODULE || path.join(TOOLING, 'node_modules', 'playwright')) {
  let entry;
  try {
    entry = require.resolve(moduleName);
  } catch {
    throw new Error(`Playwright not found at ${moduleName}. Install it with:\n  ${INSTALL}`);
  }
  const { version } = require(path.join(path.dirname(entry), 'package.json'));
  const [major, minor] = version.split('.').map(Number);
  if (major < 1 || (major === 1 && minor < 64)) {
    throw new Error(`Playwright >= 1.64 required for native evidence annotations; found ${version}`);
  }
  const { chromium } = require(moduleName);
  return {
    launch: async options => {
      try {
        return await chromium.launch(options);
      } catch (error) {
        if (!/Executable doesn't exist/.test(error.message)) throw error;
        throw new Error(`Chromium for Playwright ${version} is missing. Install it with:\n  "${path.join(path.dirname(entry), '..', '.bin', 'playwright')}" install chromium`);
      }
    },
  };
}

const CONTENT_TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.wasm': 'application/wasm',
};

// Serves a built single-page app: unknown paths fall back to index.html so client routes load.
async function serveDirectory(root) {
  root = path.resolve(root);
  const server = createServer(async (request, response) => {
    let file = path.join(root, new URL(request.url, 'http://localhost').pathname);
    if (!file.startsWith(root)) return response.writeHead(403).end();
    if (!(await stat(file).catch(() => null))?.isFile()) file = path.join(root, 'index.html');
    response.setHeader('Content-Type', CONTENT_TYPES[path.extname(file)] ?? 'application/octet-stream');
    readFile(file).then(body => response.end(body), () => response.writeHead(404).end());
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}/` };
}

// Leaving the phase origin almost always means an auth redirect; fail with the destination instead of a vague timeout.
function assertOrigin(page, phase) {
  if (new URL(page.url()).origin !== new URL(phase.url).origin) {
    throw new Error(`${phase.label} navigated away to ${page.url()}, usually a login redirect. Satisfy the app's auth gate in setup: seed its token with addInitScript, or rewrite the bundle with page.route and route.fetch.`);
  }
}

async function failureContext(error, page, phase, output, consoleErrors) {
  const screenshot = path.join(output, 'failure.png');
  const aria = path.join(output, 'failure-aria.yml');
  const saved = [];
  await page.screenshot({ path: screenshot, timeout: 5000 }).then(() => saved.push(screenshot), () => {});
  await page.locator('body').ariaSnapshot({ timeout: 5000 })
    .then(snapshot => writeFile(aria, snapshot)).then(() => saved.push(aria), () => {});
  const recent = consoleErrors.slice(-10);
  return new Error([
    `${phase.label} failed: ${error.message}`,
    `URL: ${page.url()}`,
    ...(saved.length ? [`Failure artifacts: ${saved.join(', ')}`] : []),
    ...(recent.length ? [`Console errors:\n  ${recent.join('\n  ')}`] : []),
  ].join('\n'), { cause: error });
}

function commentBody(manifest) {
  const [before, after] = manifest.phases;
  return [
    `<!-- frontend-pr-evidence:${after.revision}:${manifest.captureId} -->`,
    '## Frontend evidence',
    '',
    manifest.description,
    '',
    `- **${before.label}:** \`${before.revision}\``,
    `- **${after.label}:** \`${after.revision}\``,
    '',
  ].join('\n');
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

// Rectangles are screencast overlays, so they appear in stills and video without
// Playwright's selector tooltip and without touching app styles.
function highlightHtml(rects, viewport) {
  return rects.map(({ x, y, width, height, label }) => {
    const left = Math.max(0, x - PAD);
    const top = Math.max(0, y - PAD);
    const right = Math.min(viewport.width, x + width + PAD);
    const bottom = Math.min(viewport.height, y + height + PAD);
    const box = `<div data-evidence="highlight" style="position:fixed;box-sizing:border-box;left:${left}px;top:${top}px;width:${right - left}px;height:${bottom - top}px;border:3px solid #df2020;pointer-events:none;"></div>`;
    if (!label) return box;
    const labelTop = top >= 28 ? top - 28 : bottom + 4;
    return `${box}<div style="position:fixed;left:${left}px;top:${labelTop}px;padding:3px 8px;background:#df2020;color:white;font:600 14px sans-serif;pointer-events:none;">${escapeHtml(label)}</div>`;
  }).join('');
}

function cropFor(phases, viewport) {
  const rects = phases.flatMap(phase => phase.highlights);
  const left = Math.max(0, Math.min(...rects.map(rect => rect.x)) - PAD - CROP_MARGIN);
  const top = Math.max(0, Math.min(...rects.map(rect => rect.y)) - PAD - CROP_MARGIN);
  const right = Math.min(viewport.width, Math.max(...rects.map(rect => rect.x + rect.width)) + PAD + CROP_MARGIN);
  const bottom = Math.min(viewport.height, Math.max(...rects.map(rect => rect.y + rect.height)) + PAD + CROP_MARGIN);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

async function writeComparison(browser, output, manifest) {
  const crop = cropFor(manifest.phases, manifest.viewport);
  const sideBySide = crop.width <= SIDE_BY_SIDE_MAX_WIDTH;
  const page = await browser.newPage({ viewport: { width: sideBySide ? crop.width * 2 : crop.width, height: 100 } });
  try {
    const screenshots = await Promise.all(['before.png', 'after.png'].map(file => readFile(path.join(output, file))));
    await page.setContent(`<body style="margin:0;display:flex;flex-direction:${sideBySide ? 'row' : 'column'};font:24px sans-serif;background:white"></body>`);
    await page.evaluate(({ phases, images, crop }) => {
      phases.forEach((phase, index) => {
        const section = document.createElement('section');
        const heading = document.createElement('h3');
        heading.style.margin = '8px';
        heading.textContent = `${phase.label} · ${phase.revision}`;
        const frame = document.createElement('div');
        Object.assign(frame.style, { width: `${crop.width}px`, height: `${crop.height}px`, overflow: 'hidden' });
        const image = document.createElement('img');
        image.src = `data:image/png;base64,${images[index]}`;
        Object.assign(image.style, { display: 'block', marginLeft: `${-crop.x}px`, marginTop: `${-crop.y}px` });
        frame.append(image);
        section.append(heading, frame);
        document.body.append(section);
      });
    }, { phases: manifest.phases, images: screenshots.map(image => image.toString('base64')), crop });
    await page.locator('img').evaluateAll(images => Promise.all(images.map(image => image.decode())));
    await page.screenshot({ path: path.join(output, 'comparison.png'), fullPage: true });
  } finally {
    await page.close();
  }
  return { ...crop, layout: sideBySide ? 'side-by-side' : 'stacked' };
}

// Agents cannot play video, so the recording is also written as a timestamped frame grid.
async function writeContactSheet(browser, output, viewport) {
  const page = await browser.newPage();
  try {
    const video = (await readFile(path.join(output, 'comparison.webm'))).toString('base64');
    const sheet = await page.evaluate(async ({ video, viewport }) => {
      const player = document.createElement('video');
      player.muted = true;
      player.src = `data:video/webm;base64,${video}`;
      await new Promise((resolve, reject) => {
        player.onloadeddata = resolve;
        player.onerror = () => reject(new Error('Chromium could not decode comparison.webm'));
      });
      const duration = player.duration;
      if (!Number.isFinite(duration) || duration <= 0) throw new Error(`Invalid video duration: ${duration}`);
      const interval = Math.max(0.5, duration / 24);
      const times = [];
      for (let time = 0.1; time < duration; time += interval) times.push(time);
      const columns = 3;
      const width = 480;
      const height = Math.round(width * viewport.height / viewport.width);
      const canvas = document.createElement('canvas');
      canvas.width = columns * width;
      canvas.height = Math.ceil(times.length / columns) * (height + 28);
      const context = canvas.getContext('2d');
      context.fillStyle = 'white';
      context.fillRect(0, 0, canvas.width, canvas.height);
      for (const [index, time] of times.entries()) {
        await new Promise(resolve => {
          player.onseeked = resolve;
          player.currentTime = time;
        });
        const x = index % columns * width;
        const y = Math.floor(index / columns) * (height + 28);
        context.drawImage(player, x, y, width, height);
        context.strokeStyle = '#999';
        context.strokeRect(x + 0.5, y + 0.5, width - 1, height - 1);
        context.fillStyle = 'black';
        context.font = '18px sans-serif';
        context.fillText(`${time.toFixed(1)}s`, x + 8, y + height + 21);
      }
      return { duration, frames: times.length, image: canvas.toDataURL('image/png').split(',')[1] };
    }, { video, viewport });
    await writeFile(path.join(output, 'video-contact-sheet.png'), Buffer.from(sheet.image, 'base64'));
    return { duration: sheet.duration, frames: sheet.frames };
  } finally {
    await page.close();
  }
}

async function capture(flow, output, chromium) {
  if (flow.phases?.length !== 2) throw new Error('Exactly two before/after phases required');
  if (!flow.description) throw new Error('Flow needs a description: the tested interaction and whether data is mocked or live');
  for (const phase of flow.phases) {
    if (!phase.url === !phase.dir) throw new Error(`${phase.label} needs exactly one of url or dir`);
  }
  const viewport = flow.viewport ?? { width: 1440, height: 900 };
  await mkdir(output, { recursive: true });
  // Leftovers from an earlier run would otherwise pass for this run's result.
  await Promise.all(OUTPUTS.map(file => rm(path.join(output, file), { force: true })));
  const servers = [];
  const browser = await chromium.launch();
  const errors = [];
  const network = [];
  const consoleErrors = [];
  const manifest = { captureId: randomUUID(), description: flow.description, viewport, phases: [], pageErrors: errors, network };
  // Blocking service workers keeps every request visible to page.route mocks.
  const contextOptions = { viewport, serviceWorkers: 'block' };
  const newContext = async () => {
    const created = await browser.newContext(contextOptions);
    created.setDefaultTimeout(ACTION_TIMEOUT);
    created.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT);
    return created;
  };
  let context;
  try {
    const phases = [];
    for (const phase of flow.phases) {
      if (!phase.dir) {
        phases.push(phase);
        continue;
      }
      const served = await serveDirectory(phase.dir);
      servers.push(served.server);
      phases.push({ ...phase, url: served.url });
    }
    const origins = [...new Set(phases.map(phase => new URL(phase.url).origin))];
    for (const phase of phases) {
      const warmContext = await newContext();
      const warm = await warmContext.newPage();
      try {
        if (flow.setup) await flow.setup(warm, phase);
        await warm.goto(phase.url, { waitUntil: 'load' });
        if (flow.warmup) await flow.warmup(warm, phase);
        assertOrigin(warm, phase);
      } catch (error) {
        throw await failureContext(error, warm, { ...phase, label: `${phase.label} warm-up` }, output, []);
      } finally {
        await warmContext.close();
      }
    }
    context = await newContext();
    const page = await context.newPage();
    if (!page.screencast) throw new Error('Playwright >= 1.64 required for native evidence annotations');
    const cdp = await context.newCDPSession(page);
    let current = null;
    page.on('pageerror', error => errors.push(`${current}: ${error.message}`));
    page.on('console', message => {
      if (message.type() === 'error') consoleErrors.push(`${current}: ${message.text()}`);
    });
    page.on('requestfailed', request => {
      const failure = request.failure()?.errorText;
      // Navigation and teardown cancel in-flight requests; those are not app failures.
      if (failure !== 'net::ERR_ABORTED') network.push({ phase: current, method: request.method(), url: request.url(), failure });
    });
    page.on('response', response => {
      if (response.status() >= 400) {
        network.push({ phase: current, method: response.request().method(), url: response.url(), status: response.status() });
      }
    });
    const initScripts = [];
    for (const target of [page, context]) {
      const addInitScript = target.addInitScript.bind(target);
      target.addInitScript = async (...args) => {
        const disposable = await addInitScript(...args);
        initScripts.push(disposable);
        return disposable;
      };
    }
    await page.screencast.showActions({
      cursor: 'pointer',
      duration: 900,
      style: {
        point: 'width:20px;height:20px;border-radius:50%;background:#ff6a00;',
        highlight: 'outline:2px solid #0077b5;',
        title: 'display:none;',
      },
    });
    await page.screencast.start({ path: path.join(output, 'comparison.webm'), size: viewport, fps: 25 });
    for (const [index, phase] of phases.entries()) {
      // Each phase starts from a clean slate: no earlier routes, init scripts, cookies, or storage.
      await page.unrouteAll({ behavior: 'ignoreErrors' });
      await context.unrouteAll({ behavior: 'ignoreErrors' });
      for (const disposable of initScripts.splice(0)) await disposable.dispose();
      await context.clearCookies();
      for (const origin of origins) await cdp.send('Storage.clearDataForOrigin', { origin, storageTypes: 'all' });
      current = phase.label;
      try {
        if (flow.setup) await flow.setup(page, phase);
        await page.goto(phase.url, { waitUntil: 'domcontentloaded' });
        assertOrigin(page, phase);
        const caption = await page.screencast.showOverlay(
          `<div style="position:fixed;bottom:8px;left:8px;padding:10px;background:#111;color:white;font:20px sans-serif;">${escapeHtml(phase.label)} · ${escapeHtml(phase.revision)}</div>`,
        );
        const point = async locator => {
          await locator.hover();
          await page.waitForTimeout(250);
        };
        const targets = [];
        await phase.run(page, {
          point,
          click: async locator => { await point(locator); await locator.click(); },
          highlight: async (locator, label) => {
            await locator.waitFor({ state: 'visible' });
            targets.push({ locator, label });
          },
        });
        assertOrigin(page, phase);
        if (!targets.length) throw new Error(`No highlights in ${phase.label}`);
        await targets[0].locator.scrollIntoViewIfNeeded();
        const highlights = [];
        for (const [targetIndex, { locator, label }] of targets.entries()) {
          const box = await locator.boundingBox();
          const name = label ?? `#${targetIndex + 1}`;
          if (!box) throw new Error(`Highlight ${name} in ${phase.label} is no longer visible when run returns`);
          if (box.x < 0 || box.y < 0 || box.x + box.width > viewport.width || box.y + box.height > viewport.height) {
            throw new Error(`Highlight ${name} in ${phase.label} is not fully inside the ${viewport.width}x${viewport.height} viewport; enlarge the viewport or highlight a smaller area`);
          }
          highlights.push({ x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height), ...(label ? { label } : {}) });
        }
        const overlay = await page.screencast.showOverlay(highlightHtml(highlights, viewport));
        await page.screenshot({ path: path.join(output, index ? 'after.png' : 'before.png') });
        await page.waitForTimeout(2000);
        manifest.phases.push({ label: phase.label, revision: phase.revision, url: phase.url, ...(phase.dir ? { dir: phase.dir } : {}), highlights });
        await overlay.dispose();
        await caption.dispose();
      } catch (error) {
        throw await failureContext(error, page, phase, output, consoleErrors);
      }
    }
    await page.screencast.stop();
    if (errors.length) {
      const requests = network.map(entry => `${entry.phase}: ${entry.method} ${entry.url} ${entry.status ?? entry.failure}`);
      throw new Error(`Page errors: ${errors.join('; ')}${requests.length ? `\nNetwork issues: ${requests.join('; ')}` : ''}`);
    }
    await context.close();
    context = null;
    manifest.comparison = await writeComparison(browser, output, manifest);
    manifest.video = await writeContactSheet(browser, output, viewport);
    await writeFile(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2));
    await writeFile(path.join(output, 'comment.md'), commentBody(manifest));
  } finally {
    if (context) await context.close();
    await browser.close();
    for (const server of servers) server.close();
  }
  return manifest;
}

module.exports = { capture, loadChromium };
if (require.main === module) {
  const [flowPath, output] = process.argv.slice(2);
  if (!flowPath || !output) throw new Error('Usage: capture.cjs FLOW.cjs OUTPUT_DIRECTORY');
  // Errors carry their own diagnosis; a stack trace adds only noise.
  Promise.resolve()
    .then(() => capture(require(path.resolve(flowPath)), path.resolve(output), loadChromium()))
    .then(result => console.log(JSON.stringify(result, null, 2)))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
