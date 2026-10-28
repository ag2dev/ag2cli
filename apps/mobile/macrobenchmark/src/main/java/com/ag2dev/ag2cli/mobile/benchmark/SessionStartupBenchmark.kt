package com.ag2dev.ag2cli.mobile.benchmark

import androidx.benchmark.macro.CompilationMode
import androidx.benchmark.macro.StartupMode
import androidx.benchmark.macro.StartupTimingMetric
import androidx.benchmark.macro.junit4.MacrobenchmarkRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class SessionStartupBenchmark {
    @get:Rule
    val benchmarkRule = MacrobenchmarkRule()

    @Test
    fun coldStartup() = benchmarkRule.measureRepeated(
        packageName = TARGET_PACKAGE,
        metrics = listOf(StartupTimingMetric()),
        compilationMode = CompilationMode.DEFAULT,
        iterations = BENCHMARK_ITERATIONS,
        startupMode = StartupMode.COLD,
    ) {
        startActivityAndWait()
    }

    private companion object {
        const val TARGET_PACKAGE = "com.ag2dev.ag2cli.mobile"
        const val BENCHMARK_ITERATIONS = 5
    }
}
