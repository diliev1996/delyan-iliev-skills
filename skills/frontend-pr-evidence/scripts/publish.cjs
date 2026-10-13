// Posts capture output as one PR comment through gh, then verifies GitHub hosts both attachments.
const { execFile } = require('node:child_process');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const { promisify } = require('node:util');
const run = promisify(execFile);

async function gh(...args) {
  try {
    return (await run('gh', args, { maxBuffer: 64 * 1024 * 1024 })).stdout;
  } catch (error) {
    throw new Error(`gh ${args.join(' ')} failed:\n${error.stderr || error.message}`);
  }
}

function parsePullRequest(url) {
  const match = /^https:\/\/([^/]+)\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(url);
  if (!match) throw new Error(`Expected a pull request URL like https://github.com/OWNER/REPO/pull/123; got ${url}`);
  const [, host, owner, repo, number] = match;
  return { host, repo: `${owner}/${repo}`, number };
}

// Revisions in a flow may be short SHAs; both sides must agree on the shared prefix.
function sameCommit(captured, actual) {
  return captured.length >= 7 && actual.startsWith(captured);
}

async function publish(directory, prUrl) {
  const { host, repo, number } = parsePullRequest(prUrl);
  const manifest = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8'));
  const [before, after] = manifest.phases;
  if (!(await gh('pr', 'comment', '--help')).includes('--attach')) {
    throw new Error('This gh lacks `pr comment --attach`; upgrade gh through its installation manager');
  }
  const pr = JSON.parse(await gh('pr', 'view', prUrl, '--json', 'headRefOid,baseRefName'));
  const compare = JSON.parse(await gh('api', '--hostname', host, `repos/${repo}/compare/${pr.baseRefName}...${pr.headRefOid}`));
  const mergeBase = compare.merge_base_commit.sha;
  if (!sameCommit(after.revision, pr.headRefOid)) {
    throw new Error(`Evidence ${after.label} is ${after.revision} but the PR head is ${pr.headRefOid}; recapture at the current head`);
  }
  if (!sameCommit(before.revision, mergeBase)) {
    throw new Error(`Evidence ${before.label} is ${before.revision} but the merge base is ${mergeBase}; recapture at the merge base`);
  }
  // The marker names this capture, so retrying a publish reuses its comment while a recapture posts a new one.
  const marker = `<!-- frontend-pr-evidence:${after.revision}:${manifest.captureId} -->`;
  const pages = JSON.parse(await gh('api', '--hostname', host, '--paginate', '--slurp', `repos/${repo}/issues/${number}/comments`));
  const existing = pages.flat().find(comment => comment.body?.includes(marker));
  let commentId = existing?.id;
  if (!existing) {
    const posted = await gh('pr', 'comment', prUrl,
      '--body-file', path.join(directory, 'comment.md'),
      '--attach', `${path.join(directory, 'comparison.png')}#Before and after UI comparison`,
      '--attach', path.join(directory, 'comparison.webm'));
    commentId = /#issuecomment-(\d+)/.exec(posted)?.[1];
    if (!commentId) throw new Error(`gh did not print a comment URL:\n${posted}`);
  }
  const comment = JSON.parse(await gh('api', '--hostname', host, `repos/${repo}/issues/comments/${commentId}`));
  const urls = comment.body.match(/https:\/\/\S+/g) ?? [];
  const missing = [marker, before.revision, after.revision].filter(text => !comment.body.includes(text));
  if (missing.length) throw new Error(`Comment ${comment.html_url} is missing: ${missing.join(', ')}`);
  if (urls.length < 2) throw new Error(`Comment ${comment.html_url} has ${urls.length} hosted attachment URLs; expected the image and the video`);
  return { url: comment.html_url, commentId: Number(commentId), reused: Boolean(existing) };
}

module.exports = { publish };
if (require.main === module) {
  const [directory, prUrl] = process.argv.slice(2);
  if (!directory || !prUrl) throw new Error('Usage: publish.cjs EVIDENCE_DIRECTORY PULL_REQUEST_URL');
  publish(path.resolve(directory), prUrl)
    .then(result => console.log(JSON.stringify(result, null, 2)))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
