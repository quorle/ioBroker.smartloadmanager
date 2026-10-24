'use strict';

/* global describe, it */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

// Run production methods against an in-memory ioBroker API.
function setup(type, config = {}, values = {}, overrides = {}) {
    const states = new Map(
        Object.entries({ 'meter.feed': 500, 'smartloadmanager.0.consumer.0_Load.controlMode': 2, ...values }).map(
            ([id, val]) => [id, { val, ack: true }],
        ),
    );
    const writes = [];
    class Adapter {
        constructor() {
            this.config = config;
            this.namespace = 'smartloadmanager.0';
            this.log = {
                debug() {},
                info() {},
                warn() {},
                error(message) {
                    throw new Error(message);
                },
            };
        }
        on() {}
        async getStateAsync(id) {
            return states.get(id);
        }
        async getForeignStateAsync(id) {
            return states.get(id);
        }
        async setStateAsync(id, value) {
            states.set(id, value);
        }
        async setForeignStateAsync(id, value) {
            const state = typeof value === 'object' ? value : { val: value, ack: false };
            writes.push({ id, ...state });
            states.set(id, state);
        }
        setTimeout(fn, ms) {
            return setTimeout(fn, ms);
        }
        setInterval(fn, ms) {
            return setInterval(fn, ms);
        }
    }
    const sandbox = {
        require: id =>
            id === '@iobroker/adapter-core' ? { Adapter } : require(id === './lib/forecast' ? './forecast' : id),
        module: { exports: {} },
        process,
        clearTimeout,
        clearInterval,
    };
    const factory = vm.runInNewContext(
        `${fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')}\nmodule.exports;`,
        sandbox,
    );
    const adapter = factory({});
    const consumer = {
        name: 'Load',
        enabled: true,
        ruletype: type,
        performance: 1000,
        datapoint: 'device.control',
        minimumOnMinutes: 0,
        minimumOffMinutes: 0,
        ...overrides,
    };
    adapter.feedInDatapoint = 'meter.feed';
    adapter.consumerList = [consumer];
    adapter.sendNotification = async () => {};
    adapter.setForecastState = async () => {};
    return { adapter, consumer: adapter.consumerList[0], states, writes };
}

describe('consumer control', () => {
    it('stops charging when a configured SOC sensor is unavailable', async () => {
        const { adapter, consumer, writes } = setup(
            'battery',
            {},
            { 'battery.power': 500, target: 80 },
            { batterySetpoint: 'battery.power', batterySOC: 'soc', batteryTargetSOC: 'target' },
        );
        await adapter.controlBattery(consumer, 1000);
        assert.equal(writes.at(-1).val, 0);
    });

    it('rechecks available surplus before a delayed automatic activation', async () => {
        const { adapter, consumer, states, writes } = setup('binary', {}, { 'meter.feed': 1500 });
        try {
            await adapter.switchConsumerWithDelay(consumer, true, 0.02);
            states.set('meter.feed', { val: -500, ack: true });
            await new Promise(resolve => setTimeout(resolve, 40));
            assert.equal(writes.length, 0);
        } finally {
            await adapter.onUnload(() => {});
        }
    });

    it('respects battery delay instead of regulating immediately', async () => {
        const { adapter, writes } = setup(
            'battery',
            { batteryDelaySeconds: 60 },
            {},
            { batterySetpoint: 'battery.power' },
        );
        try {
            await adapter.checkConsumers();
            assert.equal(writes.length, 0);
            assert.ok(adapter.batteryTimer);
        } finally {
            await adapter.onUnload(() => {});
        }
    });

    it('holds battery charging power when grid export reaches zero', async () => {
        const { adapter, consumer, writes } = setup(
            'battery',
            {},
            { 'battery.power': 500 },
            { batterySetpoint: 'battery.power' },
        );
        await adapter.controlBattery(consumer, 0);
        assert.equal(writes.length, 0);
    });

    it('does not activate a heater with an unavailable configured temperature sensor', async () => {
        const { adapter, consumer, writes } = setup(
            'heating',
            {},
            {},
            { temperatureDatapoint: 'temp', maxTemperature: 60 },
        );
        await adapter.switchConsumerWithDelay(consumer, true, 0);
        assert.equal(writes.length, 0);
    });

    it('cancels pending activation when a consumer is disabled', async () => {
        const { adapter, consumer, writes } = setup('binary');
        await adapter.switchConsumerWithDelay(consumer, true, 0.02);
        await adapter.onStateChange('smartloadmanager.0.consumer.0_Load.active', { val: false, ack: false });
        await new Promise(resolve => setTimeout(resolve, 40));
        await adapter.onUnload(() => {});
        assert.equal(writes.length, 0);
    });

    it('does not restart the off timer at zero surplus', async () => {
        const { adapter, consumer } = setup(
            'binary',
            {},
            { 'meter.feed': 0, 'device.control': true },
            { switchOffPoint: 0, switchOffDelay: 10 },
        );
        try {
            await adapter.checkConsumers();
            const original = consumer.timer;
            await adapter.checkConsumers();
            assert.equal(consumer.timer, original);
        } finally {
            await adapter.onUnload(() => {});
            clearInterval(consumer.timerTick);
        }
    });

    it('supports time windows across midnight', () => {
        const { adapter } = setup('binary');
        assert.equal(adapter.timeWithinWindow('00:00', '00:00'), true);
        const hour = new Date().getHours();
        if (hour < 6 || hour >= 22) {
            assert.equal(adapter.timeWithinWindow('22:00', '06:00'), true);
        } else {
            assert.equal(adapter.timeWithinWindow('22:00', '06:00'), false);
        }
    });

    it('does not restart a running percent timer on each meter update', async () => {
        const { adapter } = setup('percent');
        adapter.checkConsumers = async () => {};
        adapter.percentTimer = setTimeout(() => {}, 60000);
        const original = adapter.percentTimer;
        try {
            await adapter.onStateChange('meter.feed', { val: 500, ack: true });
            assert.equal(adapter.percentTimer, original);
        } finally {
            clearTimeout(original);
            await adapter.onUnload(() => {});
        }
    });

    it('acknowledges manual mode and applies percent values instead of booleans', async () => {
        const { adapter, states, writes } = setup('percent');
        await adapter.onStateChange('smartloadmanager.0.consumer.0_Load.controlMode', { val: 1, ack: false });
        assert.equal(writes.at(-1).val, 100);
        assert.equal(states.get('smartloadmanager.0.consumer.0_Load.controlMode')?.ack, true);
    });

    it('honors a binary switch-on threshold above its rated power', async () => {
        const { adapter, writes } = setup(
            'binary',
            {},
            { 'meter.feed': 1500, 'device.control': false },
            { switchOnPoint: 2000 },
        );
        await adapter.checkConsumers();
        assert.equal(writes.length, 0);
    });

    it('rejects stale forecast windows', () => {
        const { adapter, consumer } = setup('binary', { forecastMaxStartMinutes: 30 }, {}, { useForecast: true });
        adapter.forecastEnabled = true;
        adapter.forecast.points = [0, 15, 30].map(minutes => ({
            timestamp: Date.now() - 3600000 + minutes * 60000,
            surplus: 5000,
        }));
        assert.equal(adapter.isForecastAllowingSwitchOn(consumer, 1000), false);
    });

    it('writes one unacknowledged command to each binary datapoint', async () => {
        const { adapter, consumer, writes } = setup('binary', {}, {}, { numericDatapoint: 'device.numeric' });
        await adapter.doSwitchConsumer(consumer, true);
        assert.equal(writes.length, 2);
        assert.ok(writes.every(write => write.ack === false));
        assert.equal(writes[0].val, true);
        assert.equal(writes[1].val, 1);
    });

    it('turns percent consumers off below their minimum supported power', async () => {
        const { adapter, consumer, writes } = setup(
            'percent',
            {},
            { 'meter.feed': 0, 'device.control': 10 },
            { minPercentStart: 20 },
        );
        await adapter.controlPercentConsumer(consumer);
        assert.equal(writes.at(-1).val, 0);
    });

    it('does not regulate disabled percent consumers', async () => {
        const { adapter, consumer, writes } = setup('percent', {}, {}, { enabled: false });
        await adapter.controlPercentConsumer(consumer);
        assert.equal(writes.length, 0);
    });

    it('does not overwrite manual percent control', async () => {
        const { adapter, consumer, writes } = setup(
            'percent',
            {},
            { 'smartloadmanager.0.consumer.0_Load.controlMode': 1 },
        );
        await adapter.controlPercentConsumer(consumer);
        assert.equal(writes.length, 0);
    });

    it('uses current percent power plus signed grid surplus', async () => {
        const { adapter, consumer, writes } = setup('percent', {}, { 'meter.feed': -100, 'device.control': 50 });
        await adapter.controlPercentConsumer(consumer);
        assert.equal(writes.at(-1).val, 40);
    });

    it('writes battery power as an unacknowledged command', async () => {
        const { adapter, consumer, writes } = setup('battery', {}, {}, { batterySetpoint: 'battery.power' });
        await adapter.controlBattery(consumer, 500);
        assert.equal(writes.at(-1).val, 500);
        assert.equal(writes.at(-1).ack, false);
    });

    it('normalizes a negative feed-in meter exactly once', async () => {
        const { adapter, writes } = setup(
            'battery',
            { feedinNegativ: true },
            { 'meter.feed': -500 },
            { batterySetpoint: 'battery.power' },
        );
        await adapter.checkConsumers();
        await new Promise(resolve => setTimeout(resolve, 10));
        assert.equal(writes.at(-1)?.val, 500);
    });

    it('does not control disabled batteries', async () => {
        const { adapter, consumer, writes } = setup(
            'battery',
            {},
            {},
            { enabled: false, batterySetpoint: 'battery.power' },
        );
        await adapter.controlBattery(consumer, 500);
        assert.equal(writes.length, 0);
    });

    it('stops battery charging at target SOC', async () => {
        const { adapter, consumer, writes } = setup(
            'battery',
            {},
            { 'battery.power': 500, soc: 80, target: 80 },
            { batterySetpoint: 'battery.power', batterySOC: 'soc', batteryTargetSOC: 'target' },
        );
        await adapter.controlBattery(consumer, 1000);
        assert.equal(writes.at(-1).val, 0);
    });

    it('prevents heating activation at maximum temperature', async () => {
        const { adapter, consumer, writes } = setup(
            'heating',
            {},
            { temp: 70 },
            { temperatureDatapoint: 'temp', maxTemperature: 60 },
        );
        await adapter.switchConsumerWithDelay(consumer, true, 0);
        assert.equal(writes.length, 0);
    });

    it('switches binary loads on with surplus and off with import', async () => {
        const { adapter, states, writes } = setup('binary', {}, { 'meter.feed': 1500, 'device.control': false });
        await adapter.checkConsumers();
        assert.equal(writes.at(-1).val, true);
        states.set('meter.feed', { val: -500, ack: true });
        await adapter.checkConsumers();
        assert.equal(writes.at(-1).val, false);
    });
});
