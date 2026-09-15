package expo.modules.usbcamera

import android.hardware.usb.UsbConstants
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbDeviceConnection
import android.hardware.usb.UsbEndpoint
import android.hardware.usb.UsbInterface
import android.hardware.usb.UsbManager
import android.hardware.usb.UsbRequest
import android.util.Log
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer

/**
 * UVC frame pump.
 *  1. Pick a format (MJPEG > YUY2) from advertised capabilities.
 *  2. Negotiate via VS_PROBE_CONTROL → VS_COMMIT_CONTROL (UVC §4.3.1).
 *  3. Select a streaming endpoint: bulk first (simplest), iso as fallback.
 *     Iso requires switching the VS interface to a non-zero alt setting.
 *  4. Peel the 12-byte UVC payload header off each transfer, reassemble
 *     complete frames via FID/EOF, deliver to the onFrame sink.
 */
class UvcFramePump(
    private val usbManager: UsbManager,
    private val device: UsbDevice,
) {
    data class Negotiated(
        val width: Int,
        val height: Int,
        val fps: Int,
        val format: Format,
        val maxPayload: Int,
    )

    enum class Format { MJPEG, YUY2 }

    @Volatile private var running = false
    @Volatile private var connection: UsbDeviceConnection? = null
    @Volatile private var streamingInterface: UsbInterface? = null
    @Volatile private var endpoint: UsbEndpoint? = null
    @Volatile private var negotiated: Negotiated? = null
    private var pumpThread: Thread? = null

    private val frameBuffer = ByteArrayOutputStream(256 * 1024)
    private var currentFid: Int = -1

    @Volatile var framesDelivered: Long = 0L; private set
    @Volatile var bytesPulled: Long = 0L; private set
    @Volatile var transferErrors: Long = 0L; private set

    val current: Negotiated? get() = negotiated

    fun start(
        existingConnection: UsbDeviceConnection,
        targetWidth: Int,
        targetHeight: Int,
        targetFps: Int,
        onFrame: (ByteArray, Format) -> Unit,
        onError: (String) -> Unit,
    ): Negotiated? {
        stop()
        connection = existingConnection
        try {
            val caps = UvcDescriptorParser.parse(usbManager, device)
            val (vsInterface, vcInterface) = findVsVcInterfaces() ?: run {
                onError("No Video Streaming interface found"); return null
            }
            streamingInterface = vsInterface

            val candidate = pickCapability(caps, targetWidth, targetHeight, targetFps) ?: run {
                onError("No MJPEG/YUY2 capability advertised"); return null
            }
            val format = if (candidate.format == "MJPEG") Format.MJPEG else Format.YUY2
            val frameInterval = if (candidate.maxFps > 0) {
                (10_000_000L / candidate.maxFps.coerceAtMost(targetFps).coerceAtLeast(1)).toInt()
            } else 333_333

            if (vcInterface != null) existingConnection.claimInterface(vcInterface, true)
            existingConnection.claimInterface(vsInterface, true)

            val neg = probeAndCommit(
                conn = existingConnection,
                vsInterfaceId = vsInterface.id,
                formatIndex = 1,
                frameIndex = 1,
                frameInterval = frameInterval,
                fmt = format,
                w = candidate.widthPx,
                h = candidate.heightPx,
            ) ?: run {
                onError("UVC probe/commit failed")
                runCatching { existingConnection.releaseInterface(vsInterface) }
                runCatching { vcInterface?.let { existingConnection.releaseInterface(it) } }
                return null
            }
            this.negotiated = neg

            val ep = pickStreamingEndpoint(vsInterface, existingConnection) ?: run {
                onError("No streaming endpoint available"); return null
            }
            endpoint = ep

            running = true
            pumpThread = Thread({ pumpLoop(existingConnection, ep, onFrame, onError) }, "uvc-pump").also { it.start() }
            Log.i(TAG, "UVC pump started ${neg.width}x${neg.height}@${neg.fps} ${neg.format}")
            return neg
        } catch (t: Throwable) {
            Log.e(TAG, "UVC start failed", t)
            onError(t.message ?: "UVC start failed")
            stop()
            return null
        }
    }

    fun stop() {
        running = false
        pumpThread?.runCatching { join(500) }
        pumpThread = null
        val conn = connection
        val vs = streamingInterface
        if (conn != null && vs != null) {
            runCatching { conn.setInterface(getInterface(vs.id, 0)) }
            runCatching { conn.releaseInterface(vs) }
        }
        connection = null
        streamingInterface = null
        endpoint = null
        negotiated = null
        frameBuffer.reset()
        currentFid = -1
    }

    private fun findVsVcInterfaces(): Pair<UsbInterface, UsbInterface?>? {
        var vs: UsbInterface? = null
        var vc: UsbInterface? = null
        for (i in 0 until device.interfaceCount) {
            val iface = device.getInterface(i)
            if (iface.interfaceClass != UsbConstants.USB_CLASS_VIDEO) continue
            when (iface.interfaceSubclass) {
                SC_VIDEOCONTROL -> if (vc == null) vc = iface
                SC_VIDEOSTREAMING -> if (vs == null && iface.endpointCount > 0) vs = iface
            }
        }
        if (vs == null) {
            for (i in 0 until device.interfaceCount) {
                val iface = device.getInterface(i)
                if (iface.interfaceClass == UsbConstants.USB_CLASS_VIDEO &&
                    iface.interfaceSubclass == SC_VIDEOSTREAMING) {
                    vs = iface; break
                }
            }
        }
        val vsResolved = vs ?: return null
        return vsResolved to vc
    }

    private fun getInterface(id: Int, alt: Int): UsbInterface {
        for (i in 0 until device.interfaceCount) {
            val iface = device.getInterface(i)
            if (iface.id == id && iface.alternateSetting == alt) return iface
        }
        return device.getInterface(0)
    }

    private fun pickStreamingEndpoint(
        vs: UsbInterface,
        conn: UsbDeviceConnection,
    ): UsbEndpoint? {
        var bestBulk: UsbEndpoint? = null
        var bestIso: UsbEndpoint? = null
        var bestIsoIface: UsbInterface? = null
        for (i in 0 until device.interfaceCount) {
            val iface = device.getInterface(i)
            if (iface.id != vs.id) continue
            for (e in 0 until iface.endpointCount) {
                val ep = iface.getEndpoint(e)
                if (ep.direction != UsbConstants.USB_DIR_IN) continue
                when (ep.type) {
                    UsbConstants.USB_ENDPOINT_XFER_BULK -> {
                        if (bestBulk == null) bestBulk = ep
                    }
                    UsbConstants.USB_ENDPOINT_XFER_ISOC -> {
                        if (bestIso == null || ep.maxPacketSize > bestIso.maxPacketSize) {
                            bestIso = ep
                            bestIsoIface = iface
                        }
                    }
                }
            }
        }
        if (bestBulk != null) return bestBulk
        val isoIface = bestIsoIface ?: return null
        return if (conn.setInterface(isoIface)) {
            Log.i(TAG, "Selected iso endpoint alt=${isoIface.alternateSetting} mps=${bestIso?.maxPacketSize}")
            bestIso
        } else {
            Log.w(TAG, "setInterface for iso alt=${isoIface.alternateSetting} failed")
            null
        }
    }

    private data class CapPick(
        val widthPx: Int,
        val heightPx: Int,
        val maxFps: Int,
        val format: String,
    )

    private fun pickCapability(caps: List<UvcCapability>, w: Int, h: Int, fps: Int): CapPick? {
        if (caps.isEmpty()) return null
        val mjpeg = caps.filter { it.format == "MJPEG" }
        val pool = if (mjpeg.isNotEmpty()) mjpeg else caps.filter { it.format == "YUV" }
        if (pool.isEmpty()) return null
        val exact = pool.firstOrNull { it.widthPx == w && it.heightPx == h }
        val pick = exact
            ?: pool.firstOrNull { it.widthPx <= w && it.heightPx <= h }
            ?: pool.maxBy { it.widthPx * it.heightPx }
        return CapPick(
            widthPx = pick.widthPx,
            heightPx = pick.heightPx,
            maxFps = if (pick.maxFps > 0) pick.maxFps else fps,
            format = pick.format,
        )
    }

    private fun probeAndCommit(
        conn: UsbDeviceConnection,
        vsInterfaceId: Int,
        formatIndex: Int,
        frameIndex: Int,
        frameInterval: Int,
        fmt: Format,
        w: Int,
        h: Int,
    ): Negotiated? {
        val probe = ByteArray(26)
        probe[0] = 0x01
        probe[1] = 0x00
        probe[2] = formatIndex.toByte()
        probe[3] = frameIndex.toByte()
        writeU32(probe, 4, frameInterval)

        val setProbe = conn.controlTransfer(
            REQ_TYPE_SET, REQ_SET_CUR,
            (CS_PROBE shl 8), vsInterfaceId,
            probe, probe.size, CTRL_TIMEOUT_MS,
        )
        if (setProbe < 0) {
            Log.w(TAG, "SET_CUR(PROBE) failed: $setProbe"); return null
        }
        val cur = ByteArray(26)
        val got = conn.controlTransfer(
            REQ_TYPE_GET, REQ_GET_CUR,
            (CS_PROBE shl 8), vsInterfaceId,
            cur, cur.size, CTRL_TIMEOUT_MS,
        )
        if (got < 0) {
            Log.w(TAG, "GET_CUR(PROBE) failed: $got"); return null
        }
        val commit = conn.controlTransfer(
            REQ_TYPE_SET, REQ_SET_CUR,
            (CS_COMMIT shl 8), vsInterfaceId,
            cur, cur.size, CTRL_TIMEOUT_MS,
        )
        if (commit < 0) {
            Log.w(TAG, "SET_CUR(COMMIT) failed: $commit"); return null
        }
        val maxPayload = readU32(cur, 22).toInt().coerceAtLeast(1024)
        val acceptedInterval = readU32(cur, 4).toInt().coerceAtLeast(1)
        val acceptedFps = (10_000_000 / acceptedInterval).coerceAtLeast(1)
        return Negotiated(w, h, acceptedFps, fmt, maxPayload)
    }

    private fun pumpLoop(
        conn: UsbDeviceConnection,
        ep: UsbEndpoint,
        onFrame: (ByteArray, Format) -> Unit,
        onError: (String) -> Unit,
    ) {
        val isIso = ep.type == UsbConstants.USB_ENDPOINT_XFER_ISOC
        val format = negotiated?.format ?: Format.MJPEG
        val mps = ep.maxPacketSize.coerceAtLeast(512)
        if (isIso) pumpIso(conn, ep, mps, format, onFrame, onError)
        else pumpBulk(conn, ep, mps, format, onFrame, onError)
    }

    private fun pumpBulk(
        conn: UsbDeviceConnection,
        ep: UsbEndpoint,
        mps: Int,
        format: Format,
        onFrame: (ByteArray, Format) -> Unit,
        onError: (String) -> Unit,
    ) {
        val buf = ByteArray((mps * 32).coerceAtLeast(64 * 1024))
        var consecutiveErrors = 0
        while (running) {
            val n = runCatching { conn.bulkTransfer(ep, buf, buf.size, BULK_TIMEOUT_MS) }
                .getOrElse { -1 }
            if (n <= 0) {
                consecutiveErrors++
                transferErrors++
                if (consecutiveErrors > 50) {
                    onError("bulk transfer failed repeatedly"); return
                }
                continue
            }
            consecutiveErrors = 0
            bytesPulled += n
            handlePayload(buf, 0, n, format, onFrame)
        }
    }

    private fun pumpIso(
        conn: UsbDeviceConnection,
        ep: UsbEndpoint,
        mps: Int,
        format: Format,
        onFrame: (ByteArray, Format) -> Unit,
        onError: (String) -> Unit,
    ) {
        val ringSize = 16
        val requests = Array(ringSize) {
            UsbRequest().apply { initialize(conn, ep) }
        }
        val buffers = Array(ringSize) { ByteBuffer.allocate(mps) }
        for (i in 0 until ringSize) {
            buffers[i].clear()
            if (!requests[i].queue(buffers[i], mps)) {
                Log.w(TAG, "iso initial queue failed [$i]")
            }
        }
        try {
            while (running) {
                val done = conn.requestWait() ?: continue
                val idx = requests.indexOf(done)
                if (idx < 0) continue
                val b = buffers[idx]
                val len = b.position()
                if (len > 0) {
                    bytesPulled += len
                    handlePayload(b.array(), 0, len, format, onFrame)
                }
                b.clear()
                if (running && !requests[idx].queue(buffers[idx], mps)) {
                    transferErrors++
                }
            }
        } catch (t: Throwable) {
            onError(t.message ?: "iso pump error")
        } finally {
            requests.forEach { runCatching { it.cancel() }; runCatching { it.close() } }
        }
    }

    private fun handlePayload(
        buf: ByteArray,
        offset: Int,
        length: Int,
        format: Format,
        onFrame: (ByteArray, Format) -> Unit,
    ) {
        if (length < 2) return
        val hle = buf[offset].toInt() and 0xFF
        if (hle < 2 || hle > length) return
        val bfh = buf[offset + 1].toInt() and 0xFF
        val fid = bfh and 0x01
        val eof = (bfh and 0x02) != 0
        val err = (bfh and 0x40) != 0

        if (currentFid >= 0 && fid != currentFid) {
            frameBuffer.reset()
        }
        currentFid = fid

        val payloadOff = offset + hle
        val payloadLen = length - hle
        if (!err && payloadLen > 0) {
            frameBuffer.write(buf, payloadOff, payloadLen)
        }
        if (eof) {
            if (frameBuffer.size() > 0 && !err) {
                val frame = frameBuffer.toByteArray()
                framesDelivered++
                if (framesDelivered % 60L == 0L) {
                    Log.d(TAG, "UVC frame=$framesDelivered bytes=${frame.size}")
                }
                onFrame(frame, format)
            }
            frameBuffer.reset()
        }
    }

    private fun writeU32(b: ByteArray, off: Int, v: Int) {
        b[off + 0] = (v and 0xFF).toByte()
        b[off + 1] = ((v ushr 8) and 0xFF).toByte()
        b[off + 2] = ((v ushr 16) and 0xFF).toByte()
        b[off + 3] = ((v ushr 24) and 0xFF).toByte()
    }

    private fun readU32(b: ByteArray, off: Int): Long =
        (b[off].toLong() and 0xFF) or
            ((b[off + 1].toLong() and 0xFF) shl 8) or
            ((b[off + 2].toLong() and 0xFF) shl 16) or
            ((b[off + 3].toLong() and 0xFF) shl 24)

    companion object {
        private const val TAG = "UvcFramePump"
        private const val SC_VIDEOCONTROL = 0x01
        private const val SC_VIDEOSTREAMING = 0x02
        private const val CS_PROBE = 0x01
        private const val CS_COMMIT = 0x02
        private const val REQ_SET_CUR = 0x01
        private const val REQ_GET_CUR = 0x81
        private const val REQ_TYPE_SET = 0x21
        private const val REQ_TYPE_GET = 0xA1
        private const val CTRL_TIMEOUT_MS = 500
        private const val BULK_TIMEOUT_MS = 200
    }
}
