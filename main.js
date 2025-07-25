// @ts-nocheck
"use strict";

const utils = require("@iobroker/adapter-core");

class ZeroFeedIn extends utils.Adapter {
    constructor(options) {
        super({
            ...options,
            name: "nulleinspeisung",
        });

        this.consumerList = [];
        this.feedInDatapoint = null;
        this.percentTimer = null;
        this.checkRunning = false;

        this.on("ready", this.onReady.bind(this));
        this.on("stateChange", this.onStateChange.bind(this));
        this.on("unload", this.onUnload.bind(this));
    }

    async onReady() {
        try {
            this.log.info(`=== Adapter started - PID: ${process.pid} ===`);

            if (!this.config.FeedInDataPoint) {
                this.log.error("No FeedInDataPoint configured!");
                return;
            }
            this.feedInDatapoint = this.config.FeedInDataPoint;

            this.consumerList = Array.isArray(this.config.consumer)
                ? this.config.consumer.filter(v => v && v.enabled && v.datapoint && v.performance > 0)
                : [];

            this.consumerList.forEach(v => v.processingLockSwitch = false);

            this.log.info(`Loaded consumers: ${this.consumerList.map(v => v.name).join(", ")}`);

            await this.checkAndCreateConsumerObjects();
            await this.createConsumerStates();
            await this.initializeConsumerStatus();

            await this.subscribeStatesAsync("*");
            await this.subscribeForeignStatesAsync(this.feedInDatapoint);

            await this.checkConsumers();

        } catch (error) {
            this.log.error(`Error in onReady: ${error.message}`);
        }
    }

    async checkAndCreateConsumerObjects() {
        for (const v of this.consumerList) {
            const obj = await this.getForeignObjectAsync(v.datapoint);
            if (!obj) {
                this.log.warn(`Consumer datapoint ${v.datapoint} does not exist!`);
            }
        }
    }

    async createConsumerStates() {
        for (let i = 0; i < this.consumerList.length; i++) {
            const v = this.consumerList[i];
            const channelId = `consumer.${i}_${v.name.replace(/\s+/g, "_")}`;

            await this.setObjectNotExistsAsync(channelId, {
                type: "channel",
                common: { name: v.name },
                native: {},
            });

            await this.setObjectNotExistsAsync(`${channelId}.controlMode`, {
                type: "state",
                common: {
                    name: `${v.name} Control Mode`,
                    type: "number",
                    role: "level.mode",
                    read: true,
                    write: true,
                    states: { 0: "Off", 1: "Manual On", 2: "Auto" },
                    def: 2,
                },
                native: {},
            });

            await this.setObjectNotExistsAsync(`${channelId}.switchOnTime`, {
                type: "state",
                common: {
                    name: `${v.name} Switch On Time (HH:MM)`,
                    type: "string",
                    role: "value.time",
                    read: true,
                    write: true,
                    def: "",
                },
                native: {},
            });

            await this.setObjectNotExistsAsync(`${channelId}.switchOffTime`, {
                type: "state",
                common: {
                    name: `${v.name} Switch Off Time (HH:MM)`,
                    type: "string",
                    role: "value.time",
                    read: true,
                    write: true,
                    def: "",
                },
                native: {},
            });

              await this.setObjectNotExistsAsync(`${channelId}.alwaysOffAtTime`, {
                type: "state",
                common: {
                    name: `${v.name} Ausschalten nur zur Ausschaltzeit`,
                    type: "boolean",
                    role: "switch",
                    read: true,
                    write: true,
                    def: v.alwaysOffAtTime || false,
                },
                native: {},
            });

            await this.setObjectNotExistsAsync(`${channelId}.performance`, {
                type: "state",
                common: {
                    name: `${v.name} Gesamtleistung (Watt)`,
                    type: "number",
                    role: "value.power.consumption",
                    read: true,
                    write: false,
                    def: v.performance || 0,
                    unit: "W"
                },
                native: {},
            });

            await this.setObjectNotExistsAsync(`${channelId}.switchOnPoint`, {
                type: "state",
                common: {
                    name: `${v.name} Einschaltpunkt (Watt)`,
                    type: "number",
                    role: "value.power",
                    read: true,
                    write: false,
                    def: v.switchOnPoint || 0,
                    unit: "W"
                },
                native: {},
            });

            await this.setObjectNotExistsAsync(`${channelId}.switchOffPoint`, {
                type: "state",
                common: {
                    name: `${v.name} Abschaltpunkt (Watt)`,
                    type: "number",
                    role: "value.power",
                    read: true,
                    write: false,
                    def: v.switchOffPoint || 0,
                    unit: "W"
                },
                native: {},
            });


            // Final Switch Times - always write config value to state
            const finalOnTime = v.switchOnTime || "";
            const finalOffTime = v.switchOffTime || "";

            await this.setStateAsync(`${this.namespace}.${channelId}.switchOnTime`, { val: finalOnTime, ack: true });
            await this.setStateAsync(`${this.namespace}.${channelId}.switchOffTime`, { val: finalOffTime, ack: true });
            await this.setStateAsync(`${this.namespace}.${channelId}.alwaysOffAtTime`, { val: v.alwaysOffAtTime || false, ack: true });
            await this.setStateAsync(`${this.namespace}.${channelId}.switchOffPoint`, { val: v.switchOffPoint || 0, ack: true });
            await this.setStateAsync(`${this.namespace}.${channelId}.switchOnPoint`, { val: v.switchOnPoint || 0, ack: true });
            await this.setStateAsync(`${this.namespace}.${channelId}.performance`, { val: v.performance || 0, ack: true });


            v.switchOnTime = finalOnTime;
            v.switchOffTime = finalOffTime;
        }
    }

    timeWithinWindow(switchOnTime, switchOffTime) {
        if (!switchOnTime && !switchOffTime) return true;

        const now = new Date();
        const nowMinutes = now.getHours() * 60 + now.getMinutes();

        let from = 0;
        let to = 24 * 60;

        if (switchOnTime && /^\d{2}:\d{2}$/.test(switchOnTime)) {
            const [h, m] = switchOnTime.split(":").map(Number);
            from = h * 60 + m;
        }

        if (switchOffTime && /^\d{2}:\d{2}$/.test(switchOffTime)) {
            const [h, m] = switchOffTime.split(":").map(Number);
            to = h * 60 + m;
        }

        const result = from < to
            ? nowMinutes >= from && nowMinutes < to
            : nowMinutes >= from || nowMinutes < to;

        return result;
    }

    async onStateChange(id, state) {
        if (state && !state.ack) {
            this.log.debug(`State changed: ${id} => ${state.val}`);

            const match = id.match(/consumer\.(\d+)_.*?\.controlMode/);
            if (match) {
                const index = parseInt(match[1]);
                const mode = state.val;
                const v = this.consumerList[index];

                if (mode === 0) {
                    await this.switchConsumerWithDelay(v, false);
                } else if (mode === 1) {
                    await this.switchConsumerWithDelay(v, true);
                }
            }

            const timeMatch = id.match(/consumer\.(\d+)_.*?\.(switchOnTime|switchOffTime)/);
            if (timeMatch) {
                const index = parseInt(timeMatch[1]);
                const type = timeMatch[2];
                this.consumerList[index][type] = state.val || "";
                await this.checkConsumers();
            }

            if (id === this.feedInDatapoint) {
                await this.checkConsumers();

                if (this.percentTimer) clearTimeout(this.percentTimer);
                this.percentTimer = setTimeout(async () => {
                    for (const v of this.consumerList) {
                        if (v.ruletype === "percent") {
                            await this.controlPercentConsumer(v);
                        }
                    }
                    this.percentTimer = null;
                }, (this.config.delaySecondsProzent || 60) * 1000);
            }
        }
    }

    async checkConsumers() {
        if (this.checkRunning) return;
        this.checkRunning = true;

        try {
            const feedInState = await this.getForeignStateAsync(this.feedInDatapoint);
            let feedIn = Number(feedInState?.val) || 0;

            if (this.config.feedinNegativ) feedIn = -feedIn;

            const baseload = this.config.baseload || 0;
            const gridUsage = feedIn <= baseload;

            for (const v of this.consumerList) {
                const mode = await this.getStateAsync(`${this.namespace}.consumer.${this.consumerList.indexOf(v)}_${v.name.replace(/\s+/g, "_")}.controlMode`);
                if (mode && mode.val === 2) {

                    const withinWindow = this.timeWithinWindow(v.switchOnTime, v.switchOffTime);

                    if (v.alwaysOffAtTime) {
                        // Variante A: nur zur OffTime ausschalten, niemals wegen Einspeisung abschalten
                        if (!withinWindow) {
                            await this.switchConsumerWithDelay(v, false);
                        } else {
                            await this.switchConsumerWithDelay(v, true);
                        }
                        continue;
                    }

                    // Standard Variante B
                    if (!withinWindow) {
                        await this.switchConsumerWithDelay(v, false);
                        continue;
                    }

                    if (gridUsage) {
                        await this.switchConsumerWithDelay(v, false);
                        continue;
                    }

                    if (v.ruletype === "binary") {
                        if (v.performance <= (feedIn - baseload)) {
                            await this.switchConsumerWithDelay(v, true);
                            feedIn -= v.performance;
                        } else {
                            await this.switchConsumerWithDelay(v, false);
                        }
                    }
                }
            }
        } catch (error) {
            this.log.error(`Error in checkConsumers: ${error.message}`);
        }

        this.checkRunning = false;
    }

    async controlPercentConsumer(v) {
        try {
            const withinWindow = this.timeWithinWindow(v.switchOnTime, v.switchOffTime);
            if (!withinWindow) {
                await this.setForeignStateAsync(v.datapoint, 0);
                return;
            }

            const feedInState = await this.getForeignStateAsync(this.feedInDatapoint);
            const feedInValue = Number(feedInState?.val) || 0;

            let surplus = this.config.feedinNegativ ? (feedInValue < 0 ? -feedInValue : 0) : (feedInValue > 0 ? feedInValue : 0);
            surplus -= this.config.baseload || 0;
            if (surplus < 0) surplus = 0;

            const maxPerformance = v.maxPerformance || v.performance || 1000;
            let newPercent = Math.round((surplus / maxPerformance) * 100);
            newPercent = Math.min(100, Math.max(newPercent, v.minPercentStart || 0));

            const state = await this.getForeignStateAsync(v.datapoint);
            const currentPercent = Number(state?.val) || 0;

            if (newPercent !== currentPercent) {
                await this.setForeignStateAsync(v.datapoint, newPercent);
            }
        } catch (error) {
            this.log.error(`Error in controlPercentConsumer: ${error.message}`);
        }
    }

    async switchConsumerWithDelay(v, turnOn) {
        if (v.processingLockSwitch) {
            return;
        }
        v.processingLockSwitch = true;

        if (v.timer) clearTimeout(v.timer);

        const delay = (v.ruletype === "percent" ? (this.config.delaySecondsProzent || 60) : (this.config.delaySeconds || 2)) * 1000;

        v.timer = setTimeout(async () => {
            try {
                const currentState = await this.getForeignStateAsync(v.datapoint);
                const isOn = this.isTrue(currentState?.val);

                if (turnOn && !isOn) {
                    await this.setForeignStateAsync(v.datapoint, true);
                } else if (!turnOn && isOn) {
                    await this.setForeignStateAsync(v.datapoint, false);
                }
            } catch (error) {
                this.log.error(`Error switching consumer: ${error.message}`);
            }
            v.processingLockSwitch = false;
        }, delay);
    }

    isTrue(val) {
        return val === true || val === "true" || val === 1;
    }

    async initializeConsumerStatus() {
        for (const v of this.consumerList) {
            if (v.ruletype === "binary") {
                const state = await this.getForeignStateAsync(v.datapoint);
                if (this.isTrue(state?.val)) {
                    this.log.info(`${v.name} is already on.`);
                }
            }
        }
    }

    async onUnload(callback) {
        try {
            if (this.percentTimer) clearTimeout(this.percentTimer);
            for (const v of this.consumerList) {
                if (v.timer) clearTimeout(v.timer);
            }
            callback();
        } catch (e) {
            callback();
        }
    }
}

if (require.main !== module) {
    module.exports = ZeroFeedIn;
} else {
    new ZeroFeedIn();
}
