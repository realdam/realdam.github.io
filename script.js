let observations = [];
let startTime = null;
let isProcessing = false;

// Inherent timing error from tick-based system
// - Integer rounding: up to 0.5 min
// - Tick alignment (0.6s = 0.01min): up to 0.01 min
// Combined: ~0.51 minutes
const TICK_ERROR = 0.51;

// Fetch remote timer data
async function fetchRemoteData() {
    try {
        // Add cache-busting parameter to prevent stale data
        const response = await fetch(`global-data.json?t=${new Date().getTime()}`);
        if (!response.ok) {
            throw new Error('Failed to fetch remote timer data');
        }
        const data = await response.json();
        updateRemoteDisplay(data);
    } catch (error) {
        console.error('Error fetching remote timer data:', error);
        document.getElementById('remoteContent').innerHTML = 
            '<div class="remote-offline">No remote data available</div>';
    }
}

function updateRemoteDisplay(data) {
    if (!data || !data.timestamp) {
        document.getElementById('remoteContent').innerHTML = 
            '<div class="remote-offline">No remote data available</div>';
        return;
    }
    
    const now = Date.now();
    const elapsed = (now - data.timestamp) / 1000 / 60; // minutes
    const minRemaining = Math.max(0, data.minTime - elapsed);
    const maxRemaining = Math.max(0, data.maxTime - elapsed);
    
    if (maxRemaining <= 0) {
        document.getElementById('remoteContent').innerHTML = 
            '<div class="remote-offline">No remote prediction available</div>';
    } else {
        document.getElementById('remoteContent').innerHTML = 
            `<div class="remote-range">${minRemaining.toFixed(1)} - ${maxRemaining.toFixed(1)} minutes</div>`;
    }
    
    const lastUpdateTime = new Date(data.timestamp);
    document.getElementById('lastUpdate').textContent = 
        `Last updated: ${lastUpdateTime.toLocaleString()}`;
}

function addObservation() {
    if (isProcessing) return;
    
    const input = document.getElementById('telescopeTime');
    const telescopeType = document.getElementById('telescopeType');
    const value = parseInt(input.value);
    const accuracy = parseInt(telescopeType.value);

    if (isNaN(value)) {
        alert('Please enter a valid time');
        return;
    }

    if (Math.abs(value) > 200) {
        alert("Reading seems unrealistic");
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
        accuracy: accuracy,
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
    const currentAccuracy = parseInt(document.getElementById('telescopeType').value);
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
    
    // For a telescope reading R with accuracy A:
    // The actual time must be in [R-A, R+A]
    // This narrows our current range [minPossible, maxPossible] if:
    // Either R+A < maxPossible OR R-A > minPossible
    
    // What telescope readings are actually possible given our current estimate?
    // If actual time is minPossible, telescope shows: minPossible + [-A, +A]
    // If actual time is maxPossible, telescope shows: maxPossible + [-A, +A]
    // So possible telescope readings: [minPossible-A, maxPossible+A]
    
    const minPossibleReading = minPossible - currentAccuracy;
    const maxPossibleReading = maxPossible + currentAccuracy;
    
    // For a reading R to narrow our estimate:
    // Case 1: R+A < maxPossible (narrows the upper bound)
    //         R < maxPossible - A
    // Case 2: R-A > minPossible (narrows the lower bound)  
    //         R > minPossible + A
    
    // Readings that don't help are those where:
    // R+A >= maxPossible AND R-A <= minPossible
    // Which means: maxPossible - A <= R <= minPossible + A
    
    const unhelpfulMin = maxPossible - currentAccuracy;
    const unhelpfulMax = minPossible + currentAccuracy;
    
    // Check if there's actually an unhelpful range
    if (unhelpfulMin <= unhelpfulMax) {
        // There's an unhelpful middle range
        
        // Low helpful readings (those that narrow the upper bound)
        if (minPossibleReading < unhelpfulMin) {
            ranges.push({
                min: minPossibleReading,
                max: unhelpfulMin - 0.1,
                description: "Low readings (narrow the maximum)"
            });
        }
        
        // High helpful readings (those that narrow the lower bound)
        if (unhelpfulMax < maxPossibleReading) {
            ranges.push({
                min: unhelpfulMax + 0.1,
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
            description: "No readings will improve the estimate with this telescope"
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
        document.getElementById('results').style.display = 'none';
        document.getElementById('observationsList').innerHTML = '<div class="no-help">No observations made yet.</div>';
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
        const obsMin = adjusted - obs.accuracy - TICK_ERROR;
        const obsMax = adjusted + obs.accuracy + TICK_ERROR;
        minPossible = Math.max(minPossible, obsMin);
        maxPossible = Math.min(maxPossible, obsMax);
    });
    
    // If ranges don't overlap properly, show the midpoint
    if (minPossible > maxPossible) {
        document.getElementById('range').textContent = "Conflicting observations - ranges don't overlap";
        document.getElementById('helpfulRangesList').innerHTML = '<div class="no-help">Cannot calculate helpful ranges with conflicting observations</div>';
        // Observations remain editable, timer continues updating
        // Update observations list only
        const currentTime = Date.now();
        const totalElapsed = (currentTime - startTime) / 1000 / 60;
        const adjustedObservations = observations.map(obs => {
            const timeSinceObs = totalElapsed - obs.elapsedMinutes;
            return obs.observedTime - timeSinceObs;
        });
        const listHtml = observations.map((obs, index) => {
            const adjusted = adjustedObservations[index];
            const timeLabel = obs.elapsedMinutes < 0.05 ? 'T=0' : `T+${obs.elapsedMinutes.toFixed(1)} min`;
            return `<div class="observation-item">
                    <div class="observation-text">
                        Observation ${index + 1}: ${obs.observedTime} min
                        (${obs.telescopeType}, ${timeLabel})
                    </div>
                    <button class="remove-btn" onclick="removeObservation(${index})">Remove</button>
                </div>`;
        }).join('');
        document.getElementById('observationsList').innerHTML = listHtml;
        return;
    }

    // Display results
    document.getElementById('results').style.display = 'block';
    const displayMin = Math.max(0, minPossible);
    const displayMax = Math.max(0, maxPossible);
    document.getElementById('range').textContent = `${displayMin.toFixed(1)} - ${displayMax.toFixed(1)} minutes`;
    
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
                            Readings between ${uMin.toFixed(1)} - ${uMax.toFixed(1)} min won't narrow the estimate
                        </div>`;
            }
        }
        
        // Show helpful ranges
        helpfulRangesHtml += helpfulRanges.filter(r => r.min !== -1).map(range => 
            `<div class="range-item">
                        <span class="range-highlight">${range.min.toFixed(1)} - ${range.max.toFixed(1)} min</span>
                        <span style="color: #888; margin-left: 10px;">${range.description}</span>
                    </div>`
        ).join('');
        
        // Add debug info (can be removed in production)
        const debugInfo = `
                    <div class="debug-info">
                        Current estimate: ${minPossible.toFixed(1)} - ${maxPossible.toFixed(1)} min<br>
                        Telescope accuracy: ±${parseInt(document.getElementById('telescopeType').value)} min<br>
                        Possible readings: ${Math.max(0, minPossible - parseInt(document.getElementById('telescopeType').value)).toFixed(1)} - ${(maxPossible + parseInt(document.getElementById('telescopeType').value)).toFixed(1)} min
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
                        (${obs.telescopeType}, ${timeLabel})
                    </div>
                    <button class="remove-btn" onclick="removeObservation(${index})">Remove</button>
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
document.getElementById('telescopeTime').addEventListener('keypress', function(e) {
    if (e.key === 'Enter' && !isProcessing) {
        e.preventDefault();
        addObservation();
    }
});

// Update the timer every second
setInterval(updatePrediction, 1000);

// Fetch remote data every 30 seconds
setInterval(fetchRemoteData, 30000);

// Initial fetch
fetchRemoteData();
updatePrediction();

// Focus on input when page loads
document.getElementById('telescopeTime').focus(); 