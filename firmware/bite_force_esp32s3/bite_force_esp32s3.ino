/*
  Bite Force Monitor - ESP32-S3-DevKitC-1 firmware
  10 piezoresistive sensors, one voltage divider each:

      3V3 --[ R_PU ]--+-- GPIOn (ADC1)
                      |
                    [ FSR ]   pressure up -> resistance down -> voltage down
                      |
                     GND

  S1..S10 -> GPIO1..GPIO10 (ADC1_CH0..CH9). ADC1 only, since ADC2 is shared with the radio.

  Output (both at the same time):
    USB serial, 921600 baud (the baud rate only matters on the "UART" port; 115200 would cap it near 190 Hz)
      I,n=10,rpu=49900,vcc=3300,hz=200   at boot and every 2 s
      D,<t_ms>,<mv1>,...,<mv10>          every frame (millivolts at each divider node)
    BLE peripheral "BiteForce"
      service  SERVICE_UUID
      DATA_UUID  notify  20 bytes = 10 x uint16 little-endian millivolts
      INFO_UUID  read    "n=10,rpu=49900,vcc=3300,hz=200"

  The firmware only reports millivolts. The UI (ui_demo/hw_link.js) shows them as read and as a drop
  relative to the tare voltage; any later calibration happens off-board, without reflashing.

  Board: Arduino-ESP32 core 3.x, "ESP32S3 Dev Module". No extra libraries.
*/

#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#if defined(CONFIG_BLUEDROID_ENABLED)
#include <BLE2902.h>
#endif

// ---------- Hardware config ----------
const uint8_t N_CH = 10;
const uint8_t PINS[N_CH] = {1, 2, 3, 4, 5, 6, 7, 8, 9, 10};  // S1..S10
const uint32_t R_PU_OHM = 49900;  // nominal pull-up of every divider; only reported in the I line, not used in any
                                  // calculation. Real parts differ from 49.9k, so measure each one for analysis
const uint32_t VCC_MV = 3300;     // divider supply (the board's 3V3 pin)
const uint8_t OVERSAMPLE = 8;     // ADC reads averaged per channel per frame (80 reads, about 2 ms)
const uint16_t FRAME_HZ = 200;    // frames per second sent to the UI
const uint32_t BAUD = 921600;

// ---------- BLE ----------
#define DEVICE_NAME  "BiteForce"
#define SERVICE_UUID "8b1f0001-6c3e-4c2a-9f5e-2a7d0b1e4f10"
#define DATA_UUID    "8b1f0002-6c3e-4c2a-9f5e-2a7d0b1e4f10"
#define INFO_UUID    "8b1f0003-6c3e-4c2a-9f5e-2a7d0b1e4f10"

BLEServer *server = nullptr;
BLECharacteristic *dataChr = nullptr;
volatile bool bleConnected = false;
bool bleWasConnected = false;

class ServerCallbacks : public BLEServerCallbacks {
  void onConnect(BLEServer *) override { bleConnected = true; }
  void onDisconnect(BLEServer *) override { bleConnected = false; }
};

String infoLine() {
  return "n=" + String(N_CH) + ",rpu=" + String(R_PU_OHM) + ",vcc=" + String(VCC_MV) + ",hz=" + String(FRAME_HZ);
}

void setupBLE() {
  BLEDevice::init(DEVICE_NAME);
  server = BLEDevice::createServer();
  server->setCallbacks(new ServerCallbacks());
  BLEService *svc = server->createService(SERVICE_UUID);

  dataChr = svc->createCharacteristic(DATA_UUID, BLECharacteristic::PROPERTY_READ | BLECharacteristic::PROPERTY_NOTIFY);
#if defined(CONFIG_BLUEDROID_ENABLED)
  dataChr->addDescriptor(new BLE2902());  // NimBLE adds the CCCD automatically
#endif

  BLECharacteristic *infoChr = svc->createCharacteristic(INFO_UUID, BLECharacteristic::PROPERTY_READ);
  infoChr->setValue(infoLine());

  svc->start();
  BLEAdvertising *adv = BLEDevice::getAdvertising();
  adv->addServiceUUID(SERVICE_UUID);
  adv->setScanResponse(true);  // 128-bit UUID + name do not fit in one advertising packet
  BLEDevice::startAdvertising();
}

// ---------- ADC ----------
uint16_t mv[N_CH];

void readAll() {
  uint32_t acc[N_CH] = {0};
  for (uint8_t k = 0; k < OVERSAMPLE; k++)
    for (uint8_t i = 0; i < N_CH; i++) acc[i] += analogReadMilliVolts(PINS[i]);  // eFuse-calibrated mV
  for (uint8_t i = 0; i < N_CH; i++) mv[i] = acc[i] / OVERSAMPLE;
}

void setup() {
  Serial.begin(BAUD);
  analogReadResolution(12);
  analogSetAttenuation(ADC_11db);  // full scale about 3.1 V
  for (uint8_t i = 0; i < N_CH; i++) pinMode(PINS[i], INPUT);
  setupBLE();
  Serial.println("I," + infoLine());
}

void loop() {
  // Fixed-rate schedule in microseconds (whole milliseconds would give 1000/FRAME_HZ rounding and jitter)
  const uint32_t PERIOD_US = 1000000UL / FRAME_HZ;
  static uint32_t nextFrame = micros(), nextInfo = 0;
  uint32_t nowUs = micros();
  if ((int32_t)(nowUs - nextFrame) < 0) return;
  nextFrame += PERIOD_US;
  if ((int32_t)(nowUs - nextFrame) > (int32_t)PERIOD_US) nextFrame = nowUs + PERIOD_US;  // fell behind: resync instead of bursting
  uint32_t now = millis();

  readAll();

  // Serial frame
  char line[96];
  int n = snprintf(line, sizeof line, "D,%lu", (unsigned long)now);
  for (uint8_t i = 0; i < N_CH; i++) n += snprintf(line + n, sizeof line - n, ",%u", mv[i]);
  Serial.println(line);
  if ((int32_t)(now - nextInfo) >= 0) {
    nextInfo = now + 2000;
    Serial.println("I," + infoLine());
  }

  // BLE frame
  if (bleConnected) {
    uint8_t buf[N_CH * 2];
    for (uint8_t i = 0; i < N_CH; i++) {
      buf[2 * i] = mv[i] & 0xFF;
      buf[2 * i + 1] = mv[i] >> 8;
    }
    dataChr->setValue(buf, sizeof buf);
    dataChr->notify();
  }
  if (bleWasConnected && !bleConnected) {
    delay(300);
    BLEDevice::startAdvertising();  // accept the next connection
  }
  bleWasConnected = bleConnected;
}
