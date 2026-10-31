/*
  Hardware link for the Bite Force Monitor UI.
  Talks to firmware/bite_force_esp32s3 over USB serial (Web Serial) or BLE (Web Bluetooth),
  both available in desktop Chrome / Edge. Open the page from http://localhost or file://.

  Each channel is a divider 3V3 -> R_pu -> node(ADC) -> sensor -> GND. The UI shows the node
  voltage as read, with no sensor model. Pressing lowers the node voltage, so the hotspots use
      drop % = 100 * (base[i] - V) / Vcc        base = Vcc, or the voltage stored by HW.tare()
  which is linear in the measured voltage.

  API (window.HW):
    connectSerial(), connectBLE(), disconnect()   promises
    connected, mode ("USB" | "BLE" | null), fps, info { n, rpu, vcc, hz }
    ready     -> true once the first frame of this connection has arrived; until then volts() is meaningless
    volts()   -> node voltage per channel (V)  values() -> drop % per channel (0..100)
    raw()     -> last unsmoothed frame (mV)    tare() (ignored until ready), on(fn)   fn(HW) is called on every status change
    range     -> colour full scale (drop %) for live data; setRange(r) changes and stores it
    feed(line)                                  inject a serial line, e.g. for testing without hardware
    startRec(), stopRec()                       record every frame (unsmoothed mV + drop %); stops by itself on
                                                disconnect or after REC_MAX_FRAMES. recording, recFrames, recSeconds
    csv()                                       recorded frames as CSV text ("" when nothing was recorded)
*/
(() => {
  const N = 10;
  const BLE_SERVICE = "8b1f0001-6c3e-4c2a-9f5e-2a7d0b1e4f10";
  const BLE_DATA = "8b1f0002-6c3e-4c2a-9f5e-2a7d0b1e4f10";
  const BLE_INFO = "8b1f0003-6c3e-4c2a-9f5e-2a7d0b1e4f10";
  const STORE = "biteforce.base";
  const RANGE_STORE = "biteforce.range";
  const RANGES = [5, 10, 20, 50, 100];
  const BAUD = 921600; // must match the firmware on the "UART" port; ignored by the native USB port
  const SMOOTH_TAU = 0.04; // display smoothing time constant (s), independent of the frame rate

  // A tare taken before the first frame stored all zeros, after which every drop clamped to 0 %
  // (no colour at all, even at 0 V). Such a baseline is meaningless, so it is discarded on load.
  const validBase = (b) => Array.isArray(b) && b.length === N && b.every((v) => Number.isFinite(v) && v >= 0 && v <= 5000) && b.some((v) => v > 0);
  let base = null; // tare voltages (mV); null = use Vcc
  try { base = JSON.parse(localStorage.getItem(STORE) || "null"); } catch {}
  if (!validBase(base)) { base = null; try { localStorage.removeItem(STORE); } catch {} }

  const listeners = [];
  const HW = {
    connected: false,
    ready: false,
    mode: null,
    fps: 0,
    info: { n: N, rpu: 10000, vcc: 3300, hz: 50 }, // hz = firmware frame rate (older firmware does not send it)
    error: "",
    supportsSerial: "serial" in navigator,
    supportsBLE: "bluetooth" in navigator,
    // A light press only drops the node by a few tenths of a volt, so a 0-100 % colour scale stays blue
    range: 20,
    ranges: RANGES,
  };
  try { const r = +localStorage.getItem(RANGE_STORE); if (RANGES.includes(r)) HW.range = r; } catch {}
  const emit = () => listeners.forEach((fn) => { try { fn(HW); } catch (e) { console.error(e); } });
  HW.on = (fn) => { listeners.push(fn); fn(HW); };

  // ---------- Frames ----------
  const mv = Array(N).fill(0), mvS = Array(N).fill(0); // last frame, smoothed (mV)
  let primed = false, frames = 0, fpsT = performance.now(), lastFrame = 0;

  // Only whole frames are used. Right after a port opens, the first line is usually a fragment
  // (e.g. "D,5120,3139,31"); taking it field by field left the missing channels at 0 V.
  function onFrame(values, t) {
    if (values.length !== N || !values.every((v) => Number.isInteger(v) && v >= 0 && v <= 5000)) return;
    if (HW.recording) recPush(values, t);
    const a = 1 - Math.exp(-1 / (Math.max(1, HW.info.hz) * SMOOTH_TAU)); // EMA weight of the newest frame
    for (let i = 0; i < N; i++) {
      const v = values[i];
      mv[i] = v;
      mvS[i] = primed ? mvS[i] + (v - mvS[i]) * a : v;
    }
    if (!primed) { primed = true; HW.ready = true; emit(); }
    frames++;
    lastFrame = performance.now();
    if (lastFrame - fpsT >= 1000) {
      HW.fps = Math.round((frames * 1000) / (lastFrame - fpsT));
      frames = 0;
      fpsT = lastFrame;
      emit();
    }
  }

  function parseInfo(text) {
    for (const kv of text.split(",")) {
      const [k, v] = kv.split("=");
      if (k in HW.info && v !== undefined && !Number.isNaN(+v)) HW.info[k] = +v;
    }
  }

  // One serial line: "I,n=10,rpu=10000,vcc=3300,hz=200" or "D,<t_ms>,<mv1>,...,<mvN>"
  HW.feed = (line) => {
    line = line.trim();
    if (line.startsWith("I,")) parseInfo(line.slice(2));
    else if (line.startsWith("D,")) {
      const f = line.split(",");
      onFrame(f.slice(2).map((s) => (/^\d+$/.test(s) ? +s : NaN)), +f[1]); // "" would be 0
    }
  };

  const drop = (v, i) => Math.min(100, Math.max(0, (100 * ((base ? base[i] : HW.info.vcc) - v)) / HW.info.vcc));
  HW.volts = () => mvS.map((v) => v / 1000);
  HW.values = () => mvS.map((v, i) => (HW.ready ? drop(v, i) : 0));
  HW.raw = () => mv.slice();
  HW.setRange = (r) => { if (!RANGES.includes(+r)) return; HW.range = +r; try { localStorage.setItem(RANGE_STORE, HW.range); } catch {} emit(); };
  HW.tare = () => { if (!HW.ready) return; base = mvS.slice(); try { localStorage.setItem(STORE, JSON.stringify(base)); } catch {} emit(); };

  // ---------- Recording ----------
  // Every frame is kept, not just what the screen redraws: per frame t (ms), N x mV and N x drop in 0.1 %,
  // stored in Int32Array chunks so a long 200 Hz session stays compact.
  const REC_W = 1 + 2 * N, REC_CHUNK = 10000, REC_MAX_FRAMES = 30 * 60 * 200; // 30 min at 200 Hz
  let rec = [], recT0 = 0, recLastT = 0;
  Object.assign(HW, { recording: false, recFrames: 0, recSeconds: 0 });
  function recPush(values, t) {
    if (!Number.isFinite(t)) t = performance.now(); // BLE frames carry no board time
    if (!HW.recFrames) recT0 = t;
    const k = HW.recFrames % REC_CHUNK;
    if (!k) rec.push(new Int32Array(REC_CHUNK * REC_W));
    const row = rec[rec.length - 1], o = k * REC_W;
    row[o] = Math.round(t - recT0);
    for (let i = 0; i < N; i++) {
      row[o + 1 + i] = values[i];
      row[o + 1 + N + i] = Math.round(drop(values[i], i) * 10);
    }
    recLastT = t;
    HW.recFrames++;
    HW.recSeconds = (recLastT - recT0) / 1000;
    if (HW.recFrames >= REC_MAX_FRAMES) HW.stopRec();
  }
  HW.startRec = () => {
    if (!HW.ready || HW.recording) return;
    rec = [];
    Object.assign(HW, { recording: true, recFrames: 0, recSeconds: 0 });
    emit();
  };
  HW.stopRec = () => { if (HW.recording) { HW.recording = false; emit(); } };
  HW.csv = () => {
    if (!HW.recFrames) return "";
    const ids = Array.from({ length: N }, (_, i) => i + 1);
    const out = ["t_ms," + ids.map((i) => `S${i}_mV`).join(",") + "," + ids.map((i) => `S${i}_drop_pct`).join(",")];
    for (let f = 0; f < HW.recFrames; f++) {
      const row = rec[Math.floor(f / REC_CHUNK)], o = (f % REC_CHUNK) * REC_W, cells = [row[o]];
      for (let j = 1; j <= N; j++) cells.push(row[o + j]);
      for (let j = 1; j <= N; j++) cells.push((row[o + N + j] / 10).toFixed(1));
      out.push(cells.join(","));
    }
    return out.join("\r\n") + "\r\n";
  };

  // ---------- Connection bookkeeping ----------
  let link = null; // { close: async () => {} }
  function setConnected(mode) {
    HW.recording = false; // a recording ends with its connection; the frames stay available to csv()
    HW.connected = !!mode;
    HW.mode = mode;
    HW.fps = 0;
    HW.error = "";
    frames = 0;
    fpsT = performance.now();
    lastFrame = 0;
    primed = false;
    HW.ready = false;
    mv.fill(0);
    mvS.fill(0);
    emit();
  }
  function fail(e) {
    if (e && e.name === "NotFoundError") return; // user closed the device picker
    HW.error = (e && e.message) || String(e);
    console.warn("[HW]", e);
    emit();
  }
  HW.disconnect = async () => {
    const l = link;
    link = null;
    if (l) try { await l.close(); } catch {}
    if (HW.connected) setConnected(null);
  };

  // Mark the link as stalled when frames stop (cable pulled but port still open, board reset)
  setInterval(() => {
    if (HW.connected && lastFrame && performance.now() - lastFrame > 1500 && HW.fps !== 0) { HW.fps = 0; emit(); }
  }, 500);

  // ---------- USB serial ----------
  HW.connectSerial = async () => {
    try {
      if (!HW.supportsSerial) throw new Error("This browser has no Web Serial. Use desktop Chrome or Edge.");
      await HW.disconnect();
      const port = await navigator.serial.requestPort();
      await port.open({ baudRate: BAUD, bufferSize: 65536 });
      let reader = null, open = true;
      link = {
        async close() {
          open = false;
          if (reader) await reader.cancel().catch(() => {});
          await port.close().catch(() => {});
        },
      };
      const me = link;
      setConnected("USB");
      (async () => {
        const dec = new TextDecoder();
        let buf = "";
        while (open && port.readable) {
          reader = port.readable.getReader();
          try {
            for (;;) {
              const { value, done } = await reader.read();
              if (done) break;
              buf += dec.decode(value, { stream: true });
              let i;
              while ((i = buf.indexOf("\n")) >= 0) {
                HW.feed(buf.slice(0, i));
                buf = buf.slice(i + 1);
              }
              if (buf.length > 4096) buf = "";
            }
          } catch (e) {
            if (open) console.warn("[HW] serial read", e); // e.g. framing error; retry while the port is readable
          } finally {
            reader.releaseLock();
            reader = null;
          }
        }
        if (link === me) { link = null; await port.close().catch(() => {}); setConnected(null); }
      })();
    } catch (e) {
      fail(e);
    }
  };

  // ---------- BLE ----------
  HW.connectBLE = async () => {
    try {
      if (!HW.supportsBLE) throw new Error("This browser has no Web Bluetooth. Use desktop Chrome or Edge.");
      await HW.disconnect();
      const device = await navigator.bluetooth.requestDevice({ filters: [{ services: [BLE_SERVICE] }] });
      const onGone = () => { if (link && link.device === device) { link = null; setConnected(null); } };
      device.addEventListener("gattserverdisconnected", onGone);
      link = { device, async close() { device.removeEventListener("gattserverdisconnected", onGone); if (device.gatt.connected) device.gatt.disconnect(); } };
      const gatt = await device.gatt.connect();
      const svc = await gatt.getPrimaryService(BLE_SERVICE);
      try {
        const info = await (await svc.getCharacteristic(BLE_INFO)).readValue();
        parseInfo(new TextDecoder().decode(info));
      } catch {}
      const data = await svc.getCharacteristic(BLE_DATA);
      data.addEventListener("characteristicvaluechanged", (e) => {
        const dv = e.target.value, vals = [];
        for (let i = 0; i + 1 < dv.byteLength; i += 2) vals.push(dv.getUint16(i, true));
        onFrame(vals, NaN);
      });
      await data.startNotifications();
      setConnected("BLE");
    } catch (e) {
      await HW.disconnect();
      fail(e);
    }
  };

  window.HW = HW;
})();
