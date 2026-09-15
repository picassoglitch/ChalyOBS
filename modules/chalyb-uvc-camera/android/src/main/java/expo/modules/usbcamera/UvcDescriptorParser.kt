package expo.modules.usbcamera

import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbDeviceConnection
import android.hardware.usb.UsbManager
import android.util.Log

/**
 * Minimal UVC class-specific descriptor parser. Walks the raw configuration
 * descriptor and pulls (format, w, h, maxFps) tuples from the Video
 * Streaming Format/Frame descriptors (UVC 1.5 §3.9). Used to advertise
 * what the device supports — UvcFramePump picks one of these at negotiate
 * time.
 */
internal object UvcDescriptorParser {
    private const val TAG = "UvcDescriptorParser"

    private const val CS_INTERFACE: Byte = 0x24

    private const val VS_FORMAT_UNCOMPRESSED: Byte = 0x04
    private const val VS_FRAME_UNCOMPRESSED: Byte = 0x05
    private const val VS_FORMAT_MJPEG: Byte = 0x06
    private const val VS_FRAME_MJPEG: Byte = 0x07
    private const val VS_FORMAT_FRAME_BASED: Byte = 0x10
    private const val VS_FRAME_FRAME_BASED: Byte = 0x11
    private const val VS_FORMAT_H264: Byte = 0x13

    fun parse(usbManager: UsbManager, device: UsbDevice): List<UvcCapability> {
        val connection: UsbDeviceConnection = runCatching { usbManager.openDevice(device) }
            .getOrNull() ?: return emptyList()
        return try {
            val raw = connection.rawDescriptors ?: return emptyList()
            parseRaw(raw)
        } catch (t: Throwable) {
            Log.w(TAG, "Descriptor parse failed: ${t.message}")
            emptyList()
        } finally {
            connection.close()
        }
    }

    fun parseRaw(raw: ByteArray): List<UvcCapability> {
        val caps = mutableListOf<UvcCapability>()
        var i = 0
        var currentFormat: String? = null
        while (i < raw.size) {
            val len = raw[i].toInt() and 0xFF
            if (len < 2 || i + len > raw.size) break
            val type = raw[i + 1]
            if (type == CS_INTERFACE && len >= 3) {
                when (raw[i + 2]) {
                    VS_FORMAT_UNCOMPRESSED -> currentFormat = "YUV"
                    VS_FORMAT_MJPEG -> currentFormat = "MJPEG"
                    VS_FORMAT_H264 -> currentFormat = "H264"
                    VS_FORMAT_FRAME_BASED -> currentFormat = "FRAMED"
                    VS_FRAME_UNCOMPRESSED,
                    VS_FRAME_MJPEG,
                    VS_FRAME_FRAME_BASED -> {
                        if (len >= 30 && currentFormat != null) {
                            val width = u16(raw, i + 5)
                            val height = u16(raw, i + 7)
                            val minInterval = u32(raw, i + 26)
                            val maxFps = if (minInterval > 0) {
                                (10_000_000L / minInterval).toInt()
                            } else 0
                            if (width in 1..7680 && height in 1..4320) {
                                caps += UvcCapability(width, height, maxFps, currentFormat!!)
                            }
                        }
                    }
                }
            }
            i += len
        }
        return caps
            .distinctBy { listOf(it.widthPx, it.heightPx, it.maxFps, it.format) }
            .sortedWith(
                compareByDescending<UvcCapability> { it.widthPx * it.heightPx }
                    .thenByDescending { it.maxFps },
            )
    }

    private fun u16(b: ByteArray, off: Int): Int =
        (b[off].toInt() and 0xFF) or ((b[off + 1].toInt() and 0xFF) shl 8)

    private fun u32(b: ByteArray, off: Int): Long =
        (b[off].toLong() and 0xFF) or
            ((b[off + 1].toLong() and 0xFF) shl 8) or
            ((b[off + 2].toLong() and 0xFF) shl 16) or
            ((b[off + 3].toLong() and 0xFF) shl 24)
}
