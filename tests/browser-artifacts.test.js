'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { writeFailureArtifacts } = require('./browser-smoke.js');

test('browser failures retain stack, screenshot, and page HTML when requested', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'stormscope-browser-artifacts-'));
  const previous = process.env.STORMSCOPE_TEST_ARTIFACTS;
  process.env.STORMSCOPE_TEST_ARTIFACTS = directory;
  const page = {
    screenshot({ path: screenshotPath }) {
      fs.writeFileSync(screenshotPath, Buffer.from('png'));
      return Promise.resolve();
    },
    content() { return Promise.resolve('<!doctype html><title>Failure state</title>'); }
  };
  try {
    await writeFailureArtifacts({ pages: () => [page] }, 'Firefox failure', new Error('fixture failed'));
    assert.match(fs.readFileSync(path.join(directory, 'firefox-failure-error.txt'), 'utf8'), /fixture failed/);
    assert.equal(fs.readFileSync(path.join(directory, 'firefox-failure-page-1.png'), 'utf8'), 'png');
    assert.match(fs.readFileSync(path.join(directory, 'firefox-failure-page-1.html'), 'utf8'), /Failure state/);
  } finally {
    if (previous === undefined) delete process.env.STORMSCOPE_TEST_ARTIFACTS;
    else process.env.STORMSCOPE_TEST_ARTIFACTS = previous;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
