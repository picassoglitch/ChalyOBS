package expo.modules.usbcamera

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbDeviceConnection
import android.hardware.usb.UsbInterface
import android.hardware.usb.UsbManager
import android.os.Build
import android.util.Log
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

private const val TAG = "UsbCameraModule"
private const val ACTION_USB_PERMISSION = "expo.modules.usbcamera.USB_PERMISSION"
private const val USB_CLASS_VIDEO = 14
private const val USB_SUBCLASS_VIDEO_CONTROL = 1
private const val DJI_VENDOR_ID = 0x2CA3

/**
 * UVC USB camera module — Osmo Pocket 3 et al.
 *
 *   getCurrentDevice / requestPermission / refresh — discovery + perms
 *   initialize       — opens device + claims VC interface (Osmo enters
 *                       webcam mode the moment the interface is claimed)
 *   startPreview     — runs UvcFramePump and blits decoded frames into
 *                       the mounted <UsbCameraPreview /> view
 *   stopPreview / release — clean shutdown
 */
class UsbCameraModule : Module() {
    private var receiverRegistered = false
    private var openConnection: UsbDeviceConnection? = null
    private var claimedInterface: UsbInterface? = null
    private var pump: UvcFramePump? = null

    private val usbManager: UsbManager
        get() = appContext.reactContext!!.getSystemService(Context.USB_SERVICE) as UsbManager

    private val receiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            val device: UsbDevice? = parseDevice(intent)
            when (intent.action) {
                UsbManager.ACTION_USB_DEVICE_ATTACHED -> {
                    Log.i(TAG, "USB attached: ${device?.deviceName}")
                    emitCurrent()
                }
                UsbManager.ACTION_USB_DEVICE_DETACHED -> {
                    Log.i(TAG, "USB detached: ${device?.deviceName}")
                    stopPumpInternal()
                    releaseInternal()
                    sendEvent("onDetach", mapOf("reason" to "device unplugged"))
                }
                ACTION_USB_PERMISSION -> {
                    val granted = intent.getBooleanExtra(UsbManager.EXTRA_PERMISSION_GRANTED, false)
                    Log.i(TAG, "USB permission result granted=$granted device=${device?.deviceName}")
                    sendEvent("onPermissionResult", mapOf("granted" to granted))
                    if (granted) emitCurrent()
                }
            }
        }
    }

    override fun definition() = ModuleDefinition {
        Name("UsbCamera")

        Events("onAttach", "onDetach", "onPermissionResult", "onPumpError")

        View(UsbCameraPreviewView::class) {
            // No props; view auto-registers with the module on attach.
        }

        OnCreate {
            registerReceiver()
            emitCurrent()
        }

        OnDestroy {
            stopPumpInternal()
            releaseInternal()
            unregisterReceiver()
        }

        AsyncFunction("getCurrentDevice") {
            val device = findUvcDevice() ?: return@AsyncFunction null
            return@AsyncFunction deviceMap(device)
        }

        AsyncFunction("requestPermission") {
            val device = findUvcDevice() ?: return@AsyncFunction false
            if (usbManager.hasPermission(device)) return@AsyncFunction true
            val ctx = appContext.reactContext!!
            val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                PendingIntent.FLAG_MUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
            } else {
                PendingIntent.FLAG_UPDATE_CURRENT
            }
            val pending = PendingIntent.getBroadcast(
                ctx,
                0,
                Intent(ACTION_USB_PERMISSION).setPackage(ctx.packageName),
                flags,
            )
            usbManager.requestPermission(device, pending)
            return@AsyncFunction false
        }

        AsyncFunction("refresh") {
            emitCurrent()
        }

        AsyncFunction("initialize") {
            val device = findUvcDevice() ?: return@AsyncFunction mapOf(
                "ok" to false,
                "uvcInterfaces" to 0,
                "uvcVersion" to null,
                "message" to "No UVC device present",
            )
            if (!usbManager.hasPermission(device)) {
                return@AsyncFunction mapOf(
                    "ok" to false,
                    "uvcInterfaces" to 0,
                    "uvcVersion" to null,
                    "message" to "USB permission not granted — call requestPermission first",
                )
            }

            stopPumpInternal()
            releaseInternal()

            val connection = usbManager.openDevice(device) ?: return@AsyncFunction mapOf(
                "ok" to false,
                "uvcInterfaces" to 0,
                "uvcVersion" to null,
                "message" to "openDevice returned null",
            )

            val uvcInterfaces = mutableListOf<UsbInterface>()
            for (i in 0 until device.interfaceCount) {
                val iface = device.getInterface(i)
                if (iface.interfaceClass == USB_CLASS_VIDEO) uvcInterfaces.add(iface)
            }
            if (uvcInterfaces.isEmpty()) {
                connection.close()
                return@AsyncFunction mapOf(
                    "ok" to false,
                    "uvcInterfaces" to 0,
                    "uvcVersion" to null,
                    "message" to "Device has no Video class interfaces",
                )
            }

            val control = uvcInterfaces.firstOrNull {
                it.interfaceSubclass == USB_SUBCLASS_VIDEO_CONTROL
            } ?: uvcInterfaces.first()

            val claimed = connection.claimInterface(control, true)
            if (!claimed) {
                connection.close()
                return@AsyncFunction mapOf(
                    "ok" to false,
                    "uvcInterfaces" to uvcInterfaces.size,
                    "uvcVersion" to null,
                    "message" to "claimInterface failed (interface ${control.id} subclass ${control.interfaceSubclass})",
                )
            }

            openConnection = connection
            claimedInterface = control
            Log.i(
                TAG,
                "Initialized vid=${device.vendorId.toHex()} pid=${device.productId.toHex()} uvc-interfaces=${uvcInterfaces.size}",
            )

            return@AsyncFunction mapOf(
                "ok" to true,
                "uvcInterfaces" to uvcInterfaces.size,
                "uvcVersion" to readUvcVersion(connection),
                "message" to null,
            )
        }

        AsyncFunction("startPreview") { width: Int, height: Int, fps: Int ->
            val device = findUvcDevice() ?: return@AsyncFunction mapOf(
                "ok" to false,
                "message" to "No UVC device present",
            )
            val conn = openConnection ?: return@AsyncFunction mapOf(
                "ok" to false,
                "message" to "Call initialize() first",
            )
            stopPumpInternal()

            val view = activeView
            val nextPump = UvcFramePump(usbManager, device)
            val started = nextPump.start(
                existingConnection = conn,
                targetWidth = width,
                targetHeight = height,
                targetFps = fps,
                onFrame = { bytes, _ -> view?.drawFrame(bytes) },
                onError = { err -> sendEvent("onPumpError", mapOf("message" to err)) },
            )
            if (started == null) {
                return@AsyncFunction mapOf(
                    "ok" to false,
                    "message" to "Pump failed to start — verify endpoint type + advertised formats",
                )
            }
            pump = nextPump
            return@AsyncFunction mapOf(
                "ok" to true,
                "width" to started.width,
                "height" to started.height,
                "fps" to started.fps,
                "format" to started.format.name,
                "message" to null,
            )
        }

        AsyncFunction("stopPreview") {
            stopPumpInternal()
        }

        AsyncFunction("release") {
            stopPumpInternal()
            releaseInternal()
        }
    }

    private fun parseDevice(intent: Intent): UsbDevice? {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            intent.getParcelableExtra(UsbManager.EXTRA_DEVICE, UsbDevice::class.java)
        } else {
            @Suppress("DEPRECATION")
            intent.getParcelableExtra(UsbManager.EXTRA_DEVICE)
        }
    }

    private fun findUvcDevice(): UsbDevice? =
        usbManager.deviceList.values.firstOrNull { isUvc(it) }

    private fun isUvc(device: UsbDevice): Boolean {
        if (device.deviceClass == USB_CLASS_VIDEO) return true
        for (i in 0 until device.interfaceCount) {
            if (device.getInterface(i).interfaceClass == USB_CLASS_VIDEO) return true
        }
        return false
    }

    private fun emitCurrent() {
        val device = findUvcDevice()
        if (device != null) {
            sendEvent("onAttach", deviceMap(device))
        } else {
            sendEvent("onDetach", mapOf("reason" to "no device"))
        }
    }

    private fun deviceMap(device: UsbDevice): Map<String, Any?> {
        return mapOf(
            "deviceName" to device.deviceName,
            "vendorId" to device.vendorId,
            "productId" to device.productId,
            "vendorHex" to device.vendorId.toHex(),
            "productHex" to device.productId.toHex(),
            "productName" to runCatching { device.productName }.getOrNull(),
            "manufacturerName" to runCatching { device.manufacturerName }.getOrNull(),
            "permissionGranted" to usbManager.hasPermission(device),
            "isDji" to (device.vendorId == DJI_VENDOR_ID),
        )
    }

    private fun readUvcVersion(connection: UsbDeviceConnection): String? {
        return runCatching {
            val raw = connection.rawDescriptors
            var i = 0
            while (i < raw.size - 14) {
                val len = raw[i].toInt() and 0xFF
                val type = raw[i + 1].toInt() and 0xFF
                val subtype = if (i + 2 < raw.size) raw[i + 2].toInt() and 0xFF else 0
                if (type == 0x24 && subtype == 0x01 && len >= 12) {
                    val bcdUvcLow = raw[i + 3].toInt() and 0xFF
                    val bcdUvcHigh = raw[i + 4].toInt() and 0xFF
                    return "${bcdUvcHigh}.${(bcdUvcLow shr 4)}"
                }
                if (len == 0) break
                i += len
            }
            null
        }.getOrNull()
    }

    private fun stopPumpInternal() {
        runCatching { pump?.stop() }
        pump = null
    }

    private fun releaseInternal() {
        val iface = claimedInterface
        val conn = openConnection
        if (iface != null && conn != null) {
            runCatching { conn.releaseInterface(iface) }
        }
        runCatching { conn?.close() }
        openConnection = null
        claimedInterface = null
    }

    private fun registerReceiver() {
        if (receiverRegistered) return
        val ctx = appContext.reactContext ?: return
        val filter = IntentFilter().apply {
            addAction(UsbManager.ACTION_USB_DEVICE_ATTACHED)
            addAction(UsbManager.ACTION_USB_DEVICE_DETACHED)
            addAction(ACTION_USB_PERMISSION)
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            ctx.registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            @Suppress("UnspecifiedRegisterReceiverFlag")
            ctx.registerReceiver(receiver, filter)
        }
        receiverRegistered = true
    }

    private fun unregisterReceiver() {
        if (!receiverRegistered) return
        runCatching { appContext.reactContext?.unregisterReceiver(receiver) }
        receiverRegistered = false
    }

    companion object {
        @Volatile private var activeView: UsbCameraPreviewView? = null

        internal fun registerView(view: UsbCameraPreviewView) {
            activeView = view
        }

        internal fun unregisterView(view: UsbCameraPreviewView) {
            if (activeView === view) activeView = null
        }
    }
}

private fun Int.toHex(): String = "0x%04X".format(this)
