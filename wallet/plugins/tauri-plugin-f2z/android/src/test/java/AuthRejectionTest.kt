package cash.free2z.sdk
import org.junit.Assert.*
import org.junit.Test
class AuthRejectionTest {
    @Test fun eachEndingRejectsWithTheCodeRustMaps() {
        assertEquals("user_cancelled", AuthRejection.code(AuthRejection.Ending.DISMISSED))
        assertEquals("timeout", AuthRejection.code(AuthRejection.Ending.TIMED_OUT))
        assertEquals("browser_unavailable", AuthRejection.code(AuthRejection.Ending.LAUNCH_FAILED))
        // No code: Rust reports the browser_error fallback.
        assertNull(AuthRejection.code(AuthRejection.Ending.ABANDONED))
    }
    @Test fun distinctEndingsNeverShareACode() {
        val codes = AuthRejection.Ending.values().mapNotNull(AuthRejection::code)
        assertEquals(codes.size, codes.toSet().size)
    }
}
