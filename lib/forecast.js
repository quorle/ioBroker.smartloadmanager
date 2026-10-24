'use strict';

/**
 * Determine the conversion factor for forecast power values.
 *
 * @param {'W'|'kW'|null|undefined} unit Configured or detected power unit.
 * @param {number[]} values Raw forecast values used for automatic detection.
 * @returns {number} Multiplier to convert forecast values to watts.
 */
function powerFactor(unit, values = []) {
    if (unit === 'W') {
        return 1;
    }
    if (unit === 'kW') {
        return 1000;
    }
    const finite = values.filter(Number.isFinite).map(Math.abs);
    return finite.length && Math.max(...finite) <= 100 ? 1000 : 1;
}

/**
 * Parse pvforecast JSONData into normalized future data points.
 *
 * @param {string|Array<{t: number, y: number}>} value JSON string or decoded pvforecast array.
 * @param {{now?: number, unit?: 'W'|'kW'|null, baseload?: number}} options Parser options.
 * @returns {Array<{timestamp: number, power: number, surplus: number}>} Normalized forecast points.
 */
function parseForecast(value, options = {}) {
    const now = options.now || Date.now();
    let data = value;
    if (typeof data === 'string') {
        data = JSON.parse(data);
    }
    if (!Array.isArray(data)) {
        throw new Error('Forecast must be an array');
    }

    const raw = data
        .map(entry => ({ timestamp: Number(entry?.t), value: Number(entry?.y) }))
        .filter(entry => Number.isFinite(entry.timestamp) && Number.isFinite(entry.value) && entry.timestamp >= now)
        .sort((a, b) => a.timestamp - b.timestamp);
    const factor = powerFactor(
        options.unit,
        raw.map(entry => entry.value),
    );
    const baseload = Math.max(0, Number(options.baseload) || 0);
    return raw.map(entry => ({
        timestamp: entry.timestamp,
        power: Math.max(0, Math.round(entry.value * factor)),
        surplus: Math.max(0, Math.round(entry.value * factor - baseload)),
    }));
}

/**
 * Find a sustained forecast window with enough conservative surplus.
 *
 * @param {Array<{timestamp: number, surplus: number}>} points Normalized forecast points.
 * @param {{now?: number, requiredPower?: number, safetyFactor?: number, minDurationMinutes?: number, maxStartMinutes?: number}} options Evaluation limits.
 * @returns {{available: boolean, startMinutes: number|null, durationMinutes: number, minimumSurplus: number, averageSurplus: number}} Forecast decision.
 */
function evaluateForecast(points, options = {}) {
    const now = options.now || Date.now();
    points = points
        .filter(point => Number.isFinite(point.timestamp) && Number.isFinite(point.surplus) && point.timestamp >= now)
        .sort((a, b) => a.timestamp - b.timestamp);
    const requiredPower = Math.max(0, Number(options.requiredPower) || 0);
    const safetyFactor = Math.min(1, Math.max(0.1, Number(options.safetyFactor) || 0.8));
    const minDurationMinutes = Math.max(1, Number(options.minDurationMinutes) || 30);
    const maxStartMinutes = Math.max(
        0,
        options.maxStartMinutes === undefined ? 30 : Number(options.maxStartMinutes) || 0,
    );
    const threshold = requiredPower / safetyFactor;
    const maxStart = now + maxStartMinutes * 60000;
    const fallbackStep = 15 * 60000;

    for (let start = 0; start < points.length; start++) {
        if (points[start].timestamp > maxStart || points[start].surplus < threshold) {
            continue;
        }
        let end = start;
        let minimum = points[start].surplus;
        let sum = 0;
        while (end < points.length && points[end].surplus >= threshold) {
            if (end > start) {
                const gap = points[end].timestamp - points[end - 1].timestamp;
                if (gap > 90 * 60000) {
                    break;
                }
            }
            minimum = Math.min(minimum, points[end].surplus);
            sum += points[end].surplus;
            end++;
        }
        const step = end - start > 1 ? points[start + 1].timestamp - points[start].timestamp : fallbackStep;
        const durationMinutes = Math.round((points[end - 1].timestamp - points[start].timestamp + step) / 60000);
        if (durationMinutes >= minDurationMinutes) {
            return {
                available: true,
                startMinutes: Math.max(0, Math.round((points[start].timestamp - now) / 60000)),
                durationMinutes,
                minimumSurplus: minimum,
                averageSurplus: Math.round(sum / (end - start)),
            };
        }
    }
    return { available: false, startMinutes: null, durationMinutes: 0, minimumSurplus: 0, averageSurplus: 0 };
}

/**
 * Check whether a minimum on/off period has elapsed.
 *
 * @param {number} lastChange Timestamp of the last state change.
 * @param {number} minimumMinutes Required state duration in minutes.
 * @param {number} now Current timestamp.
 * @returns {boolean} Whether a new state change is allowed.
 */
function minimumStateTimeSatisfied(lastChange, minimumMinutes, now = Date.now()) {
    const minimumMs = Math.max(0, Number(minimumMinutes) || 0) * 60000;
    return !lastChange || now - lastChange >= minimumMs;
}

module.exports = { evaluateForecast, minimumStateTimeSatisfied, parseForecast, powerFactor };
