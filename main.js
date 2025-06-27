'use strict';

const utils = require('@iobroker/adapter-core');

class Nulleinspeisung extends utils.Adapter {
    constructor(options = {}) {
        super({ ...options, name: 'nulleinspeisung' });
    }

    async onReady() {
        const einspeisungId = this.config.einspeisungId;
        if (!einspeisungId) {
            this.log.error('Einspeisungs-Datenpunkt nicht konfigiert.');
            return;
        }

        this.subscribeForeignStates(einspeisungId);
        this.log.info(`Beobachte: ${einspeisungId}`);

        const state = await this.getForeignStateAsync(einspeisungId);
        if (state && typeof state.val === 'number') {
            await this.regleVerbraucher(state.val);
        }
    }

    async onStateChange(id, state) {
        if (!state || state.ack !== true) return;
        if (id === this.config.einspeisungId && typeof state.val === 'number') {
            await this.regleVerbraucher(state.val);
        }
    }

    async regleVerbraucher(einspeisung) {
        const verbraucher = this.config.verbraucher || [];
        const zustand = {};
        let freieLeistung = einspeisung > 0 ? einspeisung : 0;

        if (einspeisung >= 0) {
            for (const v of verbraucher) {
                const { datenpunkt: dp, leistung, name, regelTyp = 'binary', vollzuschaltung = false } = v;

                if (regelTyp === 'percent') {
                    const prozent = vollzuschaltung
                        ? (freieLeistung >= leistung ? 100 : 0)
                        : Math.min(100, Math.floor((freieLeistung / leistung) * 100));
                    zustand[dp] = prozent;
                    freieLeistung -= (prozent / 100) * leistung;
                    this.log.debug(`${name}: auf ${prozent}% geregelt`);
                } else {
                    if (freieLeistung >= leistung) {
                        zustand[dp] = true;
                        freieLeistung -= leistung;
                        this.log.debug(`${name}: eingeschaltet`);
                    } else {
                        zustand[dp] = false;
                        this.log.debug(`${name}: nicht genug Leistung`);
                    }
                }
            }
        } else {
            let bezug = Math.abs(einspeisung);
            for (const v of [...verbraucher].reverse()) {
                const { datenpunkt: dp, leistung, name, regelTyp = 'binary' } = v;

                if (regelTyp === 'percent') {
                    const state = await this.getForeignStateAsync(dp);
                    const alt = state?.val || 0;
                    const aktuellWatt = (alt / 100) * leistung;

                    if (aktuellWatt > bezug) {
                        const neu = Math.max(0, Math.floor(((aktuellWatt - bezug) / leistung) * 100));
                        zustand[dp] = neu;
                        bezug = 0;
                    } else {
                        zustand[dp] = 0;
                        bezug -= aktuellWatt;
                    }
                } else {
                    const state = await this.getForeignStateAsync(dp);
                    if (state?.val === true) {
                        zustand[dp] = false;
                        bezug -= leistung;
                    }
                }

                if (bezug <= 0) break;
            }
        }

        for (const [dp, wert] of Object.entries(zustand)) {
            try {
                const alt = await this.getForeignStateAsync(dp);
                if (alt?.val !== wert) {
                    await this.setForeignStateAsync(dp, wert, true);
                    this.log.info(`${dp} → ${wert}`);
                }
            } catch (err) {
                this.log.warn(`Fehler beim Setzen von ${dp}: ${err.message}`);
            }
        }
    }
}

if (require.main !== module) {
    module.exports = (options) => new Nulleinspeisung(options);
} else {
    new Nulleinspeisung();
}