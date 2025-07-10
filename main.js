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
		this.isProcessing = false;
		this.abschaltTimeout = null;
		this.prozentTimer = {}; // Timer für Prozentverbraucher

		this.on("ready", this.onReady.bind(this));
		this.on("stateChange", this.onStateChange.bind(this));
		this.on("unload", this.onUnload.bind(this));
	}

	async onReady() {
		try {
			this.log.info("=== Adapter gestartet - PID: " + process.pid + " ===");

			if (!this.config.einspeisungId) {
				this.log.error("Keine EinspeisungId (Datenpunkt der Einspeiseleistung) gesetzt!");
				return;
			}
			this.einspeisungDatapoint = this.config.einspeisungId;

			// Verbraucher filtern, aktiv und mit Leistung > 0
			this.verbraucherListe = Array.isArray(this.config.verbraucher)
				? this.config.verbraucher.filter((v) => v && v.enabled && v.datenpunkt && v.leistung > 0)
				: [];

			this.log.info("Verbraucher geladen (Reihenfolge): " + this.verbraucherListe.map((v) => v.name).join(", "));

			await this.subscribeForeignStatesAsync(this.einspeisungDatapoint);
			this.log.info("Überwacht: " + this.einspeisungDatapoint);
		} catch (error) {
			this.log.error("Fehler in onReady: " + error.message);
		}
	}

	async onStateChange(id, state) {
		if (id === this.einspeisungDatapoint && state) {
			// Für Prozent-Verbraucher Warte-Timer starten
			for (const v of this.verbraucherListe) {
				if (v.regelTyp === "percent") {
					if (this.prozentTimer[v.datenpunkt]) {
						clearTimeout(this.prozentTimer[v.datenpunkt]);
					}
					const delaySeconds = v.delaySeconds_Prozent || 5;
					this.prozentTimer[v.datenpunkt] = setTimeout(() => {
						this.prozentTimer[v.datenpunkt] = null;
						this.regelProzentVerbraucher(v).catch((e) => this.log.error("Fehler Prozentregelung: " + e));
					}, delaySeconds * 1000);
				}
			}

			// Für binäre Verbraucher Überschuss prüfen
			await this.checkVerbraucher();
		}
	}

	async regelProzentVerbraucher(v) {
		try {
			const jetzt = Date.now();

			const einspeisungState = await this.getForeignStateAsync(this.einspeisungDatapoint);
			const einspeisungWert = Number(einspeisungState?.val) || 0;

			const state = await this.getForeignStateAsync(v.datenpunkt);
			const currentPercent = Number(state?.val) || 0;

			if (einspeisungWert < 0) {
				// Netzbezug, sofort 0%
				if (currentPercent !== 0) {
					await this.setForeignStateAsync(v.datenpunkt, 0);
					this.log.info(`${v.name}: Netzbezug erkannt – auf 0% gesetzt.`);
				}
				return;
			}

			const maxLeistung = v.maxLeistung || v.leistung;
			const grundlast = this.config.grundlast || 0;
			let ueberschuss = einspeisungWert - grundlast;
			if (ueberschuss < 0) ueberschuss = 0;

			let prozentNeu = Math.round((ueberschuss / maxLeistung) * 100);
			if (prozentNeu > 100) prozentNeu = 100;

			const minProzent = v.minProzentStart || 0;
			if (prozentNeu < minProzent) prozentNeu = 0;

			if (prozentNeu !== currentPercent) {
				await this.setForeignStateAsync(v.datenpunkt, prozentNeu);
				this.log.info(
					`${v.name}: Prozent auf ${prozentNeu}% gesetzt (${Math.round((prozentNeu / 100) * maxLeistung)} W).`,
				);
				this.lastPercentChange = jetzt;
			} else {
				this.log.debug(`${v.name}: Prozentänderung nicht nötig (${currentPercent}%).`);
			}
		} catch (error) {
			this.log.error("Fehler in regelProzentVerbraucher: " + error.message);
		}
	}

	async checkVerbraucher() {
		if (this.isProcessing) {
			this.log.debug("checkVerbraucher läuft bereits – überspringe.");
			return;
		}
		this.isProcessing = true;

		try {
			const einspeisungState = await this.getForeignStateAsync(this.einspeisungDatapoint);
			if (!einspeisungState) {
				this.log.warn(`Einspeisungs-Datenpunkt ${this.einspeisungDatapoint} nicht gefunden.`);
				return;
			}

			const einspeisungWert = Number(einspeisungState.val) || 0;
			const grundlast = this.config.grundlast || 100;
			const einschaltgrenze = this.config.einschaltgrenze || 0;
			const abschaltgrenze = this.config.abschaltgrenze || 0;
			const delaySeconds = this.config.delaySeconds || 0;

			this.log.info(
				`Einspeisung: ${einspeisungWert} W (Grundlast: ${grundlast}, Ein: +${einschaltgrenze}, Aus: -${abschaltgrenze})`,
			);

			if (einspeisungWert > grundlast + einschaltgrenze) {
				if (this.abschaltTimeout) {
					clearTimeout(this.abschaltTimeout);
					this.abschaltTimeout = null;
					this.log.info("Abschalt-Timer abgebrochen – Überschuss wieder vorhanden.");
				}
				// Zuschalten nach Reihenfolge
				await this.einschalten(einspeisungWert - grundlast);
			} else if (einspeisungWert < grundlast - abschaltgrenze) {
				if (delaySeconds > 0) {
					this.log.info(`Abschaltung in ${delaySeconds}s geplant...`);
					if (this.abschaltTimeout) clearTimeout(this.abschaltTimeout);

					this.abschaltTimeout = setTimeout(() => {
						this.ausschalten(grundlast - einspeisungWert).catch((e) =>
							this.log.error("Fehler bei Ausschaltung: " + e.message),
						);
						this.abschaltTimeout = null;
					}, delaySeconds * 1000);
				} else {
					await this.ausschalten(grundlast - einspeisungWert);
				}
			} else {
				if (this.abschaltTimeout) {
					clearTimeout(this.abschaltTimeout);
					this.abschaltTimeout = null;
					this.log.info("Abschalt-Timer abgebrochen – Einspeisung im Bereich.");
				}
			}
		} catch (error) {
			this.log.error("Fehler in checkVerbraucher: " + error.message);
		} finally {
			this.isProcessing = false;
		}
	}

	async einschalten(ueberschuss) {
		// Nur binäre Verbraucher einschalten, nacheinander in Reihenfolge
		for (const v of this.verbraucherListe) {
			if (v.regelTyp !== "binary") continue;

			const state = await this.getForeignStateAsync(v.datenpunkt);
			const aktuellAn = state?.val === true || state?.val === "true" || state?.val === 1;

			if (!aktuellAn && ueberschuss >= v.leistung) {
				await this.setForeignStateAsync(v.datenpunkt, true);
				this.log.info(`${v.name} zugeschaltet (Leistung: ${v.leistung}W, Überschuss: ${ueberschuss}W)`);
				ueberschuss -= v.leistung;
			}
		}
	}

	async ausschalten(diff) {
		// Binäre Verbraucher in umgekehrter Reihenfolge ausschalten
		const binaryVerbraucher = this.verbraucherListe.filter((v) => v.regelTyp === "binary").reverse();

		for (const v of binaryVerbraucher) {
			const state = await this.getForeignStateAsync(v.datenpunkt);
			const aktuellAn = state?.val === true || state?.val === "true" || state?.val === 1;

			if (aktuellAn) {
				await this.setForeignStateAsync(v.datenpunkt, false);
				this.log.info(`${v.name} ausgeschaltet (Diff: ${diff}W)`);
			}
		}
	}

	async onUnload(callback) {
		try {
			this.log.info("Adapter wird beendet...");
			for (const t in this.prozentTimer) {
				if (this.prozentTimer[t]) clearTimeout(this.prozentTimer[t]);
			}
			if (this.abschaltTimeout) clearTimeout(this.abschaltTimeout);
			callback();
		} catch {
			callback();
		}
	}
}

if (require.main !== module) {
	module.exports = (options) => new Nulleinspeisung(options);
} else {
	new Nulleinspeisung();
}
