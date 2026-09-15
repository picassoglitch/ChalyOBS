package expo.modules.usbcamera

import android.content.Context
import android.graphics.BitmapFactory
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Rect
import android.util.Log
import android.view.SurfaceHolder
import android.view.SurfaceView
import android.view.ViewGroup
import android.widget.FrameLayout
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.views.ExpoView

/**
 * SurfaceView-backed Expo View. Decoded MJPEG bitmaps land here from
 * UvcFramePump's worker thread and are blitted via lockHardwareCanvas.
 *
 * Buffer is pinned to 1280x720 (16:9) so the canvas dimensions match the
 * source bitmap aspect — necessary because letterbox-fit math inside a
 * Compose AndroidView previously produced the "frame stuffed into top
 * 1/3 of preview" cropping bug. Unconditional full-canvas stretch is the
 * correct render with both buffer and bitmap at 16:9.
 */
class UsbCameraPreviewView(context: Context, appContext: AppContext) :
    ExpoView(context, appContext) {

    private val surfaceView = SurfaceView(context)
    private val paint = Paint(Paint.FILTER_BITMAP_FLAG or Paint.ANTI_ALIAS_FLAG)
    private val srcRect = Rect()
    private val dstRect = Rect()

    @Volatile private var surfaceReady: Boolean = false

    init {
        surfaceView.layoutParams = FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT,
        )
        addView(surfaceView)

        surfaceView.holder.setFixedSize(BUFFER_W, BUFFER_H)
        surfaceView.holder.addCallback(object : SurfaceHolder.Callback {
            override fun surfaceCreated(holder: SurfaceHolder) { surfaceReady = true }
            override fun surfaceChanged(holder: SurfaceHolder, format: Int, w: Int, h: Int) {
                surfaceReady = true
            }
            override fun surfaceDestroyed(holder: SurfaceHolder) { surfaceReady = false }
        })

        UsbCameraModule.registerView(this)
        Log.i(TAG, "UsbCameraPreviewView attached")
    }

    /** Worker-thread frame entry. */
    fun drawFrame(bytes: ByteArray) {
        if (!surfaceReady) return
        val bitmap = runCatching { BitmapFactory.decodeByteArray(bytes, 0, bytes.size) }
            .getOrNull() ?: return
        try {
            val surface = surfaceView.holder.surface
            if (!surface.isValid) return
            val canvas = surface.lockHardwareCanvas() ?: return
            try {
                canvas.drawColor(Color.BLACK)
                // Source + canvas are both 16:9 (buffer pinned to 1280x720,
                // Osmo MJPEG is 1920x1080 or 1280x720). Unconditional stretch.
                // No letterbox math — see commit history for the cropping bug.
                srcRect.set(0, 0, bitmap.width, bitmap.height)
                dstRect.set(0, 0, canvas.width, canvas.height)
                canvas.drawBitmap(bitmap, srcRect, dstRect, paint)
            } finally {
                surface.unlockCanvasAndPost(canvas)
            }
        } catch (t: Throwable) {
            Log.w(TAG, "drawFrame failed: ${t.message}")
        } finally {
            bitmap.recycle()
        }
    }

    override fun onDetachedFromWindow() {
        super.onDetachedFromWindow()
        UsbCameraModule.unregisterView(this)
        Log.i(TAG, "UsbCameraPreviewView detached")
    }

    companion object {
        private const val TAG = "UsbCameraPreviewView"
        private const val BUFFER_W = 1280
        private const val BUFFER_H = 720
    }
}
