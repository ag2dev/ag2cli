package com.ag2dev.ag2cli.mobile.benchmark

import androidx.benchmark.macro.FrameTimingMetric
import androidx.benchmark.macro.junit4.MacrobenchmarkRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.uiautomator.By
import androidx.test.uiautomator.Direction
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class SessionTimelineScrollBenchmark {
    @get:Rule
    val benchmarkRule = MacrobenchmarkRule()

    @Test
    fun scrollLongSession() = benchmarkRule.measureRepeated(
        packageName = TARGET_PACKAGE,
        metrics = listOf(FrameTimingMetric()),
        iterations = BENCHMARK_ITERATIONS,
        startupMode = null,
        setupBlock = {
            device.executeShellCommand("am force-stop $TARGET_PACKAGE")
            startActivityAndWait()
            requireNotNull(device.findObject(By.res(SESSION_CARD_TAG))).click()
            requireNotNull(device.findObject(By.res(SESSION_TIMELINE_TAG)))
        },
    ) {
        repeat(SCROLL_PASSES) {
            requireNotNull(device.findObject(By.res(SESSION_TIMELINE_TAG)))
                .apply { setGestureMargin(device.displayWidth / 5) }
                .fling(Direction.UP)
            requireNotNull(device.findObject(By.res(SESSION_TIMELINE_TAG)))
                .fling(Direction.DOWN)
        }
    }

    private companion object {
        const val TARGET_PACKAGE = "com.ag2dev.ag2cli.mobile"
        const val SESSION_CARD_TAG = "session_card_session-protocol-recovery"
        const val SESSION_TIMELINE_TAG = "session_timeline"
        const val BENCHMARK_ITERATIONS = 5
        const val SCROLL_PASSES = 3
    }
}
