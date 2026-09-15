package expo.modules.chalybstreaming

import android.util.Log
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

private const val TAG = "ChalybStreaming"

/**
 * RTMP broadcaster module — Phase 1.A scaffold.
 *
 * What's here: module registration, JS event surface (onStatus / onStats /
 * onError), and async function signatures that consumers can call without
 * a NotFoundError. Implementations currently throw `not_implemented` so
 * the dev client compiles + boots cleanly while we wire RootEncoder
 * (Camera2 → MediaCodec → RTMP publisher) in the follow-up commit.
 *
 * Phase 1.B will:
 *   - Stand up an RtmpCamera2 (RootEncoder) instance with a background
 *     Surface so we can run headless until a preview view is mounted.
 *   - Wire start(input) to prepareVideo / prepareAudio / startStream.
 *   - Forward connect/connected/connectionFailed callbacks to onStatus.
 *   - Tick a stats job that posts bitrate/fps/dropped via onStats.
 */
class ChalybStreamingModule : Module() {
    @Volatile private var started: Boolean = false

    override fun definition() = ModuleDefinition {
        Name("ChalybStreaming")
        Events("onStatus", "onStats", "onError")

        AsyncFunction("isReady") {
            // Phase 1.A scaffold reports false — JS uses this to decide
            // whether to attempt start() or fall back to the UI placeholder.
            return@AsyncFunction false
        }

        AsyncFunction("start") { _input: Map<String, Any?> ->
            // Phase 1.A scaffold: emit onError + resolve, no throw. Throwing
            // from the lambda body makes Kotlin infer the AsyncFunction's
            // reified return type as Nothing, which fails to compile
            // ("Cannot use 'Nothing' as reified type parameter"). JS consumers
            // call isReady() first; anything that still reaches start() gets
            // a structured event for visibility.
            Log.i(TAG, "start() called — Phase 1.A scaffold, not yet implemented")
            sendEvent(
                "onError",
                mapOf(
                    "message" to "RTMP broadcaster not yet wired — Phase 1.B",
                    "code" to "not_implemented",
                ),
            )
        }

        AsyncFunction("stop") {
            Log.i(TAG, "stop() called (no-op in Phase 1.A)")
            started = false
        }

        AsyncFunction("setBitrate") { _bitrateKbps: Int ->
            Log.i(TAG, "setBitrate() called (no-op in Phase 1.A)")
        }
    }
}
