// @ts-nocheck
"use strict";

const utils = require("@iobroker/adapter-core");

class Nulleinspeisung extends utils.Adapter {
	constructor(options) {
		super({
			...options,
			name: "nulleinspeisung",
		});

		this.verbraucherListe = [];
		this.einspeisungDatapoint = null;
		this.prozentTimer = null;  // <-- als einzelner Timer
		this.eingeschalteteVerbraucher = [];
		this.stateChangeTimeout = null;
		this.checkRunning = false;
		this.processingLockSchalten = false;

		this.on("ready", this.onReady.bind(this));
		this.on("stateChange", this.onStateChange.bind(this));
		this.on("unload", this.onUnload.bind(this));
	}

	async onReady() {
		try {
			this.log.info("=== Adapter gestartet - PID: " + process.pid + " ===");

			if (!this.config.einspeisungId) {
				this.log.error("Keine EinspeisungId gesetzt!");
				return;
			}
			this.einspeisungDatapoint = this.config.einspeisungId;

			this.verbraucherListe = Array.isArray(this.config.verbraucher)
				? this.config.verbraucher.filter((v) => v && v.enabled && v.datenpunkt && v.leistung > 0)
				: [];

			this.log.info("Verbraucher geladen: " + this.verbraucherListe.map((v) => v.name).join(", "));

			await this.checkAndCreateVerbraucherObjects();
			await this.initializeVerbraucherStatus();

			await this.createVerbraucherStates();

			await this.subscribeStatesAsync("*");
			await this.subscribeForeignStatesAsync(this.einspeisungDatapoint);
		} catch (error) {
			this.log.error("Fehler in onReady: " + error.message);
		}
	}

	async createVerbraucherStates() {
		for (let i = 0; i < this.verbraucherListe.length; i++) {
			const v = this.verbraucherListe[i];
			const channelId = `verbraucher.${i}_${v.name.replace(/\s+/g, "_")}`;

			await this.setObjectNotExistsAsync(channelId, {
				type: "channel",
				common: { name: v.name },
				native: {},
			});

			await this.setObjectNotExistsAsync(`${channelId}.steuerungsmodus`, {
				type: "state",
				common: {
					name: `${v.name} Steuerungsmodus`,
					type: "number",
					role: "level.mode",
					read: true,
					write: true,
					states: { 0: "Aus", 1: "Manuell Ein", 2: "Automatik" },
					def: 2,
				},
				native: {},
			});

			const modeExisting = await this.getStateAsync(`${this.namespace}.${channelId}.steuerungsmodus`);
			if (!modeExisting) {
				await this.setStateAsync(`${channelId}.steuerungsmodus`, { val: 2, ack: true });
				this.log.debug(`Initialer Steuerungsmodus gesetzt: ${channelId}.steuerungsmodus = 2`);
			}
		}
	}

	async onStateChange(id, state) {
		if (state && !state.ack) {
			this.log.debug(`State geändert: ${id} => ${state.val}`);

			const match = id.match(/verbraucher\.(\d+)_.*?\.steuerungsmodus/);
			if (match) {
				const index = parseInt(match[1]);
				const modus = state.val;

				if (this.verbraucherListe[index]) {
					const v = this.verbraucherListe[index];

					// Timer abbrechen, falls aktiv
					if (v.timer) {
						clearTimeout(v.timer);
						v.timer = null;
						this.log.debug(`${v.name}: bestehender Timer bei Moduswechsel gelöscht.`);
					}

					if (modus === 0) {
						this.log.info(`${v.name}: Steuerungsmodus auf AUS gesetzt.`);
						if (v.regelTyp === "percent") {
							await this.setForeignStateAsync(v.datenpunkt, 0);
							this.log.info(`${v.name}: Prozent auf 0 gesetzt.`);
						} else {
							await this.schalteVerbraucherMitDelay(v, false);
						}
					} else if (modus === 1) {
						this.log.info(`${v.name}: Steuerungsmodus auf MANUELL EIN gesetzt.`);
						if (v.regelTyp === "percent") {
							await this.setForeignStateAsync(v.datenpunkt, 100);
							this.log.info(`${v.name}: Prozent auf 100 gesetzt.`);
						} else {
							await this.schalteVerbraucherMitDelay(v, true);
						}
					} else if (modus === 2) {
						this.log.info(`${v.name}: Steuerungsmodus auf AUTOMATIK gesetzt.`);
						// Automatik läuft in checkVerbraucher bzw. regelProzentVerbraucher
					}
				}
			}

			if (id === this.einspeisungDatapoint) {
				// Sofort binary-Verbraucher prüfen
				await this.checkVerbraucher();

				// Prozentregelung mit Verzögerung (debounce)
				if (this.prozentTimer) clearTimeout(this.prozentTimer);

				this.prozentTimer = setTimeout(async () => {
					for (const v of this.verbraucherListe) {
						if (v.regelTyp === "percent") {
							await this.regelProzentVerbraucher(v);
						}
					}
					this.prozentTimer = null;
				}, (this.config.delaySecondsProzent || 10) * 1000); // Standard 10 Sekunden
			}
		}
	}

	async checkAndCreateVerbraucherObjects() {
		for (const v of this.verbraucherListe) {
			try {
				const obj = await this.getForeignObjectAsync(v.datenpunkt);
				if (!obj) {
					this.log.warn(`Verbraucher Datenpunkt ${v.datenpunkt} existiert nicht!`);
				}
			} catch (e) {
				this.log.error(`Fehler beim Prüfen von ${v.datenpunkt}: ${e}`);
			}
		}
	}

	async initializeVerbraucherStatus() {
		this.eingeschalteteVerbraucher = [];
		for (const v of this.verbraucherListe) {
			if (v.regelTyp === "binary") {
				const state = await this.getForeignStateAsync(v.datenpunkt);
				if (this.isTrue(state?.val)) {
					this.eingeschalteteVerbraucher.push(v);
					this.log.info(`${v.name} ist bereits eingeschaltet`);
				}
			}
		}
	}

	isTrue(val) {
		return val === true || val === "true" || val === 1;
	}

	// Prozentregelung für Verbraucher mit regelTyp = "percent"
	async regelProzentVerbraucher(v) {
		try {
			this.log.debug(`Prozentregelung gestartet für ${v.name}`);
			const einspeisungState = await this.getForeignStateAsync(this.einspeisungDatapoint);
			let einspeisungWert = Number(einspeisungState?.val) || 0;

			const state = await this.getForeignStateAsync(v.datenpunkt);
			const currentPercent = Number(state?.val) || 0;

			this.log.info(`🔧 FeedinNegativ: ${this.config.feedinNegativ}`);
			this.log.info(`🔧 EinspeisungWert (original): ${einspeisungWert}`);

			let netzbezug = false;
			let ueberschuss = 0;

			if (this.config.feedinNegativ) {
				if (einspeisungWert < 0) {
					ueberschuss = -einspeisungWert;
					netzbezug = false;
				} else {
					ueberschuss = 0;
					netzbezug = true;
				}
			} else {
				if (einspeisungWert > 0) {
					ueberschuss = einspeisungWert;
					netzbezug = false;
				} else {
					ueberschuss = 0;
					netzbezug = true;
				}
			}

			const grundlast = this.config.grundlast || 0;
			ueberschuss -= grundlast;
			if (ueberschuss < 0) ueberschuss = 0;

			this.log.info(`🔧 Ueberschuss nach Grundlast-Abzug: ${ueberschuss}`);
			this.log.info(`🔧 Netzbezug: ${netzbezug}`);

			const maxLeistung = v.maxLeistung || v.leistung || 1000;
			this.log.info(`🔧 MaxLeistung: ${maxLeistung}`);

			let prozentNeu = Math.round((ueberschuss / maxLeistung) * 100);
			prozentNeu = Math.min(100, Math.max(prozentNeu, v.minProzentStart || 0));

			this.log.info(`🔧 currentPercent: ${currentPercent}, prozentNeu berechnet: ${prozentNeu}`);

			if (netzbezug) {
				if (currentPercent !== 0) {
					await this.setForeignStateAsync(v.datenpunkt, 0);
					this.log.info(`${v.name}: Netzbezug erkannt – Prozent auf 0% gesetzt.`);
				} else {
					this.log.info(`${v.name}: Netzbezug erkannt – Prozent bleibt bei 0%.`);
				}
			} else {
				if (prozentNeu !== currentPercent) {
					await this.setForeignStateAsync(v.datenpunkt, prozentNeu);
					this.log.info(`${v.name}: Prozent auf ${prozentNeu}% gesetzt (${Math.round((prozentNeu / 100) * maxLeistung)} W).`);
				} else {
					this.log.info(`${v.name}: Prozent bleibt bei ${currentPercent}%.`);
				}
			}
		} catch (error) {
			this.log.error("Fehler in regelProzentVerbraucher: " + error.message);
		}
	}

	async checkVerbraucher() {
		if (this.checkRunning) {
			this.log.debug("checkVerbraucher läuft bereits, Überspringe aktuellen Aufruf");
			return;
		}
		this.checkRunning = true;

		try {
			const einspeisungState = await this.getForeignStateAsync(this.einspeisungDatapoint);
			let einspeisung = Number(einspeisungState?.val) || 0;
			this.log.debug(`Einspeisung: ${einspeisung}`);

			if (this.config.feedinNegativ) {
				einspeisung = -einspeisung; // für negative Einspeisung
			}

			const grundlast = this.config.grundlast || 0;
			const netzbezug = einspeisung <= grundlast;

			this.log.debug(`Netzbezug (einspeisung <= grundlast): ${netzbezug}`);

			if (netzbezug) {
				// Netzbezug, alle Verbraucher aus
				for (const v of this.verbraucherListe) {
					if (v.regelTyp === "binary") {
						const mode = await this.getStateAsync(`verbraucher.${this.verbraucherListe.indexOf(v)}_${v.name.replace(/\s+/g, "_")}.steuerungsmodus`);
						if (mode && mode.val === 2) { // Automatik nur schalten
							await this.schalteVerbraucherMitDelay(v, false);
						}
					}
				}
			} else {
				// Überschuss vorhanden, Verbraucher nach Leistung einschalten
				let verbleibenderUeberschuss = einspeisung - grundlast;
				for (const v of this.verbraucherListe) {
					if (v.regelTyp === "binary") {
						const mode = await this.getStateAsync(`verbraucher.${this.verbraucherListe.indexOf(v)}_${v.name.replace(/\s+/g, "_")}.steuerungsmodus`);
						if (mode && mode.val === 2) { // Automatik nur schalten
							if (v.leistung <= verbleibenderUeberschuss) {
								await this.schalteVerbraucherMitDelay(v, true);
								verbleibenderUeberschuss -= v.leistung;
							} else {
								await this.schalteVerbraucherMitDelay(v, false);
							}
						}
					}
				}
			}
		} catch (error) {
			this.log.error("Fehler in checkVerbraucher: " + error.message);
		}

		this.checkRunning = false;
	}

	async schalteVerbraucherMitDelay(v, einschalten) {
		if (this.processingLockSchalten) {
			this.log.debug("Verzögerte Schaltaktion blockiert wegen Verarbeitung");
			return;
		}
		this.processingLockSchalten = true;

		if (v.timer) clearTimeout(v.timer);

		v.timer = setTimeout(async () => {
			try {
				const aktuellerWert = await this.getForeignStateAsync(v.datenpunkt);
				const istAn = this.isTrue(aktuellerWert?.val);
				if (einschalten && !istAn) {
					await this.setForeignStateAsync(v.datenpunkt, true);
					this.log.info(`${v.name}: Verbraucher eingeschaltet.`);
				} else if (!einschalten && istAn) {
					await this.setForeignStateAsync(v.datenpunkt, false);
					this.log.info(`${v.name}: Verbraucher ausgeschaltet.`);
				}
			} catch (error) {
				this.log.error("Fehler beim Schalten: " + error.message);
			}
			this.processingLockSchalten = false;
		}, (this.config.schaltDelaySeconds || 2) * 1000);
	}

	async onUnload(callback) {
		try {
			if (this.prozentTimer) clearTimeout(this.prozentTimer);
			for (const v of this.verbraucherListe) {
				if (v.timer) clearTimeout(v.timer);
			}
			callback();
		} catch (e) {
			callback();
		}
	}
}

if (require.main !== module) {
	// Export adapter class for testing
	module.exports = Nulleinspeisung;
} else {
	// Start adapter
	new Nulleinspeisung();
}
