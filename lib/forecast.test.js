'use strict';

/* global describe, it */

const { expect } = require('chai');
const { evaluateForecast, minimumStateTimeSatisfied, parseForecast, powerFactor } = require('./forecast');

describe('forecast logic', () => {
    const now = Date.UTC(2026, 7, 8, 10, 0, 0);

    it('parses pvforecast kW JSON and subtracts baseload', () => {
        const points = parseForecast(JSON.stringify([{ t: now + 900000, y: 3.5 }]), { now, unit: 'kW', baseload: 500 });
        expect(points).to.deep.equal([{ timestamp: now + 900000, power: 3500, surplus: 3000 }]);
    });

    it('detects watts automatically for large values', () => {
        expect(powerFactor(undefined, [1200, 1800])).to.equal(1);
    });

    it('requires sustained conservative power', () => {
        const points = [0, 15, 30, 45].map(minutes => ({ timestamp: now + minutes * 60000, surplus: 3000 }));
        const result = evaluateForecast(points, {
            now,
            requiredPower: 2000,
            safetyFactor: 0.8,
            minDurationMinutes: 30,
        });
        expect(result.available).to.equal(true);
        expect(result.durationMinutes).to.equal(60);
    });

    it('rejects short or insufficient forecasts', () => {
        const points = [0, 15].map(minutes => ({ timestamp: now + minutes * 60000, surplus: 1800 }));
        expect(evaluateForecast(points, { now, requiredPower: 2000, minDurationMinutes: 30 }).available).to.equal(
            false,
        );
    });

    it('enforces minimum state times', () => {
        expect(minimumStateTimeSatisfied(now - 4 * 60000, 5, now)).to.equal(false);
        expect(minimumStateTimeSatisfied(now - 5 * 60000, 5, now)).to.equal(true);
    });

    it('honors a zero maximum lead time', () => {
        const points = [15, 30, 45].map(minutes => ({ timestamp: now + minutes * 60000, surplus: 3000 }));
        expect(evaluateForecast(points, { now, requiredPower: 1000, maxStartMinutes: 0 }).available).to.equal(false);
    });
});
