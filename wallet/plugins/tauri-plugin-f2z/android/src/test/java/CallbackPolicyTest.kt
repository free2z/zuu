package cash.free2z.sdk
import org.junit.Assert.*
import org.junit.Test
class CallbackPolicyTest {
    @Test fun exactCallbackAndSingleStateOnly() {
        val target = "https://app.example/oauth/callback"
        assertTrue(CallbackPolicy.accepts("$target?code=x&state=expected&iss=https%3A%2F%2Ffree2z.cash", target, "expected"))
        for (bad in listOf(
            "https://evil.example/oauth/callback?state=expected",
            "$target/other?state=expected", "$target?state=wrong", "$target?state=expected&state=expected",
            "$target?state=expected#fragment", "https://user@app.example/oauth/callback?state=expected",
            "https://app.example/oauth%2Fcallback?state=expected", "$target?state=%ZZ"
        )) assertFalse(bad, CallbackPolicy.accepts(bad, target, "expected"))
    }
    @Test fun privateSchemeAndBounds() {
        val target = "com.example.tutor:/oauth/callback"
        assertTrue(CallbackPolicy.accepts("$target?state=abc", target, "abc"))
        assertFalse(CallbackPolicy.accepts("$target?state=abc&code=" + "x".repeat(17000), target, "abc"))
    }
}
