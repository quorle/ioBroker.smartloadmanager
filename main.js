// @ts-nocheck
"use strict";

/**
 * Adapter: nulleinspeisung
 * Autor: dein Projekt
 * Beschreibung:
 * Dynamische Zuschaltung und Rückregelung von Verbrauchern
 * inklusive Prozentregelung (z.B. Wallboxen) ohne Überschreiben von State-Änderungen.
 */

const utils = require("@iobroker/adapter-core");

class Nulleinspeisung extends utils.Adapter {
	constructor(options) {
		super({
			...options,
			name: "nulleinspeisung",
		});

		this.verbraucherListe = [];
		this.einspeisungDatapoint = null;
		this.prozentTimer = {};
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

			// Prüfe Konfiguration
			if (!this.config.einspeisungId) {
				this.log.error("Keine EinspeisungId gesetzt!");
				return;
			}
			this.einspeisungDatapoint = this.config.einspeisungId;

			// Lade konfigurierte Verbraucher
			this.verbraucherListe = Array.isArray(this.config.verbraucher)
				? this.config.verbraucher.filter((v) => v && v.enabled && v.datenpunkt && v.leistung > 0)
				: [];

			this.log.info("Verbraucher geladen: " + this.verbraucherListe.map((v) => v.name).join(", "));

			// Prüfe Existenz der Verbraucher-Datenpunkte
			await this.checkAndCreateVerbraucherObjects();

			// Initialisiere Status der Verbraucher (eingeschaltet / ausgeschaltet)
			await this.initializeVerbraucherStatus();

			// Erstelle Datenpunkte für alle Properties der Verbraucher
			await this.createVerbraucherStates();

			// Abonniere States
			await this.subscribeStatesAsync("*");

			// Abonniere Einspeisung-Datenpunkt
			await this.subscribeForeignStatesAsync(this.einspeisungDatapoint);
		} catch (error) {
			this.log.error("Fehler in onReady: " + error.message);
		}
	}

	/**
	 * Erstellt alle States pro Verbraucher, überschreibt jedoch KEINE bestehenden Werte.
	 */
	async createVerbraucherStates() {
		for (let i = 0; i < this.verbraucherListe.length; i++) {
			const v = this.verbraucherListe[i];
			const channelId = `verbraucher.${i}_${v.name.replace(/\s+/g, "_")}`;

			// Channel anlegen, falls nicht vorhanden
			await this.setObjectNotExistsAsync(channelId, {
				type: "channel",
				common: { name: v.name },
				native: {},
			});

			// Alle Properties als State anlegen (ohne Überschreiben bestehender Werte)
			for (const [key, value] of Object.entries(v)) {
				await this.setObjectNotExistsAsync(`${channelId}.${key}`, {
					type: "state",
					common: {
						name: `${v.name} ${key}`,
						type: typeof value,
						role: "state",
						read: true,
						write: true,
					},
					native: {},
				});

				// Schreibe initial nur, wenn State-Wert noch nicht existiert
				const existing = await this.getStateAsync(`${this.namespace}.${channelId}.${key}`);
				if (!existing) {
					await this.setStateAsync(`${channelId}.${key}`, { val: value, ack: true });
					this.log.debug(`Initialer Wert gesetzt: ${channelId}.${key} = ${value}`);
				}
			}
		}
	}

	/**
	 * Wird bei jeder State-Änderung aufgerufen.
	 */
	async onStateChange(id, state) {
		if (state && !state.ack) {
			this.log.debug(`State geändert: ${id} => ${state.val}`);

			// Prüfe, ob State zu einem Verbraucher gehört
			const match = id.match(/verbraucher\.(\d+)_.*?\.(.+)/);
			if (match) {
				const index = parseInt(match[1]);
				const key = match[2];

				if (this.verbraucherListe[index] && key in this.verbraucherListe[index]) {
					this.verbraucherListe[index][key] = state.val;

					// Aktualisiere auch in der Adapterkonfiguration
					if (Array.isArray(this.config.verbraucher) && this.config.verbraucher[index]) {
						this.config.verbraucher[index][key] = state.val;
						this.log.debug(
							`Adapterkonfiguration aktualisiert: verbraucher[${index}].${key} = ${state.val}`,
						);
					}
				}
			}
		}

		// Reagiere auf Änderung der Einspeisung
		if (id === this.einspeisungDatapoint && state) {
			if (this._lastEinspeisungWert === state.val) return;
			this._lastEinspeisungWert = state.val;

			if (this.stateChangeTimeout) clearTimeout(this.stateChangeTimeout);

			this.stateChangeTimeout = setTimeout(async () => {
				try {
					// Starte Prozentregelung mit Delay
					for (const v of this.verbraucherListe) {
						if (v.regelTyp === "percent") {
							if (this.prozentTimer[v.datenpunkt]) clearTimeout(this.prozentTimer[v.datenpunkt]);
							const delay = v.delaySeconds_Prozent || 5;
							this.prozentTimer[v.datenpunkt] = setTimeout(() => {
								this.prozentTimer[v.datenpunkt] = null;
								this.regelProzentVerbraucher(v).catch((e) =>
									this.log.error("Fehler Prozentregelung: " + e),
								);
							}, delay * 1000);
						}
					}

					await this.checkVerbraucher();
				} catch (error) {
					this.log.error("Fehler in onStateChange: " + error.message);
				}

				this.stateChangeTimeout = null;
			}, 50);
		}
	}

	// === Unveränderte Hilfsmethoden ===

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
			const einspeisungState = await this.getForeignStateAsync(this.einspeisungDatapoint);
			let einspeisungWert = Number(einspeisungState?.val) || 0;

			const state = await this.getForeignStateAsync(v.datenpunkt);
			const currentPercent = Number(state?.val) || 0;

			let netzbezug = false;

			if (this.config.feedinNegativ) {
				if (einspeisungWert >= 0) netzbezug = true;
				else einspeisungWert = -einspeisungWert;
			} else {
				if (einspeisungWert < 0) {
					netzbezug = true;
					einspeisungWert = -einspeisungWert;
				}
			}

			if (netzbezug) {
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
			prozentNeu = Math.min(100, Math.max(prozentNeu, v.minProzentStart || 0));

			if (prozentNeu !== currentPercent) {
				await this.setForeignStateAsync(v.datenpunkt, prozentNeu);
				this.log.info(
					`${v.name}: Prozent auf ${prozentNeu}% gesetzt (${Math.round((prozentNeu / 100) * maxLeistung)} W).`,
				);
			}
		} catch (error) {
			this.log.error("Fehler in regelProzentVerbraucher: " + error.message);
		}
	}

	async checkVerbraucher() {
		if (this.checkRunning) {
			this.log.debug("checkVerbraucher bereits aktiv. Überspringe.");
			return;
		}
		this.checkRunning = true;

		try {
			const grundlast = this.config.grundlast || 0;
			const hysterese = 0.1;

			const berechneUeberschuss = async () => {
				const state = await this.getForeignStateAsync(this.einspeisungDatapoint);
				let einspeisungWert = state ? Number(state.val) : 0;

				let netzbezug = false;

				if (this.config.feedinNegativ) {
					if (einspeisungWert >= 0) netzbezug = true;
					else einspeisungWert = -einspeisungWert;
				} else {
					if (einspeisungWert < 0) {
						netzbezug = true;
						einspeisungWert = -einspeisungWert;
					}
				}

				if (netzbezug) {
					this.log.debug(`Netzbezug erkannt (${einspeisungWert} W).`);
					return -einspeisungWert;
				}

				let ueberschuss = einspeisungWert - grundlast;
				const summeLeistung = this.eingeschalteteVerbraucher.reduce((acc, v) => acc + v.leistung, 0);
				ueberschuss -= summeLeistung;

				this.log.debug(`Aktueller Überschuss: ${ueberschuss} W`);
				return ueberschuss;
			};

			let ueberschuss = await berechneUeberschuss();

			while (ueberschuss < 0 && this.eingeschalteteVerbraucher.length > 0) {
				const v = this.eingeschalteteVerbraucher.pop();
				const stateV = await this.getForeignStateAsync(v.datenpunkt);

				if (this.isTrue(stateV?.val)) {
					await this.schalteVerbraucherMitDelay(v, false);
					ueberschuss = await berechneUeberschuss();
				}
			}

			const ausschaltbare = this.verbraucherListe
				.filter((v) => v.regelTyp === "binary" && !this.eingeschalteteVerbraucher.includes(v))
				.sort((a, b) => a.leistung - b.leistung);

			for (const v of ausschaltbare) {
				if (this.config.feedinNegativ) ueberschuss = await berechneUeberschuss();

				if (ueberschuss >= v.leistung * (1 + hysterese)) {
					await this.schalteVerbraucherMitDelay(v, true);
					if (!this.eingeschalteteVerbraucher.includes(v)) this.eingeschalteteVerbraucher.push(v);
					if (!this.config.feedinNegativ) ueberschuss -= v.leistung;
				}
			}
		} catch (err) {
			this.log.error("Fehler in checkVerbraucher: " + err);
		}

		this.checkRunning = false;
	}

	async schalteVerbraucherMitDelay(v, einschalten) {
		if (this.processingLockSchalten) {
			this.log.debug(`Schaltvorgang für ${v.name} gesperrt (Lock aktiv).`);
			return;
		}
		this.processingLockSchalten = true;

		const aktion = einschalten ? "einschalten" : "ausschalten";
		this.log.debug(`${v.name}: ${aktion} in ${this.config.delaySeconds}s geplant...`);
		await new Promise((resolve) => setTimeout(resolve, this.config.delaySeconds * 1000));

		await this.setForeignStateAsync(v.datenpunkt, einschalten).catch((e) =>
			this.log.error(`Fehler beim ${aktion} von ${v.name}: ${e.message}`),
		);

		this.log.debug(`${v.name}: ${aktion} durchgeführt.`);
		this.processingLockSchalten = false;
	}

	onUnload(callback) {
		try {
			if (this.stateChangeTimeout) clearTimeout(this.stateChangeTimeout);
			for (const k in this.prozentTimer) {
				if (this.prozentTimer[k]) clearTimeout(this.prozentTimer[k]);
			}
			callback();
		} catch (e) {
			callback();
		}
	}
}

if (require.main !== module) {
	module.exports = (options) => new Nulleinspeisung(options);
} else {
	new Nulleinspeisung();
}
