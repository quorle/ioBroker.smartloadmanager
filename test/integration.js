const path = require("path");
const { tests } = require("@iobroker/testing");
const assert = require('node:assert/strict');

// Run integration tests - See https://github.com/ioBroker/testing for a detailed explanation and further options
tests.integration(path.join(__dirname, ".."), {
    ...(process.env.TEST_CONTROLLER_VERSION ? { controllerVersion: process.env.TEST_CONTROLLER_VERSION } : {}),
    defineAdditionalTests({ suite }) {
        suite('Configured binary consumer', getHarness => {
            it('creates controls and sends switching commands without startup errors', async function () {
                this.timeout(30000);
                const harness = getHarness();
                for (const [id, type] of [['test.feed', 'number'], ['test.switch', 'boolean']]) {
                    await harness.objects.setObjectAsync(id, { type: 'state', common: { name: id, type, role: 'state', read: true, write: true }, native: {} });
                }
                await harness.states.setStateAsync('test.feed', { val: 2000, ack: true });
                await harness.states.setStateAsync('test.switch', { val: false, ack: true });
                await harness.changeAdapterConfig('smartloadmanager', { native: {
                    FeedInDataPoint: 'test.feed', baseload: 0,
                    consumer: [{ name: 'Test', enabled: true, ruletype: 'binary', datapoint: 'test.switch',
                        performance: 1000, switchOnPoint: 1000, switchOffPoint: 0,
                        minimumOnMinutes: 0, minimumOffMinutes: 0, switchOnDelay: 0, switchOffDelay: 0 }],
                } });
                await harness.startAdapterAndWait();
                const deadline = Date.now() + 10000;
                while (Date.now() < deadline) {
                    const switched = await harness.states.getStateAsync('test.switch');
                    if (switched?.val === true) {
                        break;
                    }
                    await new Promise(resolve => setTimeout(resolve, 100));
                }
                assert.equal(harness.getLogs('error').length, 0);
                assert.ok(await harness.objects.getObjectAsync('smartloadmanager.0.consumer.0_Test.controlMode'));
                const state = await harness.states.getStateAsync('test.switch');
                assert.equal(state.val, true);
                assert.equal(state.ack, false);
            });
        });
    },
});
