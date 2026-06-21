const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadScript(telescopeAccuracy) {
    const elements = new Map();
    const alerts = [];

    function element(id, overrides = {}) {
        const base = {
            id,
            value: '',
            textContent: '',
            innerHTML: '',
            className: '',
            disabled: false,
            style: {},
            options: [],
            selectedIndex: 0,
            addEventListener() {},
            focus() {},
        };
        const node = { ...base, ...overrides };
        elements.set(id, node);
        return node;
    }

    element('remoteContent');
    element('lastUpdate');
    element('communitySubmissions');
    element('submissionsList');
    element('submitCommunity');
    element('submitHint');
    element('submitBtn');
    element('username');
    element('telescopeTime');
    element('addBtn');
    element('resetBtn');
    element('live-timer');
    element('results');
    element('observationsList');
    element('range');
    element('helpfulRangesList');
    element('telescopeType', {
        value: String(telescopeAccuracy),
        options: [
            { text: 'Wooden (±24 minutes)' },
            { text: 'Teak (±9 minutes)' },
            { text: 'Mahogany (±2 minutes)' },
        ],
        selectedIndex: telescopeAccuracy === 24 ? 0 : telescopeAccuracy === 9 ? 1 : 2,
    });

    const sandbox = {
        console,
        alert(message) {
            alerts.push(message);
        },
        fetch: async () => ({
            ok: true,
            json: async () => ({ schemaVersion: 2, absMin: null, absMax: null, sampleCount: 0 }),
        }),
        setInterval() {},
        setTimeout(callback) {
            callback();
        },
        Date,
        document: {
            getElementById(id) {
                const found = elements.get(id);
                if (!found) throw new Error(`Missing fixture element ${id}`);
                return found;
            },
        },
        __alerts: alerts,
    };

    const source = fs.readFileSync(path.join(__dirname, '..', 'script.js'), 'utf8');
    vm.runInNewContext(source, sandbox, { filename: 'script.js' });
    return sandbox;
}

test('helpful telescope ranges account for integer-display uncertainty', () => {
    for (const accuracy of [24, 9, 2]) {
        const sandbox = loadScript(accuracy);
        const effectiveAccuracy = accuracy + 0.5;
        const ranges = sandbox.calculateHelpfulRanges(100 - effectiveAccuracy, 100 + effectiveAccuracy);

        assert.equal(
            ranges.unhelpfulRange.min,
            100,
            `expected the exact middle ${accuracy}-minute telescope reading to be the first unhelpful reading`
        );
        assert.equal(
            ranges.unhelpfulRange.max,
            100,
            `expected the exact middle ${accuracy}-minute telescope reading to be the last unhelpful reading`
        );
        assert.equal(ranges.length, 2);
        assert.equal(ranges[0].max, 99.9);
        assert.equal(ranges[1].min, 100.1);
    }
});

test('empty telescope readings are rejected instead of treated as zero', () => {
    const sandbox = loadScript(9);
    sandbox.document.getElementById('telescopeTime').value = '';

    sandbox.addObservation();

    assert.deepEqual(sandbox.__alerts, ['Please enter a whole number of minutes']);
    assert.equal(sandbox.document.getElementById('results').hidden, true);
});

test('negative telescope readings are accepted', () => {
    const sandbox = loadScript(9);
    sandbox.document.getElementById('telescopeTime').value = '-5';

    sandbox.addObservation();

    assert.deepEqual(sandbox.__alerts, []);
    assert.equal(sandbox.document.getElementById('results').hidden, false);
});

test('helpful ranges extend into negative readings when prediction is near zero', () => {
    const sandbox = loadScript(9);
    // Simulate a prediction window whose lower bound was clamped to 0 by updatePrediction.
    // The telescope can still display negative integers, so the low helpful-reading
    // range must extend below zero, not be clamped to 0.
    const ranges = sandbox.calculateHelpfulRanges(0, 4.5);

    const lowRange = ranges.find(r => r.description.includes('Low'));
    assert.ok(lowRange, 'expected a low helpful range to exist');
    assert.ok(lowRange.min < 0, `expected low range to start below 0, got min=${lowRange.min}`);
});
