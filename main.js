'use strict';

const utils = require('@iobroker/adapter-core');

class ZeroFeedIn extends utils.Adapter {
    constructor(options) {
        super({
            ...options,
            name: 'smartloadmanager',
        });
        // Timeout-Limits definieren
        this.MAX_TIMEOUT = 86400000; // 24h in ms
        this.DEFAULT_TIMEOUT = 60000; // 60 Sekunden Fallback
        this.consumerList = [];
        this.feedInDatapoint = null;
        this.batteryControlModeDatapoint = null;
        this.percentTimer = null;
        this.batteryTimer = null;
        this.checkRunning = false;

        // 🔮 Forecast (PV forecast integration)
        this.forecastEnabled = false;
        this.forecastJsonDatapoint = null;
        this.forecast = {
            power: 0,
            surplus: 0,
            minutes: 0,
            lastUpdate: 0,
        };

        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    name2id(pName) {
        return (pName || '')
            .replace(this.FORBIDDEN_CHARS, '_') // ioBroker verbotene Zeichen
            .replace(/\s+/g, '_') // Leerzeichen → _
            .replace(/\./g, '_') // Punkte → _
            .replace(/[^a-zA-Z0-9\-_]/g, '_') // nur erlaubte Zeichen
            .replace(/_+/g, '_') // mehrere Unterstriche zusammenfassen
            .replace(/^_+|_+$/g, ''); // führende/trailing _ weg
    }

    // Wrapper für sichere Timer
    safeSetTimeout(fn, ms, ...args) {
        const safeMs = Math.min(Math.max(ms, 0), this.MAX_TIMEOUT);
        if (ms > this.MAX_TIMEOUT) {
            this.log.warn(`Timeout of ${ms} ms has been limited to ${this.MAX_TIMEOUT} ms!`);
        }
        return this.setTimeout(fn, safeMs, ...args);
    }

    safeSetInterval(fn, ms, ...args) {
        const safeMs = Math.min(Math.max(ms, 0), this.MAX_TIMEOUT);
        if (ms > this.MAX_TIMEOUT) {
            this.log.warn(`Interval of ${ms} ms has been limited to ${this.MAX_TIMEOUT} ms!`);
        }
        return this.setInterval(fn, safeMs, ...args);
    }

    // =====================================================================
    // ============================ onReady ================================
    // =====================================================================
    async onReady() {
        try {
            this.log.info(`Adapter started, PID: ${process.pid}`);

            if (!this.config.FeedInDataPoint) {
                this.log.error('No FeedInDataPoint configured!');
                // additionally send alert
                await this.sendNotification('smartloadmanager', 'alarm', 'No FeedInDataPoint configured!');
                return;
            }
            this.feedInDatapoint = this.config.FeedInDataPoint;

            this.batteryControlModeDatapoint = this.config.batteryControlModeDatapoint || null;
            this.log.info(`Configured batteryControlModeDatapoint: ${this.batteryControlModeDatapoint}`);

            // 🔮 Forecast config (PV forecast integration)
            this.forecastEnabled = !!this.config.enableForecast;
            this.forecastJsonDatapoint = this.config.forecastJsonDatapoint || null;

            this.consumerList = Array.isArray(this.config.consumer)
                ? this.config.consumer.filter(
                      v =>
                          v && (v.ruletype === 'battery' || ((v.datapoint || v.numericDatapoint) && v.performance > 0)),
                  )
                : [];

            this.consumerList.forEach(v => (v.processingLockSwitch = false));

            for (let i = 0; i < this.consumerList.length; i++) {
                const v = this.consumerList[i];
                const safeName = this.name2id(v.name);
                const id = `${this.namespace}.consumer.${i}_${safeName}.active`;
                const state = await this.getStateAsync(id);
                if (state && state.val !== null) {
                    v.enabled = state.val;
                    this.log.debug(`"${v.name}": Active status taken from object tree (${state.val})`);
                }
            }

            this.log.info(`Loaded consumers: ${this.consumerList.map(v => v.name).join(', ')}`);

            await this.checkAndCreateConsumerObjects();
            await this.createConsumerStates();

            // 🔮 Forecast states (adapter-internal)
            if (this.forecastEnabled) {
                await this.createForecastStates();
            }

            await this.initializeConsumerStatus();
            await this.subscribeStatesAsync('*');
            await this.subscribeForeignStatesAsync(this.feedInDatapoint);
            if (this.batteryControlModeDatapoint) {
                await this.subscribeForeignStatesAsync(this.batteryControlModeDatapoint);
            }

            // 🔮 Forecast subscribe + initial parse
            if (this.forecastEnabled && this.forecastJsonDatapoint) {
                await this.subscribeForeignStatesAsync(this.forecastJsonDatapoint);
                await this.processPvforecastJson();
            }

            await this.checkConsumers();
        } catch (error) {
            this.log.error(`Error in onReady: ${error.message}`);
            // additionally send alert
            await this.sendNotification('smartloadmanager', 'alert', `Error in onReady: ${error.message}`);
        }
    }

    // =====================================================================
    // ===================== Consumer object checks ========================
    // =====================================================================
    async checkAndCreateConsumerObjects() {
        for (const v of this.consumerList) {
            if (v.datapoint) {
                const obj = await this.getForeignObjectAsync(v.datapoint);
                if (!obj) {
                    this.log.warn(`Consumer datapoint ${v.datapoint} does not exist!`);
                }
            }
            if (v.numericDatapoint) {
                const objNum = await this.getForeignObjectAsync(v.numericDatapoint);
                if (!objNum) {
                    this.log.warn(`Consumer numericDatapoint ${v.numericDatapoint} does not exist!`);
                }
            }
        }
    }

    // =====================================================================
    // ========================= createConsumerStates ======================
    // =====================================================================
    async createConsumerStates() {
        // Übergeordnetes Device erstellen - löst "intermediate objects missing" Problem
        await this.setObjectNotExistsAsync('consumer', {
            type: 'device',
            common: {
                name: 'Consumer Management',
            },
            native: {},
        });

        for (let i = 0; i < this.consumerList.length; i++) {
            const v = this.consumerList[i];
            const safeName = this.name2id(v.name);
            const channelId = `consumer.${i}_${safeName}`;

            await this.setObjectNotExistsAsync(channelId, {
                type: 'channel',
                common: { name: v.name }, // Channel selbst darf Klartext-Nutzername behalten
                native: {},
            });

            await this.setObjectNotExistsAsync(`${channelId}.controlMode`, {
                type: 'state',
                common: {
                    name: 'controlMode',
                    type: 'number',
                    role: 'level.mode',
                    read: true,
                    write: true,
                    states: { 0: 'Off', 1: 'Manual On', 2: 'Auto' },
                    def: 2,
                },
                native: {},
            });

            // KORRIGIERT: switchOnTime und switchOffTime als text statt value.time
            await this.setObjectNotExistsAsync(`${channelId}.switchOnTime`, {
                type: 'state',
                common: {
                    name: 'switchOnTime',
                    type: 'string',
                    role: 'text', // GEÄNDERT von 'value.time' zu 'text'
                    read: true,
                    write: true,
                    def: '',
                },
                native: {},
            });

            await this.setObjectNotExistsAsync(`${channelId}.switchOffTime`, {
                type: 'state',
                common: {
                    name: 'switchOffTime',
                    type: 'string',
                    role: 'text', // GEÄNDERT von 'value.time' zu 'text'
                    read: true,
                    write: true,
                    def: '',
                },
                native: {},
            });

            await this.setObjectNotExistsAsync(`${channelId}.alwaysOffAtTime`, {
                type: 'state',
                common: {
                    name: 'alwaysOffAtTime',
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
                    name: 'performance',
                    type: 'number',
                    role: 'value.power', // GEÄNDERT von 'value.power.consumption' zu 'value.power'
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
                    name: 'switchOnPoint',
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
                    name: 'switchOffPoint',
                    type: 'number',
                    role: 'value.power',
                    read: true,
                    write: false,
                    def: v.switchOffPoint || 0,
                    unit: 'W',
                },
                native: {},
            });

            // === NEUER STATE: Aktiv-Status ============================
            await this.setObjectNotExistsAsync(`${channelId}.active`, {
                type: 'state',
                common: {
                    name: `${v.name} aktiv`,
                    type: 'boolean',
                    role: 'switch',
                    read: true,
                    write: true,
                    def: v.enabled || false,
                },
                native: {},
            });

            // 🔮 Forecast options per consumer
            await this.setObjectNotExistsAsync(`${channelId}.useForecast`, {
                type: 'state',
                common: {
                    name: 'Use forecast',
                    type: 'boolean',
                    role: 'switch',
                    read: true,
                    write: true,
                    def: v.useForecast || false,
                },
                native: {},
            });

            await this.setObjectNotExistsAsync(`${channelId}.forecastMinMinutes`, {
                type: 'state',
                common: {
                    name: 'Forecast min minutes',
                    type: 'number',
                    role: 'value.interval',
                    read: true,
                    write: true,
                    def: v.forecastMinMinutes || 0,
                    unit: 'min',
                },
                native: {},
            });

            await this.setObjectNotExistsAsync(`${channelId}.forecastStatus`, {
                type: 'state',
                common: {
                    name: 'Forecast status',
                    type: 'string',
                    role: 'text',
                    read: true,
                    write: false,
                    def: '',
                },
                native: {},
            });

            if (v.ruletype === 'battery') {
                await this.setObjectNotExistsAsync(`${channelId}.batterySetpoint`, {
                    type: 'state',
                    common: {
                        name: 'batterySetpoint',
                        type: 'string',
                        role: 'text', // GEÄNDERT von 'value' zu 'text' (spezifischer)
                        read: true,
                        write: true,
                        def: v.batterySetpoint || '',
                    },
                    native: {},
                });
            }

            // KORRIGIERT: value.duration ist korrekt für Timer
            await this.setObjectNotExistsAsync(`${channelId}.onTimerRemaining`, {
                type: 'state',
                common: {
                    name: 'onTimerRemaining',
                    type: 'number',
                    role: 'value.interval', // GEÄNDERT von 'value.duration' zu 'value.interval'
                    read: true,
                    write: false,
                    def: 0,
                    unit: 's',
                },
                native: {},
            });

            await this.setObjectNotExistsAsync(`${channelId}.offTimerRemaining`, {
                type: 'state',
                common: {
                    name: 'offTimerRemaining',
                    type: 'number',
                    role: 'value.interval', // GEÄNDERT von 'value.duration' zu 'value.interval'
                    read: true,
                    write: false,
                    def: 0,
                    unit: 's',
                },
                native: {},
            });

            // States initialisieren
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

            await this.setStateAsync(`${this.namespace}.${channelId}.onTimerRemaining`, { val: 0, ack: true });
            await this.setStateAsync(`${this.namespace}.${channelId}.offTimerRemaining`, { val: 0, ack: true });

            await this.setStateAsync(`${channelId}.active`, { val: v.enabled || false, ack: true });

            // 🔮 Forecast states init per consumer
            await this.setStateAsync(`${channelId}.useForecast`, { val: v.useForecast || false, ack: true });
            await this.setStateAsync(`${channelId}.forecastMinMinutes`, {
                val: v.forecastMinMinutes || 0,
                ack: true,
            });
            await this.setStateAsync(`${channelId}.forecastStatus`, { val: '', ack: true });

            v.switchOnTime = finalOnTime;
            v.switchOffTime = finalOffTime;
        }
    }

    // =====================================================================
    // ========================= Forecast states ===========================
    // =====================================================================
    async createForecastStates() {
        await this.setObjectNotExistsAsync('forecast', {
            type: 'channel',
            common: { name: 'Forecast' },
            native: {},
        });

        await this.setObjectNotExistsAsync('forecast.power', {
            type: 'state',
            common: {
                name: 'Forecast Power',
                type: 'number',
                role: 'value.power',
                read: true,
                write: false,
                unit: 'W',
                def: 0,
            },
            native: {},
        });

        await this.setObjectNotExistsAsync('forecast.surplus', {
            type: 'state',
            common: {
                name: 'Forecast Surplus',
                type: 'number',
                role: 'value.power',
                read: true,
                write: false,
                unit: 'W',
                def: 0,
            },
            native: {},
        });

        await this.setObjectNotExistsAsync('forecast.minutes', {
            type: 'state',
            common: {
                name: 'Forecast Minutes',
                type: 'number',
                role: 'value.interval',
                read: true,
                write: false,
                unit: 'min',
                def: 0,
            },
            native: {},
        });

        await this.setObjectNotExistsAsync('forecast.lastUpdate', {
            type: 'state',
            common: {
                name: 'Forecast Last Update',
                type: 'number',
                role: 'value.time',
                read: true,
                write: false,
                def: 0,
            },
            native: {},
        });
    }

    // =====================================================================
    // ========================= Forecast JSON parse =======================
    // =====================================================================
    async processPvforecastJson() {
        try {
            if (!this.forecastEnabled || !this.forecastJsonDatapoint) {
                return;
            }

            const state = await this.getForeignStateAsync(this.forecastJsonDatapoint);
            if (!state || !state.val) {
                return;
            }

            let data;
            try {
                data = typeof state.val === 'string' ? JSON.parse(state.val) : state.val;
            } catch {
                this.log.warn('[Forecast] Invalid JSON in pvforecast datapoint');
                return;
            }

            if (!Array.isArray(data) || data.length === 0) {
                return;
            }

            const now = Date.now();
            let best = null;

            for (const entry of data) {
                if (!entry || typeof entry.t !== 'number' || typeof entry.y !== 'number') {
                    continue;
                }
                if (entry.t < now) {
                    continue;
                }
                best = entry;
                break;
            }

            if (!best) {
                return;
            }

            // pvforecast liefert kW → wir rechnen auf W
            const power = Math.round(best.y * 1000);
            const minutes = Math.max(0, Math.round((best.t - now) / 60000));
            const surplus = power - (this.config.baseload || 0);

            this.forecast.power = power;
            this.forecast.surplus = surplus > 0 ? surplus : 0;
            this.forecast.minutes = minutes;
            this.forecast.lastUpdate = Date.now();

            await this.setStateAsync(`${this.namespace}.forecast.power`, { val: power, ack: true });
            await this.setStateAsync(`${this.namespace}.forecast.surplus`, {
                val: this.forecast.surplus,
                ack: true,
            });
            await this.setStateAsync(`${this.namespace}.forecast.minutes`, { val: minutes, ack: true });
            await this.setStateAsync(`${this.namespace}.forecast.lastUpdate`, {
                val: this.forecast.lastUpdate,
                ack: true,
            });

            this.log.debug(
                `[Forecast] JSON parsed → power=${power}W, surplus=${this.forecast.surplus}W, minutes=${minutes}`,
            );
        } catch (error) {
            this.log.error(`[Forecast] Error processing pvforecast JSON: ${error.message}`);
        }
    }

    // =====================================================================
    // ========================= Forecast helpers ==========================
    // =====================================================================
    getForecastPower(_v) {
        return this.forecast?.power || 0;
    }

    getForecastMinutes(_v) {
        return this.forecast?.minutes || 0;
    }

    isForecastAllowingSwitchOn(v) {
        if (!this.forecastEnabled || !v.useForecast) {
            return false;
        }
        const minMinutes = v.forecastMinMinutes || 0;
        if (this.forecast.minutes > minMinutes) {
            return false;
        }
        if (this.forecast.surplus >= v.performance) {
            return true;
        }
        return false;
    }

    isForecastDelayingSwitchOff(v, _currentSurplus) {
        if (!this.forecastEnabled || !v.useForecast) {
            return false;
        }
        const minMinutes = v.forecastMinMinutes || 0;
        if (this.forecast.minutes > minMinutes) {
            return false;
        }
        if (this.forecast.surplus >= v.switchOnPoint) {
            return true;
        }
        return false;
    }

    async setForecastState(v, idx, active, reason, power, minutes) {
        try {
            const safeName = this.name2id(v.name);
            const channelId = `consumer.${idx}_${safeName}`;
            const text = active
                ? `${reason || 'forecast'} (${power || this.forecast.power || 0}W / ${minutes || this.forecast.minutes || 0}min)`
                : '';
            await this.setStateAsync(`${this.namespace}.${channelId}.forecastStatus`, {
                val: text,
                ack: true,
            });
        } catch (err) {
            this.log.warn(`[Forecast] Failed to set forecastStatus: ${err.message}`);
        }
    }

    async sendForecastNotification(type, message) {
        try {
            if (this.config.notifyForecast) {
                await this.sendNotification('smartloadmanager', 'notify', message);
            }
        } catch (err) {
            this.log.warn(`[Forecast] Failed to send forecast notification: ${err.message}`);
        }
    }

    // =====================================================================
    // ========================= Time window helper ========================
    // =====================================================================
    timeWithinWindow(onTime, offTime, name) {
        if (!onTime || !offTime) {
            return true;
        }

        const now = new Date();
        const currentMinutes = now.getHours() * 60 + now.getMinutes();
        const onMinutes = this.parseTimeToMinutes(onTime);
        const offMinutes = this.parseTimeToMinutes(offTime);

        const within = currentMinutes >= onMinutes && currentMinutes < offMinutes;

        if (name) {
            this.log.debug(
                `${name}: Time window ${onTime}–${offTime}, current  ${now
                    .toTimeString()
                    .slice(0, 5)} (${currentMinutes} min), within? ${within}`,
            );
        }

        return within;
    }

    // =====================================================================
    // ========================= onStateChange =============================
    // =====================================================================
    async onStateChange(id, state) {
        if (!state) {
            return;
        }

        // 🔮 Forecast JSON datapoint changed
        if (this.forecastEnabled && this.forecastJsonDatapoint && id === this.forecastJsonDatapoint) {
            if (state.ack === true) {
                await this.processPvforecastJson();
                await this.checkConsumers();
            }
            return;
        }

        // FeedIn Datapoint - fremder State, nur bei ack=true reagieren
        if (id === this.feedInDatapoint) {
            // Nur verarbeiten wenn der Wert vom anderen Adapter bestätigt wurde
            if (state.ack === true) {
                this.log.debug(`Feed-in value updated: ${state.val} (ack=${state.ack})`);
                await this.checkConsumers();

                if (this.percentTimer) {
                    clearTimeout(this.percentTimer);
                }
                this.percentTimer = this.safeSetTimeout(
                    async () => {
                        for (const v of this.consumerList.filter(v => v.ruletype === 'percent')) {
                            await this.controlPercentConsumer(v);
                        }
                        this.percentTimer = null;
                    },
                    (this.config.delaySecondsProzent || this.DEFAULT_TIMEOUT / 1000) * 1000,
                );

                if (this.batteryTimer) {
                    clearTimeout(this.batteryTimer);
                }
                this.batteryTimer = this.safeSetTimeout(
                    async () => {
                        if (!this.feedInDatapoint) {
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
                    (this.config.batteryDelaySeconds || this.DEFAULT_TIMEOUT / 1000) * 1000,
                );
            } else {
                this.log.debug(`Feed-in value change ignored (ack=${state.ack}) - waiting for confirmed value`);
            }
            return;
        }

        // Eigene States - nur bei ack=false verarbeiten (Commands/Befehle)
        if (state && !state.ack) {
            this.log.debug(`State changed: ${id} => ${state.val}`);

            // --- Aktiv-Status manuell umschalten ---------------------------------
            if (id.match(/consumer\.(\d+)_.*?\.active/)) {
                const match = id.match(/consumer\.(\d+)_.*?\.active/);
                const index = parseInt(match[1]);
                const v = this.consumerList[index];
                if (v) {
                    v.enabled = state.val;
                    this.log.info(`Consumer "${v.name}" became ${state.val ? 'activated' : 'deactivated'}.`);
                    await this.setStateAsync(id, { val: state.val, ack: true });
                }
                return;
            }

            // ControlMode Änderungen
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

            // Time Änderungen
            const timeMatch = id.match(/consumer\.(\d+)_.*?\.(switchOnTime|switchOffTime)/);
            if (timeMatch) {
                const index = parseInt(timeMatch[1]);
                const type = timeMatch[2];
                this.consumerList[index][type] = state.val || '';
                await this.checkConsumers();
            }
        }
    }

    // =====================================================================
    // ============================ checkConsumers =========================
    // =====================================================================
    async checkConsumers() {
        if (this.checkRunning) {
            this.checkQueued = true;
            return;
        }
        this.checkRunning = true;
        this.checkQueued = false;

        try {
            if (!this.feedInDatapoint) {
                this.log.warn('No FeedIn datapoint set – skipping checkConsumers()');
                await this.sendNotification('smartloadmanager', 'alert', '❗ No FeedIn data point set – rule skipped.');
                this.checkRunning = false;
                if (this.checkQueued) {
                    await this.checkConsumers();
                }
                return;
            }

            const feedInState = await this.getForeignStateAsync(this.feedInDatapoint);
            let feedIn = Number(feedInState?.val) || 0;
            if (this.config.feedinNegativ) {
                feedIn = -feedIn;
            }

            const baseload = this.config.baseload || 0;
            const gridUsage = feedIn <= baseload;

            this.log.debug(`FeedIn: ${feedIn} W, Baseload: ${baseload} W, GridUsage: ${gridUsage}`);

            // ----------------------------------
            // Einschalten binary + heating
            // ----------------------------------
            const sortedOn = [...this.consumerList]
                .filter(v => v.ruletype === 'binary' || v.ruletype === 'heating')
                .sort((a, b) => (a.priority || 1) - (b.priority || 1));

            this.log.debug(`Switch-on check for ${sortedOn.length} binary/heating-consumers.`);

            for (const v of sortedOn) {
                // Überspringe deaktivierte Verbraucher
                if (!v.enabled) {
                    this.log.debug(`"${v.name}" is deactivated – skipped (power-on check).`);
                    continue;
                }
                const idx = this.consumerList.indexOf(v);
                const safeName = this.name2id(v.name);
                const id = `${this.namespace}.consumer.${idx}_${safeName}`;
                const mode = await this.getStateAsync(`${id}.controlMode`);

                this.log.debug(`Checking "${v.name}" (priority ${v.priority}, ${v.performance} W, Type=${v.ruletype})`);

                if (!mode || mode.val !== 2) {
                    this.log.debug(`Manual mode active, skipping.`);
                    continue;
                }

                const withinWindow = this.timeWithinWindow(v.switchOnTime, v.switchOffTime, v.name);

                let isOn = false;
                if (v.datapoint) {
                    const dpState = await this.getForeignStateAsync(v.datapoint);
                    if (dpState?.val === true) {
                        isOn = true;
                    }
                } else if (v.numericDatapoint) {
                    const numState = await this.getForeignStateAsync(v.numericDatapoint);
                    const numVal = Number(numState?.val) || 0;
                    if (numVal === 1) {
                        isOn = true;
                    }
                    this.log.debug(`NumericDatapoint für "${v.name}": ${v.numericDatapoint} = ${numVal}`);
                }

                this.log.debug(`"${v.name}" Status: isOn=${isOn}`);

                // Zusatz-Checks heating
                if (v.ruletype === 'heating' && withinWindow && !isOn) {
                    const tempState = v.temperatureDatapoint
                        ? await this.getForeignStateAsync(v.temperatureDatapoint)
                        : null;
                    const currentTemp = tempState?.val !== undefined ? Number(tempState.val) : null;

                    if (currentTemp !== null && v.maxTemperature !== undefined && currentTemp >= v.maxTemperature) {
                        this.log.warn(
                            `"${v.name}" not switched on, temperature ${currentTemp}°C >= MaxTemp ${v.maxTemperature}°C`,
                        );
                        continue;
                    }
                    if (currentTemp !== null && v.minTemperature !== undefined && currentTemp < v.minTemperature) {
                        this.log.debug(
                            `"${v.name}" not switched on yet, temperature ${currentTemp}°C < MinTemp ${v.minTemperature}°C`,
                        );
                        continue;
                    }

                    if (v.enableDatapoint) {
                        const enableState = await this.getForeignStateAsync(v.enableDatapoint);
                        if (!enableState?.val) {
                            this.log.debug(`"${v.name}" NOT switched on – Hardware release missing.`);
                            continue;
                        }
                    }

                    if (v.heartbeatDatapoint) {
                        const hbState = await this.getForeignStateAsync(v.heartbeatDatapoint);
                        if (!hbState?.val) {
                            this.log.warn(`"${v.name}" not switched on – hardware approval missing.`);
                            continue;
                        }
                    }
                }

                // Timer-Abbruch bei wegfallender Bedingung (Einschalten)
                if (
                    v.timer &&
                    v.timerEnd &&
                    v.pendingAction === true &&
                    (!withinWindow || gridUsage || v.performance > feedIn - baseload)
                ) {
                    clearTimeout(v.timer);
                    v.timer = null;
                    v.timerEnd = null;
                    v.pendingAction = null;
                    const channelId = `consumer.${idx}_${safeName}`;
                    await this.setStateAsync(`${this.namespace}.${channelId}.onTimerRemaining`, { val: 0, ack: true });
                    await this.setStateAsync(`${this.namespace}.${channelId}.offTimerRemaining`, { val: 0, ack: true });
                    this.log.debug(`Switch-on timer for "${v.name}" canceled (condition no longer valid).`);
                }

                if (withinWindow) {
                    if (!gridUsage && v.performance <= feedIn - baseload && !isOn) {
                        this.log.debug(
                            `Switch-on possible: surplus ${
                                feedIn - baseload
                            } W, within time window (onDelay ${v.switchOnDelay || 0}s).`,
                        );
                        await this.switchConsumerWithDelay(v, true, v.switchOnDelay || 0);
                        feedIn -= v.performance;
                        this.log.debug(`Remaining surplus after switch-on: ${feedIn - baseload} W`);
                        await this.setForecastState(v, idx, false, '', null, null);
                    } else if (!gridUsage && !isOn && this.isForecastAllowingSwitchOn(v)) {
                        const forecastPower = this.getForecastPower(v);
                        const minutes = this.getForecastMinutes(v);
                        this.log.debug(
                            `[Forecast] Early switch-on allowed for "${v.name}": ${forecastPower} W in ${minutes} min.`,
                        );
                        await this.setForecastState(v, idx, true, 'forecastSwitchOn', forecastPower, minutes);
                        await this.sendForecastNotification(
                            v.ruletype === 'percent' ? 'percent' : 'binary',
                            `🔮 Forecast: "${v.name}" will be switched on in ${minutes} minutes (${forecastPower} W expected).`,
                        );
                        await this.switchConsumerWithDelay(v, true, v.switchOnDelay || 0);
                        feedIn -= v.performance;
                    } else if (gridUsage && !isOn) {
                        this.log.debug(`Not switched on: grid usage active.`);
                    } else if (!isOn) {
                        this.log.debug(
                            `Not switched on: surplus too low (${feedIn - baseload} W < ${v.performance} W).`,
                        );
                    } else {
                        this.log.debug(`"${v.name}" is already switched on – no action needed.`);
                    }
                }
            }

            // ----------------------------------
            // Ausschalten binary + heating
            // ----------------------------------
            const sortedOff = [...this.consumerList]
                .filter(v => v.ruletype === 'binary' || v.ruletype === 'heating')
                .sort((a, b) => (b.priority || 1) - (a.priority || 1));

            this.log.debug(`Switch-off check for ${sortedOff.length} binary/heating-consumers.`);

            for (const v of sortedOff) {
                const idx = this.consumerList.indexOf(v);
                const safeName = this.name2id(v.name);
                const id = `${this.namespace}.consumer.${idx}_${safeName}`;
                const mode = await this.getStateAsync(`${id}.controlMode`);
                // Überspringe deaktivierte Verbraucher
                if (!v.enabled) {
                    this.log.debug(`"${v.name}" is deactivated – will be skipped (power-off check).`);
                    continue;
                }
                if (!mode || mode.val !== 2) {
                    continue;
                }

                const withinWindow = this.timeWithinWindow(v.switchOnTime, v.switchOffTime, v.name);

                let isOn = false;
                if (v.datapoint) {
                    const dpState = await this.getForeignStateAsync(v.datapoint);
                    if (dpState?.val === true) {
                        isOn = true;
                    }
                }
                if (v.numericDatapoint) {
                    const numState = await this.getForeignStateAsync(v.numericDatapoint);
                    const numVal = Number(numState?.val) || 0;
                    if (numVal === 1) {
                        isOn = true;
                    }
                }

                // AlwaysOffAtTime erzwingt Ausschalten
                if (v.alwaysOffAtTime && !withinWindow && isOn) {
                    if (v.timer && v.timerEnd && v.pendingAction === false) {
                        const remaining = Math.max(0, Math.round((v.timerEnd - Date.now()) / 1000));
                        this.log.debug(`Active timer for ${v.name}: ${remaining}s remaining`);
                    } else if (v.timer && v.timerEnd && v.pendingAction === true) {
                        clearTimeout(v.timer);
                        v.timer = null;
                        v.timerEnd = null;
                        v.pendingAction = null;
                        const channelId = `consumer.${idx}_${safeName}`;
                        await this.setStateAsync(`${this.namespace}.${channelId}.onTimerRemaining`, {
                            val: 0,
                            ack: true,
                        });
                        await this.setStateAsync(`${this.namespace}.${channelId}.offTimerRemaining`, {
                            val: 0,
                            ack: true,
                        });
                        this.log.debug(`Switch-on timer for "${v.name}" canceled (AlwaysOff active).`);
                        this.log.debug(
                            `AlwaysOff active: "${v.name}" - time window expired, offDelay ${v.switchOffDelay || 0}s.`,
                        );
                        await this.switchConsumerWithDelay(v, false, v.switchOffDelay || 0);
                    } else {
                        this.log.debug(
                            `AlwaysOff activ: "${v.name}" - time window expired, offDelay ${v.switchOffDelay || 0}s.`,
                        );
                        await this.switchConsumerWithDelay(v, false, v.switchOffDelay || 0);
                    }
                    continue;
                }

                if (v.ruletype === 'heating' && isOn) {
                    if (v.enableDatapoint) {
                        const enableState = await this.getForeignStateAsync(v.enableDatapoint);
                        if (!enableState?.val) {
                            this.log.warn(`"${v.name}" is being switched off - hardware approval missing.`);
                            await this.switchConsumerWithDelay(v, false, 0);
                            continue;
                        }
                    }
                    if (v.heartbeatDatapoint) {
                        const hbState = await this.getForeignStateAsync(v.heartbeatDatapoint);
                        if (!hbState?.val) {
                            this.log.warn(`"${v.name}" is being switched off - heartbeat missing.`);
                            await this.switchConsumerWithDelay(v, false, 0);
                            continue;
                        }
                    }
                }

                if (!isOn) {
                    continue;
                }

                // Temperatur-basierte Ausschaltung für heating
                if (v.ruletype === 'heating' && v.maxTemperature !== undefined && isOn) {
                    const tempState = v.temperatureDatapoint
                        ? await this.getForeignStateAsync(v.temperatureDatapoint)
                        : null;
                    const currentTemp = tempState?.val !== undefined ? Number(tempState.val) : null;
                    if (currentTemp !== null && currentTemp >= v.maxTemperature) {
                        this.log.warn(
                            `"${v.name}" switched off due to maxTemperature reached: ${currentTemp}°C >= ${v.maxTemperature}°C`,
                        );
                        await this.switchConsumerWithDelay(v, false, 0);
                        continue; // weiter zum nächsten Verbraucher
                    }
                }

                // Timer-Abbruch bei wegfallender Bedingung (Ausschalten)
                const surplus = feedIn - baseload;
                if (v.timer && v.timerEnd && v.pendingAction === false && withinWindow && surplus >= v.switchOffPoint) {
                    clearTimeout(v.timer);
                    v.timer = null;
                    v.timerEnd = null;
                    v.pendingAction = null;
                    const channelId = `consumer.${idx}_${safeName}`;
                    await this.setStateAsync(`${this.namespace}.${channelId}.onTimerRemaining`, { val: 0, ack: true });
                    await this.setStateAsync(`${this.namespace}.${channelId}.offTimerRemaining`, { val: 0, ack: true });
                    this.log.debug(`Switch-off timer for "${v.name}" canceled (condition no longer valid).`);
                }

                // Ausschalten, wenn:
                // - Zeitfenster verlassen ODER
                // - Netzbezug aktiv ODER
                // - Überschuss < switchOffPoint
                const shouldSwitchOff = !withinWindow || gridUsage || surplus < v.switchOffPoint;

                if (!v.alwaysOffAtTime && shouldSwitchOff) {
                    // 🔮 Forecast delay switch-off (PV forecast integration)
                    if (this.isForecastDelayingSwitchOff(v, surplus)) {
                        const forecastPower = this.getForecastPower(v);
                        const minutes = this.getForecastMinutes(v);
                        this.log.debug(
                            `[Forecast] Switch-off delayed for "${v.name}": ${forecastPower} W in ${minutes} min.`,
                        );
                        await this.setForecastState(v, idx, true, 'forecastDelayOff', forecastPower, minutes);
                        await this.sendForecastNotification(
                            v.ruletype === 'percent' ? 'percent' : 'binary',
                            `🔮 Forecast: "${v.name}" remains active (${forecastPower} W expected in ${minutes} min).`,
                        );
                        continue;
                    }

                    if (v.timer && v.timerEnd && v.pendingAction === false) {
                        const remaining = Math.max(0, Math.round((v.timerEnd - Date.now()) / 1000));
                        this.log.debug(`Active timer for ${v.name}: ${remaining}s remaining`);
                    } else {
                        this.log.debug(
                            `Switching off: "${v.name}" - surplus ${surplus}W < switchOffPoint ${v.switchOffPoint}W, offDelay ${v.switchOffDelay || 0}s.`,
                        );
                        await this.switchConsumerWithDelay(v, false, v.switchOffDelay || 0);
                        await this.setForecastState(v, idx, false, '', null, null);
                    }
                }
            }

            // --- Batterie unverändert ---
            const batteryConsumers = this.consumerList.filter(c => c.ruletype === 'battery');
            for (const v of batteryConsumers) {
                if (!v.enabled) {
                    this.log.debug(`"${v.name}" is deactivated – battery control skipped.`);
                    continue;
                }
                await this.controlBattery(v, feedIn);
            }

            const runningTimers = this.consumerList
                .filter(c => c.timer && c.timerEnd)
                .map(c => {
                    const remaining = Math.max(0, Math.round((c.timerEnd - Date.now()) / 1000));
                    return `${c.name}: noch ${remaining}s`;
                });

            if (runningTimers.length > 0) {
                this.log.debug(`Active timers: ${runningTimers.join(' | ')}`);
            } else {
                this.log.debug('No active timers.');
            }
        } catch (err) {
            this.log.error(`Error in checkConsumers: ${err.message}`);
            await this.sendNotification('smartloadmanager', 'alert', `❌ Fehler in checkConsumers: ${err.message}`);
        }

        this.checkRunning = false;
        if (this.checkQueued) {
            await this.checkConsumers();
        }
    }

    // =====================================================================
    // ========================= controlPercentConsumer ====================
    // =====================================================================
    async controlPercentConsumer(v) {
        try {
            const withinWindow = this.timeWithinWindow(v.switchOnTime, v.switchOffTime);
            if (!withinWindow) {
                this.log.debug(`[Percent] ${v.name} outside time window, set to 0%`);
                await this.setForeignStateAsync(v.datapoint, 0);
                return;
            }

            if (!this.feedInDatapoint) {
                this.log.error('feedInDatapoint not set!');
                await this.sendNotification('smartloadmanager', 'alert', '❌ feedInDatapoint ist nicht gesetzt!');
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
                await this.setForeignStateAsync(v.datapoint, newPercent);
                this.log.info(`${v.name} set to ${newPercent}%`);

                if (this.config.notifyPercent) {
                    await this.sendNotification(
                        'smartloadmanager',
                        'notify',
                        `⚙️ ${v.name} wurde auf ${newPercent}% geregelt`,
                    );
                }
            } else {
                this.log.debug(`[Percent] ${v.name} remains at ${currentPercent}%`);
            }
        } catch (error) {
            this.log.error(`Error in controlPercentConsumer: ${error.message}`);
            await this.sendNotification(
                'smartloadmanager',
                'alert',
                `❌ Fehler in controlPercentConsumer: ${error.message}`,
            );
        }
    }

    // =====================================================================
    // =============================== controlBattery ======================
    // =====================================================================
    async controlBattery(v, feedIn) {
        try {
            this.log.debug(`[Battery] Checking for ${v.name}`);

            const withinWindow = this.timeWithinWindow(v.switchOnTime, v.switchOffTime);
            if (!withinWindow) {
                this.log.debug(`[Battery] ${v.name} outside time window, set to 0`);
                if (v.batterySetpoint) {
                    await this.setForeignStateAsync(v.batterySetpoint, {
                        val: 0,
                        ack: true,
                    });
                }
                if (this.batteryControlModeDatapoint) {
                    await this.setForeignStateAsync(this.batteryControlModeDatapoint, {
                        val: 0,
                        ack: true,
                    });
                }
                return;
            }

            if (!v.batterySetpoint) {
                this.log.warn(`[Battery] ${v.name} has no batterySetpoint`);
                if (this.batteryControlModeDatapoint) {
                    await this.setForeignStateAsync(this.batteryControlModeDatapoint, {
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
                    this.log.warn(`[Battery] ${v.name}: invalid SOC or targetSOC`);
                    soc = null;
                    targetSoc = null;
                }
            }

            const surplus = (this.config.feedinNegativ ? -feedIn : feedIn) - (this.config.baseload || 0);
            let powerToSet = 0;
            let modeToSet = 0;

            if (surplus <= 0) {
                powerToSet = 0;
                modeToSet = 0;
            } else if (soc !== null && targetSoc !== null && soc >= targetSoc) {
                powerToSet = 0;
                modeToSet = 1;
            } else {
                powerToSet = Math.min(surplus, v.performance || 1000);
                modeToSet = 2;
            }

            const oldPower = Number((await this.getForeignStateAsync(v.batterySetpoint))?.val) || 0;
            const oldMode = this.batteryControlModeDatapoint
                ? Number((await this.getForeignStateAsync(this.batteryControlModeDatapoint))?.val) || 0
                : -1;

            if (powerToSet !== oldPower) {
                await this.setForeignStateAsync(v.batterySetpoint, {
                    val: powerToSet,
                    ack: true,
                });
                this.log.info(`Battery ${v.name}: charging power set to ${powerToSet}W`);
                if (this.config.notifyBattery) {
                    await this.sendNotification(
                        'smartloadmanager',
                        'notify',
                        `🔋 Batterie ${v.name}: Ladeleistung auf ${powerToSet}W gesetzt`,
                    );
                }
            } else {
                this.log.debug(`[Battery] ${v.name} charging power remains at ${oldPower}W`);
            }

            if (this.batteryControlModeDatapoint && modeToSet !== oldMode) {
                await this.setForeignStateAsync(this.batteryControlModeDatapoint, {
                    val: modeToSet,
                    ack: true,
                });
                this.log.debug(`[Battery] ${v.name} mode changed from ${oldMode} to ${modeToSet}`);
                if (this.config.notifyBattery) {
                    await this.sendNotification(
                        'smartloadmanager',
                        'notify',
                        `🔋 Batterie ${v.name}: Modus geändert auf ${modeToSet}`,
                    );
                }
            }
        } catch (error) {
            this.log.error(`[Battery] Error for ${v.name}: ${error.message}`);
            await this.sendNotification(
                'smartloadmanager',
                'alert',
                `❌ Batterie-Fehler für ${v.name}: ${error.message}`,
            );
        }
    }

    /**
     * Zentrale Schaltfunktion: setzt sowohl booleanen Schalter-DP als auch optionalen numerischen DP (0/1)
     *
     * @param consumer - Der Verbraucher, der geschaltet werden soll
     * @param turnOn - true zum Einschalten, false zum Ausschalten
     */
    async doSwitchConsumer(consumer, turnOn) {
        const targetState = !!turnOn;

        if (consumer.datapoint) {
            // Erst setzen
            await this.setForeignStateAsync(consumer.datapoint, {
                val: targetState,
                ack: false,
            });
            // Danach sofort bestätigen (falls keine Rückmeldung vom Gerät kommt)
            await this.setForeignStateAsync(consumer.datapoint, {
                val: targetState,
                ack: true,
            });
        }

        if (consumer.numericDatapoint) {
            const numVal = targetState ? 1 : 0;
            await this.setForeignStateAsync(consumer.numericDatapoint, {
                val: numVal,
                ack: false,
            });
            await this.setForeignStateAsync(consumer.numericDatapoint, {
                val: numVal,
                ack: true,
            });
            this.log.debug(`Numeric datapoint for "${consumer.name}" set to ${numVal}`);
        }

        const msg = `${consumer.name} wurde ${targetState ? 'eingeschaltet' : 'ausgeschaltet'}`;

        if (consumer.ruletype === 'heating') {
            if (this.config.notifyHeating) {
                await this.sendNotification('smartloadmanager', 'notify', msg);
            }
        } else if (consumer.ruletype === 'binary') {
            if (this.config.notifyBinary) {
                await this.sendNotification('smartloadmanager', 'notify', msg);
            }
        }
    }

    // =====================================================================
    // ========================= switchConsumerWithDelay ===================
    // =====================================================================
    async switchConsumerWithDelay(consumer, turnOn, delaySeconds) {
        const delay =
            delaySeconds !== undefined
                ? delaySeconds
                : turnOn
                  ? consumer.switchOnDelay || 0
                  : consumer.switchOffDelay || 0;

        const idx = this.consumerList.indexOf(consumer);
        const safeName = this.name2id(consumer.name);
        const channelId = `consumer.${idx}_${safeName}`;
        const onTimerState = `${this.namespace}.${channelId}.onTimerRemaining`;
        const offTimerState = `${this.namespace}.${channelId}.offTimerRemaining`;

        const stopTimerTicker = async () => {
            if (consumer.timerTick) {
                clearInterval(consumer.timerTick);
                consumer.timerTick = null;
            }
            await this.setStateAsync(onTimerState, { val: 0, ack: true });
            await this.setStateAsync(offTimerState, { val: 0, ack: true });
        };

        const startTimerTicker = async () => {
            const tick = async () => {
                if (
                    !consumer.timer ||
                    !consumer.timerEnd ||
                    consumer.pendingAction === undefined ||
                    consumer.pendingAction === null
                ) {
                    await stopTimerTicker();
                    return;
                }
                const remaining = Math.max(0, Math.round((consumer.timerEnd - Date.now()) / 1000));
                if (consumer.pendingAction) {
                    await this.setStateAsync(onTimerState, { val: remaining, ack: true });
                    await this.setStateAsync(offTimerState, { val: 0, ack: true });
                } else {
                    await this.setStateAsync(offTimerState, {
                        val: remaining,
                        ack: true,
                    });
                    await this.setStateAsync(onTimerState, { val: 0, ack: true });
                }
            };
            await tick();
            if (consumer.timerTick) {
                clearInterval(consumer.timerTick);
                consumer.timerTick = null;
            }
            consumer.timerTick = this.safeSetInterval(tick, 1000);
        };

        const doSwitch = async () => {
            // nur bei heating: zusätzliche Sicherheitschecks
            if (consumer.ruletype === 'heating' && turnOn) {
                const tempState = consumer.temperatureDatapoint
                    ? await this.getForeignStateAsync(consumer.temperatureDatapoint)
                    : null;
                const currentTemp = tempState?.val !== undefined ? Number(tempState.val) : null;

                if (
                    currentTemp !== null &&
                    consumer.maxTemperature !== undefined &&
                    currentTemp >= consumer.maxTemperature
                ) {
                    consumer.timer = null;
                    consumer.timerEnd = null;
                    consumer.pendingAction = null;
                    await stopTimerTicker();
                    return;
                }

                if (
                    consumer.minTemperature !== undefined &&
                    currentTemp !== null &&
                    currentTemp < consumer.minTemperature
                ) {
                    consumer.timer = null;
                    consumer.timerEnd = null;
                    consumer.pendingAction = null;
                    await stopTimerTicker();
                    return;
                }

                if (consumer.enableDatapoint) {
                    const enableState = await this.getForeignStateAsync(consumer.enableDatapoint);
                    if (!enableState?.val) {
                        consumer.timer = null;
                        consumer.timerEnd = null;
                        consumer.pendingAction = null;
                        await stopTimerTicker();
                        return;
                    }
                }

                if (consumer.heartbeatDatapoint) {
                    const hbState = await this.getForeignStateAsync(consumer.heartbeatDatapoint);
                    if (!hbState?.val) {
                        consumer.timer = null;
                        consumer.timerEnd = null;
                        consumer.pendingAction = null;
                        await stopTimerTicker();
                        return;
                    }
                }
            }

            await this.doSwitchConsumer(consumer, turnOn);
            if (consumer.timer) {
                clearTimeout(consumer.timer);
            }
            consumer.timer = null;
            consumer.timerEnd = null;
            consumer.pendingAction = null;
            await stopTimerTicker();
        };

        // Falls Timer läuft, aber Bedingung sich geändert hat → Timer abbrechen / anpassen
        if (consumer.timer) {
            // wenn Einschalt-Timer läuft, aber turnOn nicht mehr gilt → abbrechen
            if (consumer.pendingAction === true && !turnOn) {
                clearTimeout(consumer.timer);
                consumer.timer = null;
                consumer.timerEnd = null;
                consumer.pendingAction = null;
                await stopTimerTicker();
                return; // Timer beendet, keine neue Aktion starten
            }

            // wenn Ausschalt-Timer läuft, aber turnOn wieder gilt → abbrechen
            if (consumer.pendingAction === false && turnOn) {
                clearTimeout(consumer.timer);
                consumer.timer = null;
                consumer.timerEnd = null;
                consumer.pendingAction = null;
                await stopTimerTicker();
                return; // Timer beendet, keine neue Aktion starten
            }

            // wenn gleiches Ziel wie bisher → nichts neu starten
            if (consumer.pendingAction === turnOn) {
                return;
            }

            // ansonsten Timer neu setzen (älteren abbrechen)
            clearTimeout(consumer.timer);
            consumer.timer = null;
            consumer.timerEnd = null;
            consumer.pendingAction = null;
            await stopTimerTicker();
        }

        if (delay > 0) {
            consumer.timerEnd = Date.now() + delay * 1000;
            consumer.pendingAction = turnOn;
            consumer.timer = this.safeSetTimeout(doSwitch, delay * 1000);
            await startTimerTicker();
        } else {
            await doSwitch();
        }
    }

    // =====================================================================
    // ========================= sendNotification ==========================
    // =====================================================================
    // Zentrale, einheitliche Notification-Funktion
    // Aufruf: await this.sendNotification('smartloadmanager', 'info'|'notify'|'alert', 'Nachricht');
    async sendNotification(scope, category, message) {
        try {
            const cfg = this.config;

            // 1) Controller-Notification (nur wenn Option aktiv ist)
            if (cfg.enableNotificationManager) {
                await this.registerNotification(scope, category, message);
                this.log.debug(`Controller-Notification [${scope}/${category}]: ${message}`);
            }

            // 2) Messenger-Nachrichten

            // Telegram
            if (cfg.telegramInstance) {
                const recipients = (cfg.telegramRecipients || '')
                    .split(',')
                    .map(r => r.trim())
                    .filter(Boolean);
                if (recipients.length > 0) {
                    recipients.forEach(user => {
                        this.sendTo(cfg.telegramInstance, { text: message, user });
                        this.log.debug(`Telegram → ${cfg.telegramInstance}/${user}: ${message}`);
                    });
                } else {
                    this.sendTo(cfg.telegramInstance, message);
                    this.log.debug(`Telegram → ${cfg.telegramInstance}: ${message}`);
                }
            }

            // Gotify (hat keine Benutzer, nur Instanz)
            if (cfg.gotifyInstance) {
                this.sendTo(cfg.gotifyInstance, {
                    title: 'SmartLoadManager',
                    message: message,
                });
                this.log.debug(`Gotify → ${cfg.gotifyInstance}: ${message}`);
            }

            // E-Mail
            if (cfg.emailInstance) {
                const recipients = (cfg.emailRecipients || '')
                    .split(',')
                    .map(r => r.trim())
                    .filter(Boolean);
                if (recipients.length > 0) {
                    recipients.forEach(to => {
                        this.sendTo(cfg.emailInstance, {
                            to,
                            text: message,
                            subject: 'SmartLoadManager',
                        });
                        this.log.debug(`Email → ${cfg.emailInstance}/${to}: ${message}`);
                    });
                } else {
                    this.sendTo(cfg.emailInstance, {
                        text: message,
                        subject: 'SmartLoadManager',
                    });
                    this.log.debug(`Email → ${cfg.emailInstance}: ${message}`);
                }
            }

            // WhatsApp-cmd
            if (cfg.whatsappInstance) {
                const recipients = (cfg.whatsappRecipients || '')
                    .split(',')
                    .map(r => r.trim())
                    .filter(Boolean);
                if (recipients.length > 0) {
                    recipients.forEach(user => {
                        this.sendTo(cfg.whatsappInstance, { text: message, user });
                        this.log.debug(`WhatsApp → ${cfg.whatsappInstance}/${user}: ${message}`);
                    });
                } else {
                    this.sendTo(cfg.whatsappInstance, { text: message });
                    this.log.debug(`WhatsApp → ${cfg.whatsappInstance}: ${message}`);
                }
            }

            // Signal-cmd
            if (cfg.signalInstance) {
                const recipients = (cfg.signalRecipients || '')
                    .split(',')
                    .map(r => r.trim())
                    .filter(Boolean);
                if (recipients.length > 0) {
                    recipients.forEach(user => {
                        this.sendTo(cfg.signalInstance, { text: message, user });
                        this.log.debug(`Signal → ${cfg.signalInstance}/${user}: ${message}`);
                    });
                } else {
                    this.sendTo(cfg.signalInstance, { text: message });
                    this.log.debug(`Signal → ${cfg.signalInstance}: ${message}`);
                }
            }

            // Pushover
            if (cfg.pushoverInstance) {
                const recipients = (cfg.pushoverRecipients || '')
                    .split(',')
                    .map(r => r.trim())
                    .filter(Boolean);
                if (recipients.length > 0) {
                    recipients.forEach(user => {
                        this.sendTo(cfg.pushoverInstance, {
                            message: message,
                            title: 'SmartLoadManager',
                            user,
                        });
                        this.log.debug(`Pushover → ${cfg.pushoverInstance}/${user}: ${message}`);
                    });
                } else {
                    this.sendTo(cfg.pushoverInstance, {
                        message: message,
                        title: 'SmartLoadManager',
                    });
                    this.log.debug(`Pushover → ${cfg.pushoverInstance}: ${message}`);
                }
            }
        } catch (e) {
            this.log.warn(`Error sending notification: ${e.message}`);
        }
    }

    // =====================================================================
    // ========================= initializeConsumerStatus ==================
    // =====================================================================
    async initializeConsumerStatus() {
        // Initiale Status-Updates
        for (const v of this.consumerList) {
            const safeName = this.name2id(v.name);
            const channelId = `consumer.${this.consumerList.indexOf(v)}_${safeName}`;
            const modeState = await this.getStateAsync(`${this.namespace}.${channelId}.controlMode`);
            if (!modeState) {
                await this.setStateAsync(`${this.namespace}.${channelId}.controlMode`, {
                    val: 2,
                    ack: true,
                });
            }
        }
    }

    sleep(ms) {
        return new Promise(resolve => this.safeSetTimeout(resolve, ms, 'sleep'));
    }

    parseTimeToMinutes(timeStr) {
        if (!timeStr || typeof timeStr !== 'string' || !timeStr.includes(':')) {
            return 0;
        }
        const [h, m] = timeStr.split(':').map(Number);
        if (isNaN(h) || isNaN(m)) {
            return 0;
        }
        return h * 60 + m;
    }

    // =====================================================================
    // =============================== onUnload ============================
    // =====================================================================
    async onUnload(callback) {
        try {
            if (this.percentTimer) {
                clearTimeout(this.percentTimer);
            }
            if (this.batteryTimer) {
                clearTimeout(this.batteryTimer);
            }
            for (const v of this.consumerList) {
                if (v.timer) {
                    clearTimeout(v.timer);
                    v.timer = null;
                }
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
