![Logo](admin/smartloadmanager.png)

# ioBroker.smartloadmanager

[![NPM version](https://img.shields.io/npm/v/iobroker.smartloadmanager.svg)](https://www.npmjs.com/package/iobroker.smartloadmanager)
[![Downloads](https://img.shields.io/npm/dm/iobroker.smartloadmanager.svg)](https://www.npmjs.com/package/iobroker.smartloadmanager)
![Number of Installations](https://iobroker.live/badges/smartloadmanager-installed.svg)
![Current version in stable repository](https://iobroker.live/badges/smartloadmanager-stable.svg)

[![NPM](https://nodei.co/npm/iobroker.smartloadmanager.png?downloads=true)](https://nodei.co/npm/iobroker.smartloadmanager/)

**Tests:** ![Test and Release](https://github.com/quorle/ioBroker.smartloadmanager/workflows/Test%20and%20Release/badge.svg)

## 🔧 Description

The **smartloadmanager** adapter is used for dynamic control of loads based on a PV feed-in value. The goal is to consume surplus electricity locally, thus minimizing or completely avoiding feed-in to the public grid. It supports both on/off loads and percentage-controlled devices and battery storage.

---

## Documentation

- [English documentation](./docs/en/README.md)
- [Deutsche Dokumentation](./docs/de/README.md)

---

## Changelog

<!--
	Placeholder for the next version (at the beginning of the line):
	### **WORK IN PROGRESS**
-->

### **WORK IN PROGRESS**

- (quorle) Added a checkbox for activating consumers from the settings to the object tree

### 0.0.8 (2025-10-03)

- (quorle) Fix for binary consumers that do not turn off
- (quorle) Fix for heating elements that are not switched off at max temperature

### 0.0.7 (2025-09-09)

- (quorle) modified Readme
- (quorle) German and English description created
- (quorle) chore: cleanup devDependencies
- (quorle) Add "label" to jsonConfig.json everywhere
- (quorle) Fixed bugs in timeouts in functions
- (quorle) setTimeout/setInterval allowed maximum values ​​implemented
- (quorle) adapter-core 3.2.3 to 3.3.2 updated
- (quorle) eslint-config 2.0.2 to 2.1.0 updated
- (quorle) testing 5.0.4 to 5.1.0 updated

### 0.0.6 (2025-09-03)

- (quorle) Adjustments package.json
- (quorle) Code changed

### 0.0.3 (2025-09-03)

- (quorle) Adjustments package.json
- (quorle) Code changed

### 0.0.2 (2025-09-03)

- (quorle) Adjustments package.json
- (quorle) Code changed

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
