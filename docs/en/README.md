![Logo](../../admin/smartloadmanager.png)

# ioBroker.smartloadmanager

## Version 0.2.0 examples

Requires Node.js >=22.19.0. Device commands use `ack: false`; the device adapter
provides the acknowledgement. Feed-in must represent grid connection power in watts.
Enable `feedinNegativ` when export is negative. Baseload is an additional reserve;
do not subtract household consumption twice if it is already included in the meter reading.

### Binary loads and heating

Example: `performance: 1000`, `switchOnPoint: 1200`, `switchOffPoint: 0`,
`switchOnDelay: 20`, `switchOffDelay: 10`. A 1200 W surplus after baseload starts
the on timer. Import or surplus below the off threshold starts the off timer.
`minimumOnMinutes: 10` and `minimumOffMinutes: 5` reduce cycling; import above
`forecastMaxGridImport` overrides minimum runtime. Set minimum times to 0 to disable them.

Use `datapoint` for boolean switching and `numericDatapoint` for numeric 0/1.
Heating consumers additionally support temperature, enable and heartbeat inputs.
Maximum temperature and missing enable/heartbeat prevent activation.
Heartbeat checks the input's truth value, not the age of its last update.
A missing or nonfinite configured temperature sensor prevents activation and
stops automatic heating. “Switch off only at switch-off time” intentionally
disables normal surplus shutdown until the time window ends; heating protection remains active.

### Percentage and battery control

A 2000 W percent consumer at 50% consumes 1000 W. With 400 W additional export,
the target becomes 70%. With 200 W import it becomes 40%. Below `minPercentStart`,
the target becomes 0%. Disabled consumers are not regulated. This calculation
assumes the load is included in the grid meter reading.

Configure a battery's `batterySetpoint`, `performance`, and optional `batterySOC`
and `batteryTargetSOC`. With 800 W surplus and a 1500 W rating, the charging command
is 800 W. Reaching target SOC sets charging power to 0. The optional global battery
mode datapoint uses 0 (off), 1 (target reached), and 2 (charging); verify that these
values match the device adapter.

`controlMode`: 0 = off, 1 = manual on, 2 = automatic. Manual on sets a percent load
to 100% or battery charging power to its configured rating. Automatic regulators
respect manual modes.
Battery control includes already requested charging power and corrects it by the
measured grid surplus. `batteryDelaySeconds` and `delaySecondsProzent` remain
effective during frequent meter updates; 0 means immediate regulation.
Missing configured SOC/target SOC values stop charging. Time windows are also
checked every 15 seconds. Disabling a consumer cancels pending switches but leaves
its existing device state unchanged; use `controlMode: 0` to switch it off.

### PV forecast example

Enable `enableForecast`, select e.g. `pvforecast.0.summary.JSONData` as
`forecastJsonDatapoint`, and enable `useForecast` for the consumer.
The expected JSON array uses Unix timestamps in milliseconds:

```js
const now = Date.now();
const forecast = [0, 15, 30, 45].map(minutes => ({
    t: now + minutes * 60000,
    y: 3.5,
}));
// JSON.stringify(forecast), with forecastPowerUnit = "kW"
```

With 500 W baseload this gives 3000 W forecast surplus, reduced to 2400 W at
`forecastSafetyPercent: 80`. A 2000 W consumer requires a sustained
`forecastMinMinutes: 30` window starting within `forecastMaxStartMinutes: 30`.
At `forecastMinCurrentPercent: 50`, at least 1000 W must already be available.

`forecastBridgeMinutes: 5` limits dip bridging; `forecastMaxGridImport: 100`
prevents bridging above 100 W import. Past forecast points are ignored.
Select `W` explicitly for small watt readings: automatic detection treats values
up to 100 as kW. Inspect `forecast.*` and each consumer's forecast status states.

Time windows may cross midnight (22:00–06:00). Equal start/end times mean all day.
Automated tests use simulated devices; no physical device installation was available.

## 🔧 Description

The **smartloadmanager** adapter dynamically controls consumers based on a PV feed-in value.  
The goal is to consume surplus power locally and minimize or completely avoid feeding into the public grid.  
It supports binary consumers, percentage-controllable devices, and battery storage systems.

---

## 🚀 Features

- ✅ Monitoring of a configurable feed-in datapoint
- ✅ Dynamic switching on of consumers in case of surplus
- ✅ Dynamic switching off in case of deficit or grid consumption
- ✅ Supports **binary**, **percent**, **heating** and **battery** consumers
- ✅ Percentage control with delay (smooth down-regulation), optionally configurable per consumer
- ✅ Dynamic charging power for battery storage with target SOC
- ✅ Time windows for on/off logic per consumer (incl. "only at off-time")
- ✅ Automatic object creation with extended information per consumer
- ✅ Control mode: Off / Manual On / Auto per consumer
- ✅ Hysteresis control via separate on/off thresholds
- ✅ Consumer-specific switching delay (override of global setting)
- ✅ Global battery switching delay (`batteryDelaySeconds`)
- ✅ Write check for battery control mode (debug output in log)
- ✅ **Delayed switching via timers** for on and off
- ✅ **Display of active timers in debug log** with remaining time
- ✅ Optional **notifications** for binary, percent, battery and heating (Telegram / Gotify)
- ✅ Optimization for 0/1 datapoints (boolean or numeric 0/1 control)
- ✅ Detailed logging of all timers, surpluses and switching operations
- ✅ Notifications per consumer type (Binary, Percent, Battery, Heating), optionally enabled
- ✅ Heating/immersion heater control with temperature, enable and heartbeat checks

---

## ⚙️ Configuration

### 🔹 Main settings

| Setting                            | Description                                                                     |
| ---------------------------------- | ------------------------------------------------------------------------------- |
| **Feed-in datapoint**              | Object ID of the feed-in value (e.g. PV surplus)                                |
| **Base load**                      | Always subtracted from feed-in value (e.g. standby consumption)                 |
| **Switch-on threshold**            | Threshold in watts at which consumers are switched on                           |
| **Switch-off threshold**           | Threshold in watts at which consumers are switched off                          |
| **Delay (seconds)**                | Delay for binary switching (hysteresis smoothing)                               |
| **Delay percent (s)**              | Global delay for down-regulation of percent consumers (e.g. wallbox)            |
| **Delay battery (s)**              | Global delay for battery control                                                |
| **Feed-in negative**               | If active: negative = feed-in / positive = grid consumption                     |
| **Battery control mode datapoint** | Optional datapoint for battery mode switching (Auto/Manual/Off)                 |
| **Notifications**                  | Enable notifications for Binary / Percent / Battery / Heating (Telegram/Gotify) |

---

### 🔹 Consumers

| Field                               | Description                                                           |
| ----------------------------------- | --------------------------------------------------------------------- |
| **Name**                            | Display name                                                          |
| **Active**                          | Enables control for this consumer                                     |
| **Rule type**                       | `"binary"`, `"percent"`, `"battery"`, `"heating"`                     |
| **Control datapoint**               | ID to switch or regulate, supports 0/1 datapoints                     |
| **Power [W]**                       | Realistic electrical power of the consumer                            |
| **Switch-on threshold [W]**         | Required surplus for activation                                       |
| **Switch-off threshold [W]**        | Lower limit for deactivation                                          |
| **Max power [W]**                   | Reference value for percentage control                                |
| **Delay percent [s]**               | Optional delay for down-regulation for this consumer only             |
| **Delay override [s]**              | Consumer-specific switching delay (e.g. immediate switching possible) |
| **Switch-on time (HH:MM)**          | Time when control may start                                           |
| **Switch-off time (HH:MM)**         | Time when control must end                                            |
| **Only off at time**                | Checkbox: switch off only at configured time                          |
| **batterySetpoint (battery only)**  | Datapoint where desired charging power is written                     |
| **batterySOC / targetSOC**          | Optional: SOC & target SOC to stop charging at target                 |
| **Timer / TimerEnd**                | Internal timer for delayed switching, remaining time visible in log   |
| **minTemperature / maxTemperature** | Lower/upper threshold for heating operation                           |
| **temperatureDatapoint (heating)**  | Temperature datapoint for min/max checks                              |
| **enableDatapoint (heating)**       | Optional datapoint: heating only allowed if true                      |
| **heartbeatDatapoint (heating)**    | Optional: must cyclically deliver true, otherwise switched off        |

---

## 🔋 Battery storage support

- Consumers with `"ruletype": "battery"` control the charging setpoint based on current surplus.
- If `batterySOC` and `batteryTargetSOC` are set, charging stops at target SOC.
- Optional `batteryControlModeDatapoint`:
    - `0 = Off`, `1 = Manual`, `2 = Auto`
- Control is only active within configured time windows.
- Control runs on every feed-in update, after configured delay (`batteryDelaySeconds`).
- Delays for all consumer types (binary, percent, battery) can be set globally or per consumer.
- Detailed logging and optional notifications for battery switching.

---

## 🌡️ Heating support

- Consumers with `"ruletype": "heating"` are intended for immersion heaters or similar devices.
- Control only occurs when:
    - Current temperature is below `maxTemperature`
    - Optional: above `minTemperature`
    - Optional: `enableDatapoint` is active
    - Optional: `heartbeatDatapoint` is valid
- If conditions are not met, switching is stopped immediately and timers are canceled.
- Supports on/off timers (`onTimerRemaining` / `offTimerRemaining`) with remaining time display.
- Detailed logging and optional notifications for heating consumers.

---

## 🧠 Control logic

1. **Feed-in datapoint value is interpreted** (positive = grid consumption or feed-in, depending on config)
2. **Surplus > base load + switch-on threshold**:  
   → Consumers are switched on (binary) in ascending order of power
3. **Deficit < base load - switch-off threshold**:  
   → Consumers are switched off in reverse order
4. **Percent consumers**:  
   → % = surplus / max power  
   → Adjusted after delay (global or per consumer)  
   → Optional overrides possible
5. **Battery consumers**:  
   → Charging power = min(surplus, max power), if target SOC not reached  
   → Delay via `batteryDelaySeconds` or per consumer
6. **Time window check for all consumers**
7. **Control only in mode Auto (2)**
8. **Delayed switching via timers** (cancel/restart on updates, remaining time visible in log)
9. **Optional notifications for all switching/regulation types**
10. **0/1 datapoint optimization** (boolean or numeric 0/1 supported)
11. **Detailed logging of all switching and surplus values**
12. **Heating logic**: switch only within temp ranges and with valid enable/heartbeat datapoints

---

## 💡 Example: Wallbox

| Parameter | Value   |
| --------- | ------- |
| Feed-in   | 1000 W  |
| Base load | 100 W   |
| Max power | 11000 W |

**Calculation:**

- Surplus: 1000 – 100 = 900 W
- Percent: 900 / 11000 ≈ 8.2 % → Wallbox set to 8 %

---

## 📋 Object structure

Each consumer gets its own channel with the following states:

- `.controlMode` → 0 = Off, 1 = Manual, 2 = Auto
- `.switchOnTime` / `.switchOffTime`
- `.alwaysOffAtTime` → true/false
- `.performance`, `.switchOnPoint`, `.switchOffPoint`
- `.batterySetpoint` (battery only)
- `.temperatureDatapoint` (heating only)
- `.onTimerRemaining / .offTimerRemaining` → Remaining time for timers
- `.timer` → internal timer for delayed switching
- `.timerEnd` → timestamp when timer expires (for log)

---

## 🚫 Limitations

- No SOC history, no long-term logic
- No multiple use of identical datapoints
- Battery control based only on feed-in, not discharge power
- Heating without direct power measurement – only thresholds and enable checks

---

## 🛣️ Future features

- ~~PV forecast-based control (beta)~~
- Combined consumer support
- ~~Prioritization profiles~~
- Overheating or fault handling per device
- ~~Min/max percentage limits~~
- Configurable group or room logic

---

## PV forecast control

SmartLoadManager can use `pvforecast.<instance>.summary.JSONData`. Enable forecast control, select the JSON data point and enable it for the desired consumers.

The adapter evaluates a continuous forecast window instead of a single value. A configurable safety factor reduces optimistic forecasts. Forecast-assisted switch-on additionally requires part of the required power to be present as real surplus. Short drops can be bridged for a limited time, but only up to the configured maximum grid import.

Minimum run and off times prevent rapid cycling. Forecast decisions never override time windows, heating temperature limits, hardware enable/heartbeat signals or battery SOC limits.

Recommended starting values: 80% safety factor, 30-minute forecast window, 30-minute maximum lead time, 50% current-surplus requirement, 5-minute dip bridging, 100 W maximum grid import and 10/5-minute minimum run/off times.
