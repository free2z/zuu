// SPDX-License-Identifier: MIT
package cash.free2z.sdk

import java.net.URI
import java.net.URLDecoder

internal object CallbackPolicy {
    fun accepts(callback: String, expected: String, state: String): Boolean = try {
        val actual = URI(callback)
        val target = URI(expected)
        val states = (actual.rawQuery ?: "").split('&').map {
            val pair = it.split('=', limit = 2)
            URLDecoder.decode(pair[0], "UTF-8") to URLDecoder.decode(pair.getOrElse(1) { "" }, "UTF-8")
        }.filter { it.first == "state" }
        callback.toByteArray(Charsets.UTF_8).size <= 16384 && actual.rawFragment == null &&
            actual.rawUserInfo == null && actual.scheme == target.scheme &&
            actual.rawAuthority == target.rawAuthority && actual.rawPath == target.rawPath &&
            states.size == 1 && states[0].second == state
    } catch (_: Exception) { false }
}
