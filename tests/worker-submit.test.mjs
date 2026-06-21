import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { test } from 'node:test';

async function loadWorker() {
    const source = await fs.readFile(new URL('../worker/src/worker.js', import.meta.url), 'utf8');
    return import(`data:text/javascript,${encodeURIComponent(source)}`);
}

test('submit rejects oversized bodies before parsing or touching D1', async () => {
    const { default: worker } = await loadWorker();
    const env = {
        DB: {
            prepare() {
                throw new Error('D1 should not be used for oversized bodies');
            },
        },
    };
    const request = new Request('https://star-timer.test/submit', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': '8193',
            Origin: 'https://realdam.github.io',
        },
        body: '{',
    });

    const response = await worker.fetch(request, env);
    const body = await response.json();

    assert.equal(response.status, 413);
    assert.equal(body.ok, false);
    assert.match(body.error, /too large/i);
});
