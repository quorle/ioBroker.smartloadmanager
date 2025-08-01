'use strict';

const utils = require('@iobroker/adapter-core');

class ZeroFeedIn extends utils.Adapter {
    constructor(options) {
        super({
            ...options,
            name: 'smartloadmanager',
        });
        this.consumerList = [];
        this.feedInDatapoint = null;
        this.batteryControlModeDatapoint = null;
        this.percentTimer = null;
        this.batteryTimer = null;
        this.checkRunning = false;

        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    async onReady() {
        try {
            this.log.info(`=== Adapter started - PID: ${process.pid} ===`);

            if (!this.config.FeedInDataPoint) {
                this.log.error('No FeedInDataPoint configured!');
                return;
            }
            this.feedInDatapoint = this.config.FeedInDataPoint;

            this.batteryControlModeDatapoint = this.config.batteryControlModeDatapoint || null;
            this.log.info(`Configured batteryControlModeDatapoint: ${this.batteryControlModeDatapoint}`);

            this.consumerList = Array.isArray(this.config.consumer)
                ? this.config.consumer.filter(
                      v => v && v.enabled && (v.ruletype === 'battery' || (v.datapoint && v.performance > 0)),
                  )
                : [];

            this.consumerList.forEach(v => (v.processingLockSwitch = false));

            this.log.info(`Loaded consumers: ${this.consumerList.map(v => v.name).join(', ')}`);

            await this.checkAndCreateConsumerObjects();
            await this.createConsumerStates();
            await this.initializeConsumerStatus();
            // Testfunktion await this.testBatteryControlModeWrite();

            await this.subscribeStatesAsync('*');
            await this.subscribeForeignStatesAsync(this.feedInDatapoint);
            if (this.batteryControlModeDatapoint) {
                await this.subscribeForeignStatesAsync(this.batteryControlModeDatapoint);
            }

            await this.checkConsumers();
            this.offTimeTimer = setInterval(() => this.checkOffTimesForAlwaysOffAtTime(), 60 * 1000);
        } catch (error) {
            this.log.error(`Error in onReady: ${error.message}`);
        }
    }

    async checkAndCreateConsumerObjects() {
        for (const v of this.consumerList) {
            if (v.datapoint) {
                const obj = await this.getForeignObjectAsync(v.datapoint);
                if (!obj) {
                    this.log.warn(`Consumer datapoint ${v.datapoint} does not exist!`);
                }
            }
        }
    }

    async createConsumerStates() {
        for (let i = 0; i < this.consumerList.length; i++) {
            const v = this.consumerList[i];
            const channelId = `consumer.${i}_${v.name.replace(/\s+/g, '_')}`;

            await this.setObjectNotExistsAsync(channelId, {
                type: 'channel',
                common: { name: v.name },
                native: {},
            });

            await this.setObjectNotExistsAsync(`${channelId}.controlMode`, {
                type: 'state',
                common: {
                    name: `${v.name} Control Mode`,
                    type: 'number',
                    role: 'level.mode',
                    read: true,
                    write: true,
                    states: { 0: 'Off', 1: 'Manual On', 2: 'Auto' },
                    def: 2,
                },
                native: {},
            });

            await this.setObjectNotExistsAsync(`${channelId}.switchOnTime`, {
                type: 'state',
                common: {
                    name: `${v.name} Switch On Time (HH:MM)`,
                    type: 'string',
                    role: 'value.time',
                    read: true,
                    write: true,
                    def: '',
                },
                native: {},
            });

            await this.setObjectNotExistsAsync(`${channelId}.switchOffTime`, {
                type: 'state',
                common: {
                    name: `${v.name} Switch Off Time (HH:MM)`,
                    type: 'string',
                    role: 'value.time',
                    read: true,
                    write: true,
                    def: '',
                },
                native: {},
            });

            await this.setObjectNotExistsAsync(`${channelId}.alwaysOffAtTime`, {
                type: 'state',
                common: {
                    name: `${v.name} Ausschalten nur zur Ausschaltzeit`,
                    type: 'boolean',
                    role: 'switch',
                    read: true,
                    write: true,
                    def: v.alwaysOffAtTime || false,
                },
                native: {},
            });

            await this.setObjectNotExistsAsync(`${channelId}.performance`, {
                type: 'state',
                common: {
                    name: `${v.name} Gesamtleistung (Watt)`,
                    type: 'number',
                    role: 'value.power.consumption',
                    read: true,
                    write: false,
                    def: v.performance || 0,
                    unit: 'W',
                },
                native: {},
            });

            await this.setObjectNotExistsAsync(`${channelId}.switchOnPoint`, {
                type: 'state',
                common: {
                    name: `${v.name} Einschaltpunkt (Watt)`,
                    type: 'number',
                    role: 'value.power',
                    read: true,
                    write: false,
                    def: v.switchOnPoint || 0,
                    unit: 'W',
                },
                native: {},
            });

            await this.setObjectNotExistsAsync(`${channelId}.switchOffPoint`, {
                type: 'state',
                common: {
                    name: `${v.name} Abschaltpunkt (Watt)`,
                    type: 'number',
                    role: 'value.power',
                    read: true,
                    write: false,
                    def: v.switchOffPoint || 0,
                    unit: 'W',
                },
                native: {},
            });

            if (v.ruletype === 'battery') {
                await this.setObjectNotExistsAsync(`${channelId}.batterySetpoint`, {
                    type: 'state',
                    common: {
                        name: `${v.name} Batterie Ladeleistungs-Datenpunkt`,
                        type: 'string',
                        role: 'value',
                        read: true,
                        write: true,
                        def: v.batterySetpoint || '',
                    },
                    native: {},
                });
            }

            const finalOnTime = v.switchOnTime || '';
            const finalOffTime = v.switchOffTime || '';

            await this.setStateAsync(`${this.namespace}.${channelId}.switchOnTime`, {
                val: finalOnTime,
                ack: true,
            });
            await this.setStateAsync(`${this.namespace}.${channelId}.switchOffTime`, {
                val: finalOffTime,
                ack: true,
            });
            await this.setStateAsync(`${this.namespace}.${channelId}.alwaysOffAtTime`, {
                val: v.alwaysOffAtTime || false,
                ack: true,
            });
            await this.setStateAsync(`${this.namespace}.${channelId}.switchOffPoint`, {
                val: v.switchOffPoint || 0,
                ack: true,
            });
            await this.setStateAsync(`${this.namespace}.${channelId}.switchOnPoint`, {
                val: v.switchOnPoint || 0,
                ack: true,
            });
            await this.setStateAsync(`${this.namespace}.${channelId}.performance`, {
                val: v.performance || 0,
                ack: true,
            });

            v.switchOnTime = finalOnTime;
            v.switchOffTime = finalOffTime;
        }
    }

    timeWithinWindow(switchOnTime, switchOffTime) {
        if (!switchOnTime && !switchOffTime) {
            return true;
        }

        const now = new Date();
        const nowMinutes = now.getHours() * 60 + now.getMinutes();

        let from = 0;
        let to = 24 * 60;

        if (switchOnTime && /^\d{2}:\d{2}$/.test(switchOnTime)) {
            const [h, m] = switchOnTime.split(':').map(Number);
            from = h * 60 + m;
        }

        if (switchOffTime && /^\d{2}:\d{2}$/.test(switchOffTime)) {
            const [h, m] = switchOffTime.split(':').map(Number);
            to = h * 60 + m;
        }

        return from < to ? nowMinutes >= from && nowMinutes < to : nowMinutes >= from || nowMinutes < to;
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
                this.consumerList[index][type] = state.val || '';
                await this.checkConsumers();
            }

            if (id === this.feedInDatapoint) {
                await this.checkConsumers();

                if (this.percentTimer) {
                    clearTimeout(this.percentTimer);
                }
                this.percentTimer = setTimeout(
                    async () => {
                        for (const v of this.consumerList) {
                            if (v.ruletype === 'percent') {
                                await this.controlPercentConsumer(v);
                            }
                        }
                        this.percentTimer = null;
                    },
                    (this.config.delaySecondsProzent || 60) * 1000,
                );

                if (this.batteryTimer) {
                    clearTimeout(this.batteryTimer);
                }
                this.batteryTimer = setTimeout(
                    async () => {
                        if (!this.feedInDatapoint) {
                            this.log.warn('❗ Kein FeedIn-Datenpunkt gesetzt – onStateChange() wird übersprungen.');
                            return;
                        }
                        const feedInState = await this.getForeignStateAsync(this.feedInDatapoint);
                        let feedIn = Number(feedInState?.val) || 0;
                        if (this.config.feedinNegativ) {
                            feedIn = -feedIn;
                        }

                        for (const v of this.consumerList.filter(v => v.ruletype === 'battery')) {
                            await this.controlBattery(v, feedIn);
                        }
                        this.batteryTimer = null;
                    },
                    (this.config.batteryDelaySeconds || 60) * 1000,
                );
            }
        }
    }

    async checkConsumers() {
        if (this.checkRunning) {
            return;
        }
        this.checkRunning = true;

        try {
            if (!this.feedInDatapoint) {
                this.log.warn('❗ Kein FeedIn-Datenpunkt gesetzt – checkConsumers() wird übersprungen.');
                this.checkRunning = false;
                return;
            }
            const feedInState = await this.getForeignStateAsync(this.feedInDatapoint);

            let feedIn = Number(feedInState?.val) || 0;

            if (this.config.feedinNegativ) {
                feedIn = -feedIn;
            }

            const baseload = this.config.baseload || 0;
            const gridUsage = feedIn <= baseload;

            // Einschalten: aufsteigend nach Priorität (binary)
            const sortedOn = [...this.consumerList]
                .filter(v => v.ruletype === 'binary')
                .sort((a, b) => (a.priority || 1) - (b.priority || 1));

            for (const v of sortedOn) {
                const idx = this.consumerList.indexOf(v);
                const id = `${this.namespace}.consumer.${idx}_${v.name.replace(/\s+/g, '_')}`;
                const mode = await this.getStateAsync(`${id}.controlMode`);
                if (!mode || mode.val !== 2) {
                    continue;
                }

                const withinWindow = this.timeWithinWindow(v.switchOnTime, v.switchOffTime);

                // Einschalten ist nur erlaubt, wenn im Zeitfenster
                if (!withinWindow) {
                    this.log.debug(`⏳ ${v.name} wird nicht eingeschaltet – außerhalb Zeitfenster`);
                    await this.switchConsumerWithDelay(v, false);
                    continue;
                }

                // Wenn Netzbezug, nicht einschalten – außer alwaysOffAtTime ist aktiv
                if (gridUsage && !v.alwaysOffAtTime) {
                    this.log.debug(`🚫 ${v.name} wird nicht eingeschaltet – Netzbezug aktiv`);
                    await this.switchConsumerWithDelay(v, false);
                    continue;
                }

                // Prüfen, ob genug Überschuss da ist
                if (v.performance <= feedIn - baseload) {
                    this.log.debug(
                        `✅ ${v.name} wird eingeschaltet – Überschuss reicht (${feedIn - baseload}W ≥ ${v.performance}W)`,
                    );
                    await this.switchConsumerWithDelay(v, true);
                    feedIn -= v.performance;
                } else {
                    // Wenn nicht genug Überschuss – nur abschalten, wenn alwaysOffAtTime nicht aktiv ist
                    if (!v.alwaysOffAtTime) {
                        this.log.debug(`⚠️ ${v.name} wird ausgeschaltet – nicht genug Überschuss`);
                        await this.switchConsumerWithDelay(v, false);
                    } else {
                        this.log.debug(`ℹ️ ${v.name} bleibt an – nicht genug Überschuss, aber alwaysOffAtTime aktiv`);
                    }
                }
            }

            // Abschalten: absteigend nach Priorität (binary)
            const sortedOff = [...this.consumerList]
                .filter(v => v.ruletype === 'binary')
                .sort((a, b) => (b.priority || 1) - (a.priority || 1));

            for (const v of sortedOff) {
                const mode = await this.getStateAsync(
                    `${this.namespace}.consumer.${this.consumerList.indexOf(v)}_${v.name.replace(/\s+/g, '_')}.controlMode`,
                );
                if (mode && mode.val === 2) {
                    if (v.alwaysOffAtTime) {
                        // Ausschalten nur über separate Prüfung zur switchOffTime
                        continue;
                    }

                    const withinWindow = this.timeWithinWindow(v.switchOnTime, v.switchOffTime);

                    if (!withinWindow || gridUsage) {
                        await this.switchConsumerWithDelay(v, false);
                    }
                }
            }

            // Batterie Verbraucher steuern
            for (const v of this.consumerList.filter(c => c.ruletype === 'battery')) {
                await this.controlBattery(v, feedIn);
            }
        } catch (error) {
            this.log.error(`Error in checkConsumers: ${error.message}`);
        }

        this.checkRunning = false;
    }

    async checkOffTimesForAlwaysOffAtTime() {
        const now = new Date();
        const nowHM = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;

        for (const v of this.consumerList.filter(c => c.ruletype === 'binary' && c.alwaysOffAtTime)) {
            if (v.switchOffTime === nowHM) {
                const mode = await this.getStateAsync(
                    `${this.namespace}.consumer.${this.consumerList.indexOf(v)}_${v.name.replace(/\s+/g, '_')}.controlMode`,
                );
                if (mode?.val === 2) {
                    this.log.info(`Ausschaltzeit erreicht (alwaysOffAtTime) für ${v.name}`);
                    await this.switchConsumerWithDelay(v, false);
                }
            }
        }
    }

    async controlPercentConsumer(v) {
        try {
            if (!this.feedInDatapoint) {
                this.log.warn(`[${v.name}] ❗ Kein FeedIn-Datenpunkt gesetzt – Prozentregelung wird übersprungen.`);
                return;
            }
            if (!v.datapoint) {
                this.log.warn(
                    `[${v.name}] ❗ Kein Ziel-Datenpunkt für Prozentregelung konfiguriert – wird übersprungen.`,
                );
                return;
            }

            const withinWindow = this.timeWithinWindow(v.switchOnTime || '', v.switchOffTime || '');
            if (!withinWindow) {
                this.log.debug(`[${v.name}] Außerhalb des Zeitfensters – wird auf 0 % gesetzt.`);
                await this.setForeignStateAsync(v.datapoint, 0);
                return;
            }

            const feedInState = await this.getForeignStateAsync(this.feedInDatapoint);
            const feedInValue = Number(feedInState?.val) || 0;

            let surplus = this.config.feedinNegativ
                ? feedInValue < 0
                    ? -feedInValue
                    : 0
                : feedInValue > 0
                  ? feedInValue
                  : 0;

            surplus -= this.config.baseload || 0;
            if (surplus < 0) {
                surplus = 0;
            }

            const maxPerformance = v.maxPerformance || v.performance || 1000;
            let newPercent = Math.round((surplus / maxPerformance) * 100);
            newPercent = Math.min(100, Math.max(newPercent, v.minPercentStart || 0));

            const state = await this.getForeignStateAsync(v.datapoint);
            const currentPercent = Number(state?.val) || 0;

            if (newPercent !== currentPercent) {
                this.log.debug(`[${v.name}] Prozent wird geändert: ${currentPercent} % → ${newPercent} %`);
                await this.setForeignStateAsync(v.datapoint, newPercent);
            }
        } catch (error) {
            this.log.error(`❌ [${v.name}] Fehler in controlPercentConsumer: ${error.message}`);
        }
    }

    async controlBattery(v, feedIn) {
        try {
            this.log.debug(`[Battery] Checking ${v.name}`);

            const withinWindow = this.timeWithinWindow(v.switchOnTime, v.switchOffTime);
            if (!withinWindow) {
                this.log.debug(`[Battery] Outside time window -> Set 0`);
                if (v.batterySetpoint) {
                    await this.setForeignStateAsync(v.batterySetpoint, {
                        val: 0,
                        ack: true,
                    });
                }
                if (v.batteryControlModeDatapoint) {
                    await this.setForeignStateAsync(v.batteryControlModeDatapoint, {
                        val: 0,
                        ack: true,
                    });
                }
                return;
            }

            if (!v.batterySetpoint) {
                this.log.warn(`[Battery] ${v.name} has no batterySetpoint configured.`);
                if (v.batteryControlModeDatapoint) {
                    await this.setForeignStateAsync(v.batteryControlModeDatapoint, {
                        val: 0,
                        ack: true,
                    });
                }
                return;
            }

            let soc = null;
            let targetSoc = null;
            if (v.batterySOC && v.batteryTargetSOC) {
                const socState = await this.getForeignStateAsync(v.batterySOC);
                const targetSocState = await this.getForeignStateAsync(v.batteryTargetSOC);
                soc = Number(socState?.val);
                targetSoc = Number(targetSocState?.val);
                if (isNaN(soc) || isNaN(targetSoc)) {
                    this.log.warn(`[Battery] ${v.name}: invalid SOC or targetSOC.`);
                    soc = null;
                    targetSoc = null;
                }
            }

            const feedInAdjusted = this.config.feedinNegativ ? -feedIn : feedIn;
            const surplus = feedInAdjusted - (this.config.baseload || 0);

            let powerToSet = 0;
            let modeToSet = 0; // Default: Aus

            if (surplus <= 0) {
                powerToSet = 0;
                modeToSet = 0; // Aus
            } else if (soc !== null && targetSoc !== null && soc >= targetSoc) {
                powerToSet = 0;
                modeToSet = 1; // Manuell (geladen)
            } else {
                powerToSet = Math.min(surplus, v.performance || 1000);
                modeToSet = 2; // Automatik
            }

            await this.setForeignStateAsync(v.batterySetpoint, {
                val: powerToSet,
                ack: true,
            });

            if (v.batteryControlModeDatapoint) {
                try {
                    await this.setForeignStateAsync(v.batteryControlModeDatapoint, {
                        val: modeToSet,
                        ack: true,
                    });
                    this.log.debug(`[Battery] Set ${v.name} batteryControlModeDatapoint to mode ${modeToSet}`);
                } catch (e) {
                    this.log.error(`[Battery] Failed to set batteryControlModeDatapoint for ${v.name}: ${e.message}`);
                }
            }

            this.log.debug(`[Battery] Set power ${powerToSet}W and mode ${modeToSet}`);
        } catch (error) {
            this.log.error(`[Battery] Error for ${v.name}: ${error.message}`);
        }
    }

    async switchConsumerWithDelay(v, turnOn) {
        if (v.processingLockSwitch) {
            return;
        }
        v.processingLockSwitch = true;

        try {
            if (!v.datapoint) {
                this.log.warn(`No datapoint for consumer ${v.name}`);
                return;
            }

            const currentState = await this.getForeignStateAsync(v.datapoint);
            const isOn = currentState?.val === true || currentState?.val === 1;

            if (turnOn && !isOn) {
                this.log.info(`Switching ON consumer ${v.name}`);
                await this.setForeignStateAsync(v.datapoint, true);
            } else if (!turnOn && isOn) {
                this.log.info(`Switching OFF consumer ${v.name}`);
                await this.setForeignStateAsync(v.datapoint, false);
            }
        } catch (error) {
            this.log.error(`Error switching consumer ${v.name}: ${error.message}`);
        } finally {
            v.processingLockSwitch = false;
        }
    }

    async initializeConsumerStatus() {
        // Initiale Status-Updates
        for (const v of this.consumerList) {
            const channelId = `consumer.${this.consumerList.indexOf(v)}_${v.name.replace(/\s+/g, '_')}`;
            const modeState = await this.getStateAsync(`${this.namespace}.${channelId}.controlMode`);
            if (!modeState) {
                await this.setStateAsync(`${this.namespace}.${channelId}.controlMode`, {
                    val: 2,
                    ack: true,
                });
            }
        }
    }

    /*
// Testfunktion
	async testBatteryControlModeWrite() {
		this.log.info(`Teste Schreibzugriff auf batteryControlModeDatapoint: ${this.batteryControlModeDatapoint}`);

		if (!this.batteryControlModeDatapoint) {
			this.log.error("batteryControlModeDatapoint nicht konfiguriert");
			return;
		}

		const obj = await this.getForeignObjectAsync(this.batteryControlModeDatapoint);
		if (!obj) {
			this.log.error(`batteryControlModeDatapoint ${this.batteryControlModeDatapoint} existiert nicht!`);
			return;
		}

		if (!obj.common?.write) {
			this.log.warn(`batteryControlModeDatapoint ist nicht schreibbar!`);
			return;
		}

		const valBefore = await this.getForeignStateAsync(this.batteryControlModeDatapoint);
		this.log.info(`Vor Schreibversuch aktueller Wert: ${valBefore?.val}`);

		try {
			await this.setForeignStateAsync(this.batteryControlModeDatapoint, { val: 1, ack: true });
			this.log.info(`Schreibversuch durchgeführt`);

			const valAfter = await this.getForeignStateAsync(this.batteryControlModeDatapoint);
			this.log.info(`Nach Schreibversuch aktueller Wert: ${valAfter?.val}`);
		} catch (e) {
			this.log.error(`Fehler beim Schreiben: ${e.message}`);
		}
	}

*/

    async onUnload(callback) {
        try {
            if (this.percentTimer) {
                clearTimeout(this.percentTimer);
            }
            if (this.batteryTimer) {
                clearTimeout(this.batteryTimer);
            }
            callback();
        } catch {
            callback();
        }
    }
}

if (require.main !== module) {
    module.exports = options => new ZeroFeedIn(options);
} else {
    new ZeroFeedIn();
}
