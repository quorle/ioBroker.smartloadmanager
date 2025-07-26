![Logo](admin/smartloadmanager.png)

# ioBroker.smartloadmanager

[![NPM version](https://img.shields.io/npm/v/iobroker.smartloadmanager.svg)](https://www.npmjs.com/package/iobroker.smartloadmanager)
[![Downloads](https://img.shields.io/npm/dm/iobroker.smartloadmanager.svg)](https://www.npmjs.com/package/iobroker.smartloadmanager)
![Number of Installations](https://iobroker.live/badges/smartloadmanager-installed.svg)
![Current version in stable repository](https://iobroker.live/badges/smartloadmanager-stable.svg)

[![NPM](https://nodei.co/npm/iobroker.smartloadmanager.png?downloads=true)](https://nodei.co/npm/iobroker.smartloadmanager/)

**Tests:** ![Test and Release](https://github.com/quorle/ioBroker.smartloadmanager/workflows/Test%20and%20Release/badge.svg)

## 🔧 Beschreibung

Der Adapter **"Nulleinspeisung"** überwacht deine aktuelle Einspeiseleistung (PV-Überschuss) und schaltet definierte Verbraucher dynamisch zu oder ab. Ziel ist es, die Einspeisung ins Netz auf Null zu reduzieren, indem überschüssige Energie lokal verbraucht wird.

---

## 🚀 Funktionen

- ✅ Überwachung eines konfigurierbaren Einspeisungs-Datenpunkts
- ✅ Dynamische Zuschaltung von Verbrauchern bei Überschuss
- ✅ Dynamische Abschaltung bei Defizit oder Netzbezug
- ✅ Unterstützt **binary** (Ein/Aus) und **percent** (Prozentregelbare) Verbraucher
- ✅ Prozentregelung (z.B. Wallboxen) mit linearer Anpassung basierend auf Überschuss
- ✅ Reihenfolgenverwaltung (Last-In-First-Out Abschaltung)
- ✅ Konfigurierbare Grundlast, Ein- und Abschaltgrenzen sowie Schaltverzögerungen
- ✅ Hysterese-Vermeidung durch separate Ein- und Ausschaltgrenzen
- ✅ Umschaltbare Vorzeichenlogik für Einspeisewert (negativ = Einspeisung / positiv = Netzbezug oder umgekehrt)
- ✅ Steuerungsmodus für prozentuale Verbraucher:
  0 = Aus (Verbraucher aus / 0%)
  1 = Manuell Ein (Verbraucher an / 100%)
  2 = Automatik (automatisches Schalten/Regeln durch den Adapter)
- ✅ Für Binärverbraucher erfolgt automatische Steuerung nur, wenn Steuerungsmodus auf 2 (Automatik) steht.
- ✅ Automatische Erstellung von Objekten/States pro Verbraucher inklusive neuer Settings (z.B. Maximalleistung, Verzögerungs-Override)
- ✅ Checkbox „Ausschalten nur zu Ausschaltzeit“

---

## ⚙️ Konfiguration

### 🔹 Haupteinstellungen

| Einstellung                 | Beschreibung                                                                          |
| --------------------------- | ------------------------------------------------------------------------------------- |
| **Einspeisungs-Datenpunkt** | Objekt-ID des Datenpunkts, der deine Einspeisung in Watt liefert (z.B. PV-Überschuss) |
| **Grundlast**               | Dauerhafter Eigenverbrauch, der immer abgezogen wird (z.B. Router, Standby-Geräte)    |
| **Einschaltgrenze**         | Überschuss in Watt, ab dem Verbraucher zugeschaltet werden                            |
| **Abschaltgrenze**          | Unterschuss in Watt, ab dem Verbraucher abgeschaltet werden                           |
| **Verzögerung (Sekunden)**  | Zeitverzögerung bei der Abschaltung, um kurzfristige Schwankungen abzufangen          |
| **Einspeisewert negativ**   | Legt fest, wie der Einspeisewert interpretiert wird:                                  |
|                             | Wenn **aktiviert** (true), gilt:                                                      |
|                             | **- negativ = Einspeisung**                                                           |
|                             | **- positiv = Netzbezug**                                                             |

Wenn deaktiviert (false), gilt:

- negativ = Netzbezug
- positiv = Einspeisung

---

### 🔹 Verbraucher

| Feld                           | Beschreibung                                                                                        |
| ------------------------------ | --------------------------------------------------------------------------------------------------- |
| **Aktiv**                      | Aktiviert oder deaktiviert den Verbraucher in der Steuerung                                         |
| **Name**                       | Freie Bezeichnung für den Verbraucher                                                               |
| **Steuer-Datenpunkt**          | Objekt-ID, die Ein/Aus oder Prozentwert des Verbrauchers steuert                                    |
| **Gesamtleistung**             | Leistung in Watt, die bei Zuschaltung abgerufen wird                                                |
| **Einschaltung**               | Mindestüberschuss in Watt, der für die Zuschaltung erforderlich ist                                 |
| **Abschaltung**                | Unterschreitungswert in Watt, bei dem der Verbraucher abgeschaltet wird                             |
| **Regeltyp**                   | „Ein/Aus“ für binary Verbraucher oder „Prozentregelung“ für stufenlos regelbare Verbraucher         |
| **DelaySeconds_Prozent**       | Verzögerung in Sekunden bei Rückregelung von Prozentwerten (z.B. Wallbox langsam herunterregeln)    |
| **Maximalleistung (Watt)**     | Maximalleistung des Verbrauchers, dient als Referenzwert für die prozentuale Regelung               |
| **Schaltverzögerung Override** | Optionaler individueller Override der globalen Schaltverzögerung in Sekunden für diesen Verbraucher |
| **Checkbox Ausschalten**       | Optionale Checkbox, um Verbraucher nur zur eingestellten Ausschaltzeit abzuschalten                 |

---

### ⚠️ **Neue Settings im Detail**

#### 📝 **Maximalleistung (Watt)**

- Gibt die **maximale elektrische Leistung des Verbrauchers** an.
- Wichtig für **percent-Verbraucher** (z.B. Wallboxen) zur korrekten Berechnung des Sollwerts.
- **Beispiel:** Wallbox mit 11000W → Adapter berechnet den % Sollwert aus Überschuss / 11000.

#### 📝 **Schaltverzögerung Override (Sekunden)**

- Optionaler **verbraucherspezifischer Override** für die Schaltverzögerung.
- Falls gesetzt, überschreibt dieser Wert die globale Verzögerung **nur für diesen Verbraucher**.
- **Verwendung:** z.B. Verbraucher A schaltet mit 10s Verzögerung, Verbraucher B mit sofortiger Zuschaltung (0s).

#### 📝 **Ein- und Ausschaltzeiten**

- **Einschaltzeit:** Hier wird die Uhrzeit in HH:MM eingetragen, ab wann die Regleung für den Verbrauchen gestartet werden soll.
- **Ausschaltzeit:** Hier wird die Uhrzeit in HH:MM eingetragen, ab wann die Regleung für den Verbrauchen gestopt werden soll.
- **Checkbos "Ausschalten nur zu Ausschaltzeit":** HWenn diese aktiv ist, wird der Verbraucher zur Einschaltzeit und passendem
  Überschuss eingeschaltet, jedoch nicht mehr bei Unterschreitung des Einspeisewertes abgeschaltet. Die Abschaltung erfolgt nur duch die
  duch die Abschaltzeit.

---

## 📊 Funktionsweise

1. **Vorzeichenlogik (Einspeisewert negativ)**  
   Abhängig von der Aktivierung der Einstellung „Einspeisewert negativ“ wird der Messwert wie folgt interpretiert:

| Einstellung aktiv (true) Einstellung deaktiviert (false) |                       |
| -------------------------------------------------------- | --------------------- |
| Negativ = Einspeisung                                    | Negativ = Netzbezug   |
| Positiv = Netzbezug                                      | Positiv = Einspeisung |

2. **Einspeisung > Grundlast + Einschaltgrenze**  
   ➔ Verbraucher werden gemäß aufsteigender Leistungsgröße zugeschaltet, soweit der Überschuss ausreicht.

3. **Einspeisung < Grundlast - Abschaltgrenze**  
   ➔ Nach konfigurierter Verzögerung werden Verbraucher in umgekehrter Zuschalt-Reihenfolge abgeschaltet, bis das Defizit ausgeglichen ist.

4. **Prozentregelung (z.B. Wallbox)**  
   ➔ Geräte mit „Regeltyp: Prozentregelung“ erhalten eine lineare prozentuale Steuerung basierend auf dem aktuellen Überschuss im Verhältnis zur konfigurierten Maximalleistung.  
   ➔ Bei Überschuss > Maximalleistung wird auf 100 % geregelt, bei niedrigem Überschuss entsprechend heruntergeregelt bis ggf. auf 0 %.  
   ➔ Das Rückregeln kann mit **DelaySeconds_Prozent** verzögert werden, um sanfte Übergänge zu gewährleisten.

5. **Innerhalb Hysterese**  
   ➔ Keine Änderung; laufende Abschalt-Timer werden abgebrochen.

6. **Die Steuerung berücksichtigt den Steuerungsmodus der Verbraucher:**  
   ➔ Nur bei Modus 2 (Automatik) werden Verbraucher automatisch geschaltet bzw. geregelt.  
   ➔ Bei Modus 0 oder 1 erfolgt keine automatische Änderung.

---

## 💡 Beispiel

| Parameter       | Wert   |
| --------------- | ------ |
| Grundlast       | 100 W  |
| Einschaltgrenze | 50 W   |
| Abschaltgrenze  | 50 W   |
| Einspeisung     | 500 W  |
| Wallbox max     | 3500 W |

**Berechnung (Wallbox, Prozentregelung):**

- Überschuss = 500 - 100 = 400 W
- 400 W / 3500 W = ca. 11 % Ladeleistung Wallbox wird auf 11 % gesetzt (abhängig von unterstütztem minimalem Ladestrom der Wallbox).

---

## 🔍 Bekannte Einschränkungen

- Keine Priorisierung außerhalb der Leistungsgröße implementiert
- Keine automatische Unterstützung für kombinierte Geräte (z.B. WP mit stufenlosem Modus + Heizstab)
- Kein persistentes State-Tracking bei Adapter-Neustart
- Minimal-/Maximalgrenzen der Prozentregelung müssen ggf. auf Geräteeigenschaften angepasst werden

---

## 🛠️ Zukünftige Features (Roadmap)

- Blackout-Schutzschwelle (alle Verbraucher sofort aus)
- Zeitabhängige Zuschaltlogik (z.B. nach PV-Erwartung)
- Mindestprozentwerte für Wallboxen (z.B. 6A/10A Minimum)
- Implementierung von **Schaltverzögerung Override** zur aktiven Nutzung des State-Werts

---

## Changelog

<!--
	Placeholder for the next version (at the beginning of the line):
	###**WORK IN PROGRESS**
-->
### 0.0.1-alpha.7 (2025-07-26)

- (quorle) Readme changed

### 0.0.1-alpha.6 (2025-07-26)

- (quorle) Readme changed

### 0.0.1-alpha.5 (2025-07-26)

- (quorle) repush to "https://github.com/quorle/ioBroker.smartloadmanager"

### 0.0.1-alpha.4 (2025-07-26)

- (quorle) Rename to **smartloadmanager**
- (quorle) Battery management added

### 0.0.1-alpha.3 (2025-07-25)

- (quorle) Turn-off time changed. It will only turn off at the turn-off time (formerly "zero feed-in")
- (quorle) Readme changed (formerly "zero feed-in")

### 0.0.1-alpha.2 (2025-07-24)

- (quorle) Added on and off times (formerly "zero feed-in")
- (quorle) Objects adjusted (formerly "zero feed-in")
- (quorle) code adapted (formerly "zero feed-in")

### 0.0.1-alpha.1 (2025-07-23)

- (quorle) Control mode for consumers added (formerly "zero feed-in")

### 0.0.1-alpha.0 (2025-07-15)

- (quorle) Readme changed (formerly "zero feed-in")

## License

MIT License

Copyright (c) 2025 quorle <quorle12@gmail.com>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
