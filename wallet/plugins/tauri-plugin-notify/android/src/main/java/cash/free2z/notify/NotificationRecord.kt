package cash.free2z.notify
import org.json.JSONObject

/** Exact secure-record transitions, serialized by Vault.mutate's monitor. */
internal object NotificationRecord {
    fun revision(s: JSONObject): String = s.optString("revision","0")
    fun next(s: JSONObject): String { val n=revision(s).toLong(); require(n in 0 until 9007199254740991L); return (n+1).toString() }
    fun active(s: JSONObject, now: Long=System.currentTimeMillis()/1000): Boolean {
        if (s.optString("enabled") != "1" || !s.has("lease")) return false
        val l=JSONObject(s.getString("lease"))
        return !l.optBoolean("disabled",true) && l.optString("consent")==revision(s) && l.optLong("expires")>now
    }
    fun begin(s: JSONObject, expected: String, text: String) {
        require(revision(s)==expected && s.optString("enabled")!="1" && !s.has("lease"))
        val l=JSONObject(text); val next=next(s)
        require(l.getString("consent")==next && !l.getBoolean("disabled") && text.toByteArray().size<=16384)
        s.put("revision",next);s.put("enabled","1");s.put("lease",text);s.remove("token");s.remove("pending")
    }
    fun save(s: JSONObject, expected: String, text: String) {
        require(active(s) && revision(s)==expected && text.toByteArray().size<=16384)
        val old=JSONObject(s.getString("lease"));val l=JSONObject(text)
        require(l.getString("consent")==expected && !l.getBoolean("disabled") && l.getLong("expires")==old.getLong("expires"))
        for (key in listOf("queue","manage","send")) require(l.getString(key)==old.getString(key))
        s.put("lease",text)
    }
    fun stop(s: JSONObject) {
        val next=next(s)
        if (s.has("lease")) { val l=JSONObject(s.getString("lease"));l.put("disabled",true);s.put("lease",l.toString()) }
        s.put("enabled","0");s.put("revision",next);s.remove("token");s.remove("pending")
    }
    fun clear(s: JSONObject, expected: String) {
        require(s.optString("enabled")!="1" && revision(s)==expected)
        s.remove("lease");s.remove("token");s.remove("pending");s.put("enabled","0");s.put("revision",expected)
    }
    fun token(s: JSONObject, expected: String, token: String): Boolean {
        if (!active(s) || revision(s)!=expected) return false
        val changed=s.optString("token")!=token;s.put("token",token);return changed
    }
}
