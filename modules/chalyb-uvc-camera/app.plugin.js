const {
  withAndroidManifest,
  withDangerousMod,
  AndroidConfig,
} = require("@expo/config-plugins");
const fs = require("fs");
const path = require("path");

// Matches any UVC device — class 14 = USB_CLASS_VIDEO at device level, or
// class 239 / subclass 2 = IAD composite (Osmo Pocket 3 + most webcams).
const USB_DEVICE_FILTER_XML = `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <usb-device class="14" />
    <usb-device class="239" subclass="2" />
</resources>
`;

function withUsbDeviceFilterXml(config) {
  return withDangerousMod(config, [
    "android",
    async (config) => {
      const xmlDir = path.join(
        config.modRequest.platformProjectRoot,
        "app/src/main/res/xml",
      );
      const xmlPath = path.join(xmlDir, "usb_device_filter.xml");
      fs.mkdirSync(xmlDir, { recursive: true });
      fs.writeFileSync(xmlPath, USB_DEVICE_FILTER_XML);
      return config;
    },
  ]);
}

function withUsbManifest(config) {
  return withAndroidManifest(config, (config) => {
    const manifest = config.modResults.manifest;
    const application = manifest.application?.[0];
    if (!application) return config;

    const mainActivity = AndroidConfig.Manifest.getMainActivityOrThrow(
      config.modResults,
    );

    // singleTask: USB_DEVICE_ATTACHED routes to the existing activity via
    // onNewIntent instead of spawning a duplicate. Burnt us in the prior
    // Kotlin app (two MainActivity instances each opening the same UVC
    // device) — same fix applies here.
    mainActivity.$["android:launchMode"] = "singleTask";

    if (!mainActivity["intent-filter"]) mainActivity["intent-filter"] = [];

    const alreadyHasUsbFilter = mainActivity["intent-filter"].some((f) =>
      (f.action || []).some(
        (a) =>
          a.$?.["android:name"] ===
          "android.hardware.usb.action.USB_DEVICE_ATTACHED",
      ),
    );
    if (!alreadyHasUsbFilter) {
      // Important: NO <category android:name="android.intent.category.DEFAULT" />
      // here. Adding DEFAULT makes the filter require DEFAULT in the intent,
      // which USB_DEVICE_ATTACHED doesn't carry — so the filter stops
      // matching and auto-launch + implicit per-device permission break.
      mainActivity["intent-filter"].push({
        action: [
          {
            $: {
              "android:name":
                "android.hardware.usb.action.USB_DEVICE_ATTACHED",
            },
          },
        ],
      });
    }

    mainActivity["meta-data"] = mainActivity["meta-data"] || [];
    const alreadyHasMeta = mainActivity["meta-data"].some(
      (m) =>
        m.$?.["android:name"] ===
        "android.hardware.usb.action.USB_DEVICE_ATTACHED",
    );
    if (!alreadyHasMeta) {
      mainActivity["meta-data"].push({
        $: {
          "android:name": "android.hardware.usb.action.USB_DEVICE_ATTACHED",
          "android:resource": "@xml/usb_device_filter",
        },
      });
    }

    const features = manifest["uses-feature"] || [];
    if (
      !features.some(
        (f) => f.$?.["android:name"] === "android.hardware.usb.host",
      )
    ) {
      features.push({
        $: {
          "android:name": "android.hardware.usb.host",
          "android:required": "false",
        },
      });
      manifest["uses-feature"] = features;
    }

    return config;
  });
}

module.exports = function withUvcCamera(config) {
  config = withUsbDeviceFilterXml(config);
  config = withUsbManifest(config);
  return config;
};
