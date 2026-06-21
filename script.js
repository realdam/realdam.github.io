// ============================================================================
// Configuration
// ----------------------------------------------------------------------------
// After deploying the Cloudflare Worker (see worker/README.md), paste its URL
// here WITHOUT a trailing slash, e.g. 'https://star-timer.yourname.workers.dev'.
// While left empty, the page falls back to the legacy static global-data.json
// and the community submit form stays hidden — so the site keeps working
// exactly as before until you flip this on.
const REMOTE_API = 'https://star-timer.realdam.workers.dev';
// ============================================================================

let observations = [];
let startTime = null;
let isProcessing = false;
let latestPrediction = null; // { min, max } in minutes-from-now, or null when no observations
const ROUNDING_UNCERTAINTY = 0.5; // Integer display adds +-0.5 min uncertainty
const TICK_DURATION = 0.01; // 0.6 seconds = 0.01 minutes (negligible, documented only)
const DISPLAY_STEP = 0.1;

// --- Small helpers -----------------------------------------------------------

// Escape user-controlled text before inserting into innerHTML. CRITICAL: usernames
// are attacker-controlled and echoed into the page, so this prevents stored XSS.
function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (c) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
    }[c]));
}

function relativeTime(timestamp) {
    const diffMin = (Date.now() - timestamp) / 60000;
    if (diffMin < 1) return 'just now';
    if (diffMin < 60) return `${Math.floor(diffMin)}m ago`;
    return `${Math.floor(diffMin / 60)}h ago`;
}

// --- Remote / community timer ------------------------------------------------

async function fetchRemoteData() {
    try {
        const url = REMOTE_API ? `${REMOTE_API}/data` : `global-data.json?t=${Date.now()}`;
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error('Failed to fetch remote timer data');
        }
        const data = await response.json();
        updateRemoteDisplay(data);
        renderSubmissions(data);
    } catch (error) {
        console.error('Error fetching remote timer data:', error);
        document.getElementById('remoteContent').innerHTML =
            '<div class="remote-offline">No remote data available</div>';
        renderSubmissions(null);
    }
}

function updateRemoteDisplay(data) {
    const content = document.getElementById('remoteContent');
    const lastUpdateEl = document.getElementById('lastUpdate');

    if (!data) {
        content.innerHTML = '<div class="remote-offline">No remote data available</div>';
        lastUpdateEl.textContent = '';
        return;
    }

    const now = Date.now();
    let absMin = null;
    let absMax = null;
    let sampleCount = null;
    let computedAt = null;

    if (data.absMin != null && data.absMax != null) {
        // New community shape (absolute epoch-ms window + median consensus).
        absMin = data.absMin;
        absMax = data.absMax;
        sampleCount = data.sampleCount;
        computedAt = data.computedAt;
    } else if (data.timestamp != null && data.minTime != null && data.maxTime != null) {
        // Legacy static shape: relative minutes anchored at a timestamp.
        absMin = data.timestamp + data.minTime * 60000;
        absMax = data.timestamp + data.maxTime * 60000;
        computedAt = data.timestamp;
    }

    if (absMin == null || (sampleCount != null && sampleCount === 0)) {
        content.innerHTML = REMOTE_API
            ? '<div class="remote-offline">No community predictions yet — be the first below!</div>'
            : '<div class="remote-offline">No remote data available</div>';
        lastUpdateEl.textContent = '';
        return;
    }

    const minRemaining = Math.max(0, (absMin - now) / 60000);
    const maxRemaining = Math.max(0, (absMax - now) / 60000);

    if (maxRemaining <= 0) {
        content.innerHTML = '<div class="remote-offline">No remote prediction available</div>';
    } else {
        const consensus = sampleCount != null
            ? `<div class="remote-consensus">consensus of ${sampleCount} prediction${sampleCount === 1 ? '' : 's'}</div>`
            : '';
        content.innerHTML =
            `<div class="remote-range">${minRemaining.toFixed(1)} - ${maxRemaining.toFixed(1)} minutes</div>${consensus}`;
    }

    lastUpdateEl.textContent = computedAt
        ? `Last updated: ${new Date(computedAt).toLocaleString()}`
        : '';
}

function renderSubmissions(data) {
    const section = document.getElementById('communitySubmissions');
    const list = document.getElementById('submissionsList');
    if (!section || !list) return;

    if (!REMOTE_API) {
        section.hidden = true;
        return;
    }
    section.hidden = false;

    const subs = (data && data.submissions) || [];
    if (!subs.length) {
        list.innerHTML = '<div class="no-help">No community predictions yet — be the first!</div>';
        return;
    }

    list.innerHTML = subs.map((s) => {
        const telescope = s.telescopeType ? ` · ${escapeHtml(s.telescopeType)}` : '';
        const expiredTag = s.expired ? ' · expired' : '';
        return `<div class="submission-item${s.expired ? ' expired' : ''}">
                    <span class="submission-name">${escapeHtml(s.username)}</span>
                    <span class="submission-window">${Number(s.minTime).toFixed(1)} – ${Number(s.maxTime).toFixed(1)} min${telescope}</span>
                    <span class="submission-time">${relativeTime(s.submittedAt)}${expiredTag}</span>
                </div>`;
    }).join('');
}

async function submitPrediction() {
    if (!REMOTE_API) return;

    const nameInput = document.getElementById('username');
    const statusEl = document.getElementById('submitStatus');
    const username = nameInput.value.trim();

    if (!username) {
        statusEl.textContent = 'Enter a name first.';
        statusEl.className = 'submit-status error';
        return;
    }
    if (!latestPrediction) {
        statusEl.textContent = 'Add a telescope observation first.';
        statusEl.className = 'submit-status error';
        return;
    }

    const btn = document.getElementById('submitBtn');
    btn.disabled = true;
    statusEl.textContent = 'Submitting…';
    statusEl.className = 'submit-status';

    const telescopeSel = document.getElementById('telescopeType');
    const telescopeType = telescopeSel.options[telescopeSel.selectedIndex].text.split(' ')[0];

    try {
        const response = await fetch(`${REMOTE_API}/submit`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                username,
                minTime: Number(latestPrediction.min.toFixed(1)),
                maxTime: Number(latestPrediction.max.toFixed(1)),
                telescopeType,
            }),
        });
        const data = await response.json().catch(() => ({}));
        if (response.ok && data.ok) {
            statusEl.textContent = `Submitted — thanks, ${username}!`;
            statusEl.className = 'submit-status success';
            fetchRemoteData();
        } else {
            statusEl.textContent = data.error || 'Submission failed. Please try again.';
            statusEl.className = 'submit-status error';
        }
    } catch (error) {
        console.error('Submission error:', error);
        statusEl.textContent = 'Network error — could not reach the server.';
        statusEl.className = 'submit-status error';
    } finally {
        updateSubmitUI();
    }
}

function updateSubmitUI() {
    const btn = document.getElementById('submitBtn');
    const hint = document.getElementById('submitHint');
    if (!btn || !hint) return;

    if (latestPrediction) {
        btn.disabled = false;
        hint.textContent =
            `You'll submit your current prediction: ${latestPrediction.min.toFixed(1)} – ${latestPrediction.max.toFixed(1)} minutes.`;
    } else {
        btn.disabled = true;
        hint.textContent = 'Add a telescope observation above to generate a prediction you can submit.';
    }
}

function initCommunity() {
    const submitBlock = document.getElementById('submitCommunity');
    const communityBlock = document.getElementById('communitySubmissions');
    if (submitBlock) submitBlock.hidden = !REMOTE_API;
    if (communityBlock) communityBlock.hidden = !REMOTE_API;
    updateSubmitUI();
}

// --- Local telescope timer ----------------------------------------------------

function effectiveTelescopeAccuracy(baseAccuracy) {
    return baseAccuracy + ROUNDING_UNCERTAINTY;
}

function addObservation() {
    if (isProcessing) return;

    const input = document.getElementById('telescopeTime');
    const telescopeType = document.getElementById('telescopeType');
    const rawValue = input.value.trim();
    const value = Number(input.value);
    const accuracy = parseInt(telescopeType.value, 10);

    if (!rawValue || !Number.isInteger(value) || value < 0) {
        alert('Please enter a whole non-negative number of minutes');
        return;
    }

    isProcessing = true;
    document.getElementById('addBtn').disabled = true;

    const currentTime = Date.now();

    if (observations.length === 0) {
        startTime = currentTime;
    }

    const elapsedSeconds = (currentTime - startTime) / 1000;
    const elapsedMinutes = elapsedSeconds / 60;

    observations.push({
        observedTime: value,
        elapsedMinutes: elapsedMinutes,
        timestamp: currentTime,
        baseAccuracy: accuracy,
        accuracy: effectiveTelescopeAccuracy(accuracy),
        telescopeType: telescopeType.options[telescopeType.selectedIndex].text.split(' ')[0]
    });

    updatePrediction();
    input.value = '';
    input.focus();

    setTimeout(() => {
        isProcessing = false;
        document.getElementById('addBtn').disabled = false;
    }, 100);
}

function removeObservation(index) {
    observations.splice(index, 1);
    updatePrediction();
}

function calculateHelpfulRanges(minPossible, maxPossible) {
    const currentAccuracy = parseInt(document.getElementById('telescopeType').value, 10);
    const effectiveAccuracy = effectiveTelescopeAccuracy(currentAccuracy);
    const ranges = [];

    // Current range width
    const currentRange = maxPossible - minPossible;

    if (currentRange <= 0.1) {
        return [{
            min: -1,
            max: -1,
            description: "Prediction is already very precise"
        }];
    }

    // Removed: The "telescope too imprecise" early-return was incorrect.
    // Even when accuracy > range/2, individual readings at the extremes can still
    // narrow the estimate. The logic below correctly calculates which specific
    // readings would be helpful vs unhelpful.
    // For a telescope reading R with accuracy A:
    // The actual time must be in [R-A, R+A]
    // This narrows our current range [minPossible, maxPossible] if:
    // Either R+A < maxPossible OR R-A > minPossible

    // What telescope readings are actually possible given our current estimate?
    // If actual time is minPossible, telescope shows: minPossible + [-A, +A]
    // If actual time is maxPossible, telescope shows: maxPossible + [-A, +A]
    // So possible telescope readings: [minPossible-A, maxPossible+A]

    const minPossibleReading = Math.max(0, minPossible - effectiveAccuracy);
    const maxPossibleReading = maxPossible + effectiveAccuracy;

    // For a reading R to narrow our estimate:
    // Case 1: R+A < maxPossible (narrows the upper bound)
    //         R < maxPossible - A
    // Case 2: R-A > minPossible (narrows the lower bound)
    //         R > minPossible + A

    // Readings that don't help are those where:
    // R+A >= maxPossible AND R-A <= minPossible
    // Which means: maxPossible - A <= R <= minPossible + A

    const unhelpfulMin = maxPossible - effectiveAccuracy;
    const unhelpfulMax = minPossible + effectiveAccuracy;

    // Check if there's actually an unhelpful range
    if (unhelpfulMin <= unhelpfulMax) {
        // There's an unhelpful middle range

        // Low helpful readings (those that narrow the upper bound)
        if (minPossibleReading < unhelpfulMin) {
            ranges.push({
                min: minPossibleReading,
                max: unhelpfulMin - DISPLAY_STEP,
                description: "Low readings (narrow the maximum)"
            });
        }

        // High helpful readings (those that narrow the lower bound)
        if (unhelpfulMax < maxPossibleReading) {
            ranges.push({
                min: unhelpfulMax + DISPLAY_STEP,
                max: maxPossibleReading,
                description: "High readings (narrow the minimum)"
            });
        }

        // Store unhelpful range for display
        if (ranges.length > 0) {
            ranges.unhelpfulRange = {
                min: Math.max(minPossibleReading, unhelpfulMin),
                max: Math.min(maxPossibleReading, unhelpfulMax)
            };
        }
    } else {
        // All possible readings would help
        ranges.push({
            min: minPossibleReading,
            max: maxPossibleReading,
            description: "Any reading in this range will improve the estimate"
        });
    }

    // If no helpful ranges exist within possible readings
    if (ranges.length === 0) {
        return [{
            min: -1,
            max: -1,
            description: "Any reading from this telescope would fall within the current range. Try taking multiple observations - they may still help narrow the estimate over time."
        }];
    }

    return ranges;
}

function updatePrediction() {
    const timerElement = document.getElementById('live-timer');
    if (startTime) {
        const elapsedSeconds = (Date.now() - startTime) / 1000;
        const minutes = Math.floor(elapsedSeconds / 60);
        const seconds = Math.floor(elapsedSeconds % 60).toString().padStart(2, '0');
        timerElement.textContent = `(T+ ${minutes}m ${seconds}s)`;
    } else {
        timerElement.textContent = '(Current T=0)';
    }

    if (observations.length === 0) {
        document.getElementById('results').hidden = true;
        document.getElementById('observationsList').innerHTML = '<div class="no-help">No observations made yet.</div>';
        latestPrediction = null;
        updateSubmitUI();
        return;
    }

    const currentTime = Date.now();
    const totalElapsed = (currentTime - startTime) / 1000 / 60;

    // Adjust all observations to current time
    const adjustedObservations = observations.map(obs => {
        const timeSinceObs = totalElapsed - obs.elapsedMinutes;
        return obs.observedTime - timeSinceObs;
    });

    // Calculate the possible range considering each observation's accuracy
    let minPossible = -Infinity;
    let maxPossible = Infinity;

    observations.forEach((obs, index) => {
        const adjusted = adjustedObservations[index];
        const obsMin = adjusted - obs.accuracy;
        const obsMax = adjusted + obs.accuracy;
        minPossible = Math.max(minPossible, obsMin);
        maxPossible = Math.min(maxPossible, obsMax);
    });

    // Ensure we don't have negative ranges
    minPossible = Math.max(0, minPossible);
    maxPossible = Math.max(0, maxPossible);

    // If ranges don't overlap properly, show the midpoint
    if (minPossible > maxPossible) {
        const mid = (minPossible + maxPossible) / 2;
        minPossible = mid;
        maxPossible = mid;
    }

    // Display results
    document.getElementById('results').hidden = false;
    document.getElementById('range').textContent = `${minPossible.toFixed(1)} - ${maxPossible.toFixed(1)} minutes`;

    // Make the current prediction available to the community submit form.
    latestPrediction = { min: minPossible, max: maxPossible };
    updateSubmitUI();

    // Calculate and display helpful ranges
    const helpfulRanges = calculateHelpfulRanges(minPossible, maxPossible);
    let helpfulRangesHtml = '';

    if (helpfulRanges.length > 0 && helpfulRanges[0].min === -1) {
        // No helpful ranges
        helpfulRangesHtml = '<div class="no-help">' + helpfulRanges[0].description + '</div>';
    } else {
        // Show unhelpful range warning if applicable
        if (helpfulRanges.unhelpfulRange) {
            const uMin = helpfulRanges.unhelpfulRange.min;
            const uMax = helpfulRanges.unhelpfulRange.max;
            if (uMin <= uMax) {
                helpfulRangesHtml = `<div class="unhelpful-warning">
                            Readings between ${Math.round(uMin)} - ${Math.round(uMax)} min won't narrow the estimate
                        </div>`;
            }
        }

        // Show helpful ranges
        helpfulRangesHtml += helpfulRanges.filter(r => r.min !== -1).map(range =>
            `<div class="range-item">
                        <span class="range-highlight">${range.min.toFixed(1)} - ${range.max.toFixed(1)} min</span>
                        <span class="range-description">${range.description}</span>
                    </div>`
        ).join('');

        // Add debug info (can be removed in production)
        const baseAccuracy = parseInt(document.getElementById('telescopeType').value, 10);
        const effectiveAccuracyDisplay = effectiveTelescopeAccuracy(baseAccuracy);
        const debugInfo = `
                    <div class="debug-info">
                        Current estimate: ${minPossible.toFixed(1)} - ${maxPossible.toFixed(1)} min<br>
                        Telescope accuracy: ±${baseAccuracy} min (±${effectiveAccuracyDisplay.toFixed(1)} min effective with rounding)<br>
                        Possible readings: ${Math.max(0, minPossible - effectiveAccuracyDisplay).toFixed(1)} - ${(maxPossible + effectiveAccuracyDisplay).toFixed(1)} min
                    </div>
                `;
        helpfulRangesHtml += debugInfo;
    }

    document.getElementById('helpfulRangesList').innerHTML = helpfulRangesHtml;

    // Update observations list
    const listHtml = observations.map((obs, index) => {
        const adjusted = adjustedObservations[index];
        const timeLabel = obs.elapsedMinutes < 0.05 ? 'T=0' : `T+${obs.elapsedMinutes.toFixed(1)} min`;
        return `<div class="observation-item">
                    <div class="observation-text">
                        Observation ${index + 1}: ${obs.observedTime} min
                        (${obs.telescopeType} ±${obs.accuracy.toFixed(1)}, ${timeLabel})
                    </div>
                    <button class="remove-btn" type="button" data-remove-index="${index}">Remove</button>
                </div>`;
    }).join('');

    document.getElementById('observationsList').innerHTML = listHtml;
}

function resetObservations() {
    observations = [];
    startTime = null;
    updatePrediction();
    document.getElementById('telescopeTime').value = '';
    document.getElementById('telescopeTime').focus();
}

// Allow Enter key to add observation
document.getElementById('addBtn').addEventListener('click', addObservation);
document.getElementById('resetBtn').addEventListener('click', resetObservations);

document.getElementById('telescopeTime').addEventListener('keypress', function(e) {
    if (e.key === 'Enter' && !isProcessing) {
        e.preventDefault();
        addObservation();
    }
});

// Allow Enter key in the username field to submit to the community timer
const usernameInput = document.getElementById('username');
if (usernameInput) {
    usernameInput.addEventListener('keypress', function(e) {
        if (e.key === 'Enter') {
            e.preventDefault();
            submitPrediction();
        }
    });
}

const submitButton = document.getElementById('submitBtn');
if (submitButton) {
    submitButton.addEventListener('click', submitPrediction);
}

document.getElementById('observationsList').addEventListener('click', function(e) {
    const button = e.target.closest('[data-remove-index]');
    if (!button) return;
    removeObservation(Number(button.dataset.removeIndex));
});

// Update the timer every second
setInterval(updatePrediction, 1000);

// Fetch remote data every 30 seconds
setInterval(fetchRemoteData, 30000);

// Initial setup
initCommunity();
fetchRemoteData();
updatePrediction();

// Focus on input when page loads
document.getElementById('telescopeTime').focus();
