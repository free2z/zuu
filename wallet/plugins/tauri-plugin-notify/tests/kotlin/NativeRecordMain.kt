package cash.free2z.notify
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
fun canonical(value: JSONObject): String {
    val copy=JSONObject(value.toString())
    if (copy.has("lease")) copy.put("lease",JSONObject(copy.getString("lease")))
    fun render(v: Any?): String = when(v) {
        is JSONObject -> v.keys().asSequence().toList().sorted().joinToString(",","{","}") { JSONObject.quote(it)+":"+render(v.get(it)) }
        is String -> JSONObject.quote(v)
        else -> v.toString()
    }
    return render(copy)
}
fun main(args: Array<String>) {
    val fixtures=JSONArray(File(args.single()).readText())
    for (i in 0 until fixtures.length()) {
        val f=fixtures.getJSONObject(i);val state=JSONObject(f.getJSONObject("before").toString());var rejected=false
        try {
            when(f.getString("operation")) {
                "stop" -> NotificationRecord.stop(state)
                "begin" -> NotificationRecord.begin(state,f.getString("revision"),f.getString("lease"))
                "save" -> NotificationRecord.save(state,f.getString("revision"),f.getString("lease"))
                "clear" -> NotificationRecord.clear(state,f.getString("revision"))
                "token" -> NotificationRecord.token(state,f.getString("revision"),f.getString("token"))
                else -> error("unknown fixture")
            }
        } catch (_: IllegalArgumentException) { rejected=true }
        check(rejected==f.optBoolean("reject")) { f.getString("name")+": rejection" }
        check(canonical(state)==canonical(f.getJSONObject("after"))) { f.getString("name")+": persisted state" }
    }
    println("Kotlin production secure-record transitions: ${fixtures.length()} fixtures passed (JVM only; no Android SDK/device claim)")
}
