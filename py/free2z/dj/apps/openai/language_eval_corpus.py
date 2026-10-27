"""The close-pair evaluation corpus for:mod:`f2z.ai.language`.

Detection asks a model for a BCP-47 tag. For ``en`` vs ``ja`` that is trivial.
For the pairs in this file it is a judgement call, and a wrong call mislabels an
article, picks the wrong translation source and puts the wrong ``hreflang`` in
front of a crawler.  grows ``TRANSLATABLE`` past 50, which adds most of
these pairs at once, so this corpus exists to say *how well* detection does on
them rather than assuming.

**What is in here is data, not assertions.** ``test_language_detection_evals.py``
holds every assertion; this module holds the samples, the discriminating markers
and the loader.

Why markers, and not just gold labels
-------------------------------------
Every member of every pair declares a short list of **exclusive markers** —
words (or, for Chinese, characters) that a writer of that language uses and a
writer of the sibling language does not. ``hljeb``/``hleb``/``kruh``,
``ikke``/``ikkje``, ``muy``/``moi``/``muito``, 唔/不.

They earn their place three times over:

1. **They keep the corpus honest.** A sample labelled ``nn`` that contains
   ``ikke`` and no ``ikkje`` is mislabelled, and the integrity test says so.
   Authoring 60 samples in 20 languages by hand without that check is how an
   eval ends up measuring the corpus author's Norwegian.
2. **They make "the pair is genuinely separable" a testable claim.** If a
   sample carries no marker of its own language, no model can be expected to
   get it right, and a corpus full of such samples measures nothing.
3. **They make the *input* measurable offline.** Detection sends the model a
   bounded head of the document (:func:`f2z.ai.language.truncate_for_detection`).
   Whether the markers survive into that head is a property of our own code,
   costs nothing to measure, and is a **necessary condition** for a correct
   answer. That is what the code-heavy and mixed-language samples are for.

Marker exclusivity is checked *within a pair*, not globally: ``hva`` is a
Norwegian Bokmål marker against Nynorsk ``kva`` and against Danish ``hvad``, and
it appears in both pair groups with a different sibling each time. A sample
therefore belongs to exactly one pair, and separate samples are authored for a
language that appears in two pairs.

Provenance
----------
Every sample is original prose written for this corpus — not copied from a
source with its own licence, and not machine-translated (a machine translation
is exactly the distribution a detector is least likely to disagree with, which
would flatter the score). They are short, ordinary, encyclopaedic sentences of
the kind a zPage opens with.
"""

import dataclasses
import functools
import unicodedata


#Kinds of sample. The last three are the known-hard inputs  asks for.
KIND_CLEAN = "clean"           # a paragraph of ordinary prose
KIND_SHORT = "short"           # under SPARSE_SAMPLE_CHARS: a title-only zPage
KIND_MIXED = "mixed"           # two languages in one document
KIND_CODE = "code"             # prose is a minority of the bytes
KIND_ROMANIZED = "romanized"   # a language written outside its usual script

KINDS = (KIND_CLEAN, KIND_SHORT, KIND_MIXED, KIND_CODE, KIND_ROMANIZED)


#Separating markers per pair member.
#
#The lists within one pair MUST be pairwise disjoint as strings (asserted),
#and a sample must contain at least two of its own and none of a sibling's
#(asserted). Matching is whole-word for alphabetic scripts and substring for
#scripts written without spaces — see:func:`contains_marker`.
#
#"Separating", not "unique in the world": Bosnian ``uslov`` is ordinary
#Serbian too, it just is not Croatian ``uvjet``. What the assertions buy is
#that each sample carries evidence of its own label and none of its sibling's
#listed evidence — a corpus-integrity device, not a claim about the language.
#Where a marker really is decisive it is called out in the pair's note.
PAIRS = {
    # ------------------------------------------------------------------ #
    # The one  is named after. Both members are written in traditional
    # Han characters, so no script heuristic can separate them; the evidence
    # is lexical and grammatical.
    # ------------------------------------------------------------------ #
    "yue-vs-zh": {
        "note": (
            "Vernacular written Cantonese against Standard Written Chinese. "
            "係 is deliberately NOT a Cantonese marker here: it is a normal "
            "part of 關係/係數 in Standard Written Chinese and would fire on a "
            "zh-Hant sample."
        ),
        "members": {
            "yue-Hant": ["唔", "嘅", "喺", "佢哋", "咗", "乜嘢", "冇", "點解"],
            "zh-Hant": ["什麼", "沒有", "他們", "這個", "怎麼", "為什麼"],
            "zh-Hans": ["什么", "没有", "他们", "这个", "怎么", "为什么"],
        },
    },
    # ------------------------------------------------------------------ #
    # One language, two scripts — trivially separable in script, and the
    # romanized samples are where it stops being trivial.
    # ------------------------------------------------------------------ #
    "ja-vs-zh": {
        "note": (
            "Not a close pair in the usual sense — but the Chinese rule is "
            "appended to the system prompt for ANY document containing Han "
            "characters, which includes every Japanese one. This pair is the "
            "control that says so: a kanji-heavy Japanese document must "
            "still come back `ja`, not talked into `zh` by a rule about "
            "Chinese that it triggered by existing."
        ),
        "members": {
            "ja": ["です", "ます", "して", "という", "ので"],
            "zh-Hant": ["什麼", "沒有", "他們", "這個", "怎麼"],
        },
    },
    "hi-vs-ur": {
        "note": (
            "Devanagari vs Perso-Arabic is a script test a regex could pass. "
            "The romanized samples are the real one: in Latin script the two "
            "differ only by register (Sanskritic vs Perso-Arabic lexis)."
        ),
        "members": {
            "hi": ["है", "हैं", "नहीं", "शिक्षा", "विद्यालय", "प्रश्न"],
            "ur": ["ہے", "ہیں", "نہیں", "تعلیم", "مدرسہ", "سوال"],
        },
    },
    "hi-vs-ur-romanized": {
        "note": (
            "Hindi and Urdu written in Latin script. Same grammar, same core "
            "vocabulary; only the learned register differs. This pair is "
            "expected to score badly and is here to be reported, not tuned. "
            "Gold is the SCRIPTED tag (hi-Latn/ur-Latn) because that is what "
            "the system prompt asks for; the bare tag is in `accept`, since "
            "`hi` for romanized Hindi is not a wrong answer, only a less "
            "specific one."
        ),
        "members": {
            "hi-Latn": ["shiksha", "vidyalaya", "prashn", "adhyapak",
                        "vidyarthi"],
            "ur-Latn": ["taleem", "madrasa", "sawal", "ustad", "talib"],
        },
    },
    "id-vs-ms": {
        "note": (
            "Indonesian and Malay. `boleh` is not a marker: it is ordinary "
            "Indonesian for 'may'. The separating evidence is orthographic "
            "(-tas/-ti) and lexical (karena/kerana)."
        ),
        "members": {
            "id": ["bisa", "karena", "kualitas", "aktivitas", "sepeda"],
            "ms": ["kerana", "kualiti", "aktiviti", "basikal", "sahaja"],
        },
    },
    "nb-vs-nn": {
        "note": (
            "The two written standards of Norwegian. `boka` is not a marker: "
            "it is a legal Bokmål feminine definite."
        ),
        "members": {
            "nb": ["ikke", "jeg", "hva", "hvordan", "mye"],
            "nn": ["ikkje", "eg", "kva", "korleis", "mykje"],
        },
    },
    "da-vs-nb": {
        "note": (
            "Danish and Bokmål share most of their vocabulary; the evidence "
            "is a handful of high-frequency spellings (af/av, hvad/hva)."
        ),
        "members": {
            "da": ["af", "hvad", "sådan", "sprog", "spørgsmål"],
            "nb": ["av", "hva", "sånn", "språk", "spørsmål"],
        },
    },
    "cs-vs-sk": {
        "note": "Czech and Slovak, separated by minimal pairs.",
        "members": {
            "cs": ["který", "jsem", "může", "město", "řekl"],
            "sk": ["ktorý", "som", "môže", "mesto", "povedal"],
        },
    },
    "bs-vs-hr-vs-sr": {
        "note": (
            "Bosnian, Croatian and Serbian in Latin script. Croatian is "
            "separated lexically (kruh/tisuća/tjedan), Serbian by the ekavian "
            "reflex (hleb/mleko/vreme) and Bosnian by ijekavian + the shared "
            "Serbo-Croatian lexis Croatian replaced. A Cyrillic sample is "
            "included as the easy control the other three are measured against."
        ),
        "members": {
            "hr": ["tko", "kruh", "tisuća", "tjedan", "uvjet"],
            "bs": ["hljeb", "hiljada", "sedmica", "uslov", "ćevapi"],
            "sr-Latn": ["hleb", "opština", "mleko", "vreme", "posle"],
            # Cyrillic is the usual script for Serbian, so the BCP-47
            # convention the system prompt states asks for a bare `sr` here,
            # exactly as it asks for a bare `hi` on Devanagari Hindi. The
            # explicit `sr-Cyrl` is accepted rather than required.
            "sr": ["хлеб", "општина", "млеко", "време", "после"],
        },
    },
    "fa-vs-ps-vs-ur": {
        "note": (
            "Three Perso-Arabic script languages. Pashto has letters neither "
            "of the others has (ښ ټ ړ ڼ), Urdu has ے and ہ, Persian has "
            "neither — so this pair IS separable from the letter inventory "
            "alone, which makes it the control for fa-vs-ps-vs-ur's harder "
            "cousin above."
        ),
        "members": {
            "fa": ["است", "این", "برای", "هستند", "می‌کند"],
            "ps": ["دی", "لري", "چې", "ښه", "کوي"],
            "ur": ["ہے", "ہیں", "کے", "ہوتا", "کیا"],
        },
    },
    "hi-vs-mr-vs-ne": {
        "note": (
            "Three languages sharing Devanagari. The copula is the cleanest "
            "signal: है/हैं (Hindi), आहे/आहेत (Marathi), छ/छन् (Nepali). "
            "`को` is NOT a Hindi marker: it is the Nepali genitive."
        ),
        "members": {
            "hi": ["है", "हैं", "नहीं", "रहा", "लिए"],
            "mr": ["आहे", "आहेत", "नाही", "आणि", "मध्ये"],
            "ne": ["छ", "छन्", "गरेको", "भएको", "हुन्छ"],
        },
    },
    "es-vs-gl-vs-pt": {
        "note": (
            "Galician sits between Spanish and Portuguese and is the reason "
            "this is a triple: it takes ñ/ll from Spanish orthography and "
            "most of its lexis from the Portuguese side."
        ),
        "members": {
            "es": ["muy", "también", "año", "hacer", "ella"],
            "gl": ["moi", "tamén", "facer", "unha", "mañá"],
            "pt-PT": ["muito", "também", "fazer", "uma", "manhã"],
        },
    },
}


# A ~2.4 kB code block. Long enough that on the live detection path — which
# does NOT de-noise — the prose that follows it falls outside the sampled
# window entirely. That is the point of the KIND_CODE samples.
_CODE_BLOCK = """```python
import dataclasses
import functools
import json
import logging
from typing import Iterable, Mapping, Optional

logger = logging.getLogger(__name__)

DEFAULT_TIMEOUT = 30.0
MAX_RETRIES = 3
BACKOFF_BASE = 0.25


@dataclasses.dataclass(frozen=True)
class Request:
    method: str
    path: str
    headers: Mapping[str, str] = dataclasses.field(default_factory=dict)
    body: Optional[bytes] = None
    timeout: float = DEFAULT_TIMEOUT

    def with_header(self, name: str, value: str) -> "Request":
        headers = dict(self.headers)
        headers[name] = value
        return dataclasses.replace(self, headers=headers)


class Transport:
    def __init__(self, session, base_url: str) -> None:
        self.session = session
        self.base_url = base_url.rstrip("/")

    def send(self, request: Request):
        url = f"{self.base_url}/{request.path.lstrip('/')}"
        for attempt in range(MAX_RETRIES):
            try:
                response = self.session.request(
                    request.method,
                    url,
                    headers=dict(request.headers),
                    data=request.body,
                    timeout=request.timeout,
                )
            except OSError:
                if attempt == MAX_RETRIES - 1:
                    raise
                continue
            if response.status_code < 500:
                return response
        return response


@functools.lru_cache(maxsize=256)
def parse_manifest(raw: str) -> Mapping[str, str]:
    payload = json.loads(raw)
    if not isinstance(payload, dict):
        raise ValueError("manifest must be an object")
    return {str(k): str(v) for k, v in payload.items()}


def iter_batches(items: Iterable, size: int):
    batch = []
    for item in items:
        batch.append(item)
        if len(batch) >= size:
            yield batch
            batch = []
    if batch:
        yield batch
```"""


def _code_sample(lang_prose, repeat=1):
    """A zPage whose body opens with a code fence and ends in prose.

    ``repeat`` exists because the two detection paths have very different
    windows and the interesting boundary is different for each. One copy of
    the fence (~2.3 kB) still fits inside the live path's 500-token head, so
    the prose survives; three copies do not, and the title becomes the only
    human language the live path ever sees. Both cases are in the corpus, and
    the test pins which samples fall on which side.
    """
    return f"{_CODE_BLOCK * repeat}\n\n{lang_prose}"


#The corpus. ``title`` and ``content`` are what a zPage save would pass to
#:func:`f2z.ai.language.detect_language`.
SAMPLES = [
    # ------------------------------------------------------------------ #
    # yue-Hant vs zh-Hant vs zh-Hans
    # ------------------------------------------------------------------ #
    {
        "id": "yue-clean-1",
        "gold": "yue-Hant",
        "pair": "yue-vs-zh",
        "kind": KIND_CLEAN,
        "title": "香港街市點樣行",
        "content": (
            "我今朝去咗街市買餸，見到啲菜好新鮮，不過價錢貴咗好多。"
            "我問阿姐點解會咁貴，佢哋話今年天氣唔好，收成冇往年咁多。"
            "我買完之後仲喺隔籬嗰間舖頭飲杯奶茶，坐低休息一陣先返屋企。"
            "如果你想食平啲，就要早啲去，唔好等到中午先至嚟，嗰陣時乜嘢都賣晒。"
        ),
        "note": "Vernacular Cantonese: verbal 咗, 嘅/喺/佢哋, negation 唔/冇.",
    },
    {
        "id": "yue-clean-2",
        "gold": "yue-Hant",
        "pair": "yue-vs-zh",
        "kind": KIND_CLEAN,
        "title": "點樣揀一部二手單車",
        "content": (
            "揀二手單車嘅時候，最緊要睇下個車架有冇裂痕。"
            "好多人淨係睇個外表，見到啲油漆靚就以為冇問題，其實唔係咁簡單。"
            "你可以問下賣家部車用咗幾耐，平時放喺邊度，有冇淋過雨。"
            "試車嗰陣要試下煞車掣，如果掣唔夠實，就唔好買，"
            "因為維修費隨時貴過部車本身，到時就更加唔抵。"
        ),
        "note": "No Standard Written Chinese marker appears anywhere.",
    },
    {
        "id": "yue-short-1",
        "gold": "yue-Hant",
        "pair": "yue-vs-zh",
        "kind": KIND_SHORT,
        "title": "點解佢哋唔嚟？",
        "content": "今日冇人嚟，唔知點解。",
        "note": "A title-only zPage. 20 characters of evidence.",
    },
    {
        "id": "zh-hant-clean-1",
        "gold": "zh-Hant",
        "pair": "yue-vs-zh",
        "kind": KIND_CLEAN,
        "title": "如何選購一輛二手腳踏車",
        "content": (
            "選購二手腳踏車的時候，最重要的是檢查車架有沒有裂痕。"
            "很多人只看外表，看到烤漆完好就認為這個車子沒有問題，其實並不是這樣。"
            "你可以詢問賣家這輛車使用了多久，平常停放在什麼地方，是否曾經淋雨。"
            "試車的時候一定要測試煞車，如果煞車不夠確實就不要購買，"
            "因為修理費用隨時可能超過車子本身的價格。"
        ),
        "note": (
            "Deliberately the same subject as yue-clean-2: the pair is the "
            "register, not the topic."
        ),
    },
    {
        "id": "zh-hant-clean-2",
        "gold": "zh-Hant",
        "pair": "yue-vs-zh",
        "kind": KIND_CLEAN,
        "title": "傳統市場的採買指南",
        "content": (
            "今天早上我到傳統市場買菜，蔬菜看起來相當新鮮，不過價格比去年高了許多。"
            "我問攤商為什麼會這麼貴，他們說今年天氣不好，收成沒有往年那麼多。"
            "買完之後我在隔壁那家店喝了一杯奶茶，坐下來休息一會兒才回家。"
            "如果想買得便宜一些，就要早一點出門，不要等到中午才來。"
        ),
        "note": "Standard Written Chinese in traditional script.",
    },
    {
        "id": "zh-hant-short-1",
        "gold": "zh-Hant",
        "pair": "yue-vs-zh",
        "kind": KIND_SHORT,
        "title": "他們為什麼沒有來？",
        "content": "今天沒有人來，不知道為什麼。",
        "note": "The Standard Written Chinese counterpart of yue-short-1.",
    },
    {
        "id": "zh-hans-clean-1",
        "gold": "zh-Hans",
        "pair": "yue-vs-zh",
        "kind": KIND_CLEAN,
        "title": "传统市场的采买指南",
        "content": (
            "今天早上我到传统市场买菜，蔬菜看起来相当新鲜，不过价格比去年高了许多。"
            "我问摊商为什么会这么贵，他们说今年天气不好，收成没有往年那么多。"
            "买完之后我在隔壁那家店喝了一杯奶茶，坐下来休息一会儿才回家。"
            "如果想买得便宜一些，就要早一点出门，不要等到中午才来。"
        ),
        "note": (
            "The bare-macrolanguage case: a correct detector may answer "
            "zh-Hans, zh, or cmn. Only one of the three is sellable."
        ),
    },
    {
        "id": "zh-hans-short-1",
        "gold": "zh-Hans",
        "pair": "yue-vs-zh",
        "kind": KIND_SHORT,
        "title": "他们为什么没有来？",
        "content": "今天没有人来，不知道为什么。",
        "note": "Simplified script, short.",
    },
    {
        "id": "yue-code-1",
        "gold": "yue-Hant",
        "pair": "yue-vs-zh",
        "kind": KIND_CODE,
        "title": "用 Python 寫個簡單嘅 HTTP client",
        "content": _code_sample(
            "上面呢段代碼係一個好簡單嘅 HTTP client。"
            "如果你想加重試機制，可以改下 MAX_RETRIES 嗰個常數。"
            "我自己平時唔會將 timeout 設得太短，因為有啲 API 真係好慢，"
            "設得太短就會無端端斷線，到時仲難查問題出喺邊度。"
        ),
        "note": (
            "Prose is ~11% of the document and all of it is AFTER the fence. "
            "The title is the only Cantonese inside the live path's window."
        ),
    },
    {
        "id": "yue-code-2",
        "gold": "yue-Hant",
        "pair": "yue-vs-zh",
        "kind": KIND_CODE,
        "title": "三個版本嘅 HTTP client 對照",
        "content": _code_sample(
            "上面三段代碼係同一個 client 嘅三個版本。"
            "如果你淨係睇最後嗰段，好易以為前面兩段冇用，其實唔係。"
            "我保留晒佢哋係想講點解最後要咁寫，唔係想你照抄。",
            repeat=3,
        ),
        "note": (
            "Code alone exceeds the live path's window, so the title is the "
            "only Cantonese the model sees. One marker (嘅), not two."
        ),
    },
    {
        "id": "zh-hant-mixed-1",
        "gold": "zh-Hant",
        "pair": "yue-vs-zh",
        "kind": KIND_MIXED,
        "title": "讀書筆記：The Pragmatic Programmer",
        "segments": [
            ("en", (
                "Every piece of knowledge must have a single, unambiguous, "
                "authoritative representation within a system. Duplication "
                "is not a matter of typing the same characters twice."
            )),
            ("zh-Hant", (
                "上面這段話說的是知識的單一來源，這個道理在什麼樣的系統裡都成立。"
                "他們在書裡舉了很多例子，說明為什麼重複的定義最後一定會分歧，"
                "而且分歧的時候沒有任何工具會告訴你。這本書我讀了兩遍，"
                "第一遍只覺得作者說得有道理，第二遍才發現裡面每一條建議"
                "都可以對應到我自己寫過的某一段程式碼，而那些程式碼"
                "後來沒有一段不是因為同樣的原因被改寫的。"
                "如果要我只留一句話，我會留這一句：重複的不是文字，"
                "是必須一起改的兩個地方。其他的規則都可以從這句推出來，"
                "而且推出來的版本比原文更適合自己的專案。"
            )),
        ],
        "note": (
            "A quotation in English, then the article itself in Chinese. The "
            "Chinese body is the clear majority (asserted from `segments`), "
            "but the HEAD of the document is entirely English — which is the "
            "only part the batch sampler ever sees."
        ),
    },

    # ------------------------------------------------------------------ #
    # ja vs zh — the control for the Han-triggered prompt rule
    # ------------------------------------------------------------------ #
    {
        "id": "ja-clean-1",
        "gold": "ja",
        "pair": "ja-vs-zh",
        "kind": KIND_CLEAN,
        "title": "中古自転車の選び方",
        "content": (
            "中古の自転車を買うときは、まず車体の枠を確認するのが大切です。"
            "塗装がきれいだから大丈夫だと思う人が多いのですが、"
            "外から見ただけでは判断できません。"
            "どのくらい使っていたのか、普段どこに置いていたのか、"
            "雨に濡れたことがあるのかを聞いてみるとよいでしょう。"
            "修理代が本体の値段を超えることもあるので、"
            "面倒でも確認してから買うことをおすすめします。"
        ),
        "note": (
            "Kanji-heavy Japanese: the Han rule fires, and the answer must "
            "still be ja."
        ),
    },
    {
        "id": "ja-short-1",
        "gold": "ja",
        "pair": "ja-vs-zh",
        "kind": KIND_SHORT,
        "title": "これは何ですか",
        "content": "今日は誰も来ないので、そのままにしておきます。",
        "note": "Short Japanese, with kanji present.",
    },
    {
        "id": "zh-hant-clean-3",
        "gold": "zh-Hant",
        "pair": "ja-vs-zh",
        "kind": KIND_CLEAN,
        "title": "中古腳踏車的挑選方式",
        "content": (
            "購買中古腳踏車時，最重要的是先確認車架。"
            "很多人覺得烤漆完好就沒有問題，其實從外表看不出來。"
            "可以問問這個車子用了多久、平常放在什麼地方、有沒有淋過雨。"
            "修理的費用有時候會超過車子本身的價格，"
            "所以就算麻煩，也應該確認清楚再買。他們通常都很願意回答。"
        ),
        "note": "The same article in Standard Written Chinese.",
    },
    {
        "id": "zh-hant-short-2",
        "gold": "zh-Hant",
        "pair": "ja-vs-zh",
        "kind": KIND_SHORT,
        "title": "這個是什麼？",
        "content": "今天沒有人來，他們都不知道。",
        "note": "Short traditional-script Chinese against Japanese.",
    },

    # ------------------------------------------------------------------ #
    # hi vs ur (script), then romanized
    # ------------------------------------------------------------------ #
    {
        "id": "hi-clean-1",
        "gold": "hi",
        "pair": "hi-vs-ur",
        "kind": KIND_CLEAN,
        "title": "गाँव का विद्यालय",
        "content": (
            "हमारे गाँव का विद्यालय नदी के पास है और वहाँ आठवीं कक्षा तक पढ़ाई होती है। "
            "शिक्षा का स्तर पहले जैसा नहीं है, लेकिन अध्यापक अब भी मेहनत करते हैं। "
            "बच्चे सुबह पैदल आते हैं और दोपहर तक पढ़ते हैं। "
            "जो प्रश्न उन्हें समझ नहीं आते, वे कक्षा के बाद पूछ लेते हैं।"
        ),
        "note": "Devanagari, Sanskritic register.",
    },
    {
        "id": "hi-short-1",
        "gold": "hi",
        "pair": "hi-vs-ur",
        "kind": KIND_SHORT,
        "title": "यह सही नहीं है",
        "content": "यह प्रश्न कठिन है।",
        "note": "Short Hindi.",
    },
    {
        "id": "ur-clean-1",
        "gold": "ur",
        "pair": "hi-vs-ur",
        "kind": KIND_CLEAN,
        "title": "گاؤں کا مدرسہ",
        "content": (
            "ہمارے گاؤں کا مدرسہ دریا کے قریب ہے اور وہاں آٹھویں جماعت تک پڑھائی ہوتی ہے۔ "
            "تعلیم کا معیار پہلے جیسا نہیں ہے، لیکن استاد اب بھی محنت کرتے ہیں۔ "
            "بچے صبح پیدل آتے ہیں اور دوپہر تک پڑھتے ہیں۔ "
            "جو سوال انہیں سمجھ نہیں آتے، وہ جماعت کے بعد پوچھ لیتے ہیں۔"
        ),
        "note": "The same text as hi-clean-1 in Urdu register and script.",
    },
    {
        "id": "ur-short-1",
        "gold": "ur",
        "pair": "hi-vs-ur",
        "kind": KIND_SHORT,
        "title": "یہ درست نہیں ہے",
        "content": "یہ سوال مشکل ہے۔",
        "note": "Short Urdu.",
    },
    {
        "id": "hi-romanized-1",
        "gold": "hi-Latn",
        "accept": ["hi"],
        "pair": "hi-vs-ur-romanized",
        "kind": KIND_ROMANIZED,
        "title": "Gaon ka vidyalaya",
        "content": (
            "Hamare gaon ka vidyalaya nadi ke paas hai aur wahan aathvin "
            "kaksha tak padhai hoti hai. Shiksha ka star pehle jaisa nahin "
            "hai, lekin adhyapak ab bhi mehnat karte hain. Jo prashn "
            "vidyarthi ko samajh nahin aate, ve kaksha ke baad puch lete hain."
        ),
        "note": (
            "Expected-hard. A detector may reasonably answer hi, ur, or a "
            "Latin-script language entirely."
        ),
    },
    {
        "id": "ur-romanized-1",
        "gold": "ur-Latn",
        "accept": ["ur"],
        "pair": "hi-vs-ur-romanized",
        "kind": KIND_ROMANIZED,
        "title": "Gaon ka madrasa",
        "content": (
            "Hamare gaon ka madrasa darya ke qareeb hai aur wahan aathvin "
            "jamaat tak parhai hoti hai. Taleem ka mayaar pehle jaisa nahin "
            "hai, lekin ustad ab bhi mehnat karte hain. Jo sawal talib ilm "
            "ko samajh nahin aate, woh jamaat ke baad puch lete hain."
        ),
        "note": "Expected-hard; same sentence, Perso-Arabic register.",
    },

    # ------------------------------------------------------------------ #
    # id vs ms
    # ------------------------------------------------------------------ #
    {
        "id": "id-clean-1",
        "gold": "id",
        "pair": "id-vs-ms",
        "kind": KIND_CLEAN,
        "title": "Memilih sepeda bekas",
        "content": (
            "Saat membeli sepeda bekas, hal pertama yang perlu diperiksa "
            "adalah rangkanya. Banyak orang hanya melihat catnya dan mengira "
            "sepeda itu masih bagus, padahal kualitas rangka tidak bisa "
            "dinilai dari luar. Tanyakan berapa lama sepeda itu dipakai dan "
            "di mana biasanya disimpan, karena aktivitas di luar ruangan "
            "membuat besi cepat berkarat."
        ),
        "note": "Indonesian: bisa, karena, kualitas, aktivitas, sepeda.",
    },
    {
        "id": "id-short-1",
        "gold": "id",
        "pair": "id-vs-ms",
        "kind": KIND_SHORT,
        "title": "Aktivitas dibatalkan karena hujan",
        "content": "Saya tidak bisa datang.",
        "note": "Short Indonesian.",
    },
    {
        "id": "ms-clean-1",
        "gold": "ms",
        "pair": "id-vs-ms",
        "kind": KIND_CLEAN,
        "title": "Memilih basikal terpakai",
        "content": (
            "Ketika membeli basikal terpakai, perkara pertama yang perlu "
            "diperiksa ialah rangkanya. Ramai orang hanya melihat catnya "
            "sahaja dan menyangka basikal itu masih elok, padahal kualiti "
            "rangka tidak dapat dinilai dari luar. Tanyakan berapa lama "
            "basikal itu digunakan dan di mana ia biasanya disimpan, kerana "
            "aktiviti di luar membuat besi cepat berkarat."
        ),
        "note": "Malay: kerana, kualiti, aktiviti, basikal, sahaja.",
    },
    {
        "id": "ms-short-1",
        "gold": "ms",
        "pair": "id-vs-ms",
        "kind": KIND_SHORT,
        "title": "Aktiviti dibatalkan kerana hujan",
        "content": "Saya tidak dapat datang.",
        "note": "Short Malay.",
    },
    {
        "id": "id-code-1",
        "gold": "id",
        "pair": "id-vs-ms",
        "kind": KIND_CODE,
        "title": "Membuat klien HTTP sederhana dengan Python",
        "content": _code_sample(
            "Kode di atas adalah klien HTTP yang sangat sederhana. "
            "Kalau ingin menambahkan mekanisme percobaan ulang, ubah saja "
            "nilai MAX_RETRIES. Saya biasanya tidak memasang timeout yang "
            "terlalu pendek, karena ada API yang memang lambat dan kualitas "
            "jaringan tidak selalu stabil."
        ),
        "note": "Prose is a minority of the bytes and sits after the fence.",
    },

    # ------------------------------------------------------------------ #
    # nb vs nn
    # ------------------------------------------------------------------ #
    {
        "id": "nb-clean-1",
        "gold": "nb",
        "pair": "nb-vs-nn",
        "kind": KIND_CLEAN,
        "title": "Hvordan jeg lærte å bake brød",
        "content": (
            "Jeg begynte å bake brød fordi jeg ikke likte det som fantes i "
            "butikken. Det tok mye lengre tid enn jeg trodde å forstå hva "
            "som egentlig skjer i deigen. Hvordan du elter er mindre viktig "
            "enn hvor lenge du lar den hvile, og det er ikke noe du kan lese "
            "deg til på en ettermiddag."
        ),
        "note": "Bokmål: ikke, jeg, hva, hvordan, mye.",
    },
    {
        "id": "nb-short-1",
        "gold": "nb",
        "pair": "nb-vs-nn",
        "kind": KIND_SHORT,
        "title": "Jeg vet ikke hva det er",
        "content": "Hvordan gjør jeg det?",
        "note": "Short Bokmål.",
    },
    {
        "id": "nn-clean-1",
        "gold": "nn",
        "pair": "nb-vs-nn",
        "kind": KIND_CLEAN,
        "title": "Korleis eg lærte å baka brød",
        "content": (
            "Eg byrja å baka brød fordi eg ikkje likte det som fanst i "
            "butikken. Det tok mykje lengre tid enn eg trudde å forstå kva "
            "som eigentleg skjer i deigen. Korleis du eltar er mindre viktig "
            "enn kor lenge du lèt han kvila, og det er ikkje noko du kan "
            "lesa deg til på ein ettermiddag."
        ),
        "note": "Nynorsk: ikkje, eg, kva, korleis, mykje.",
    },
    {
        "id": "nn-short-1",
        "gold": "nn",
        "pair": "nb-vs-nn",
        "kind": KIND_SHORT,
        "title": "Eg veit ikkje kva det er",
        "content": "Korleis gjer eg det?",
        "note": "Short Nynorsk.",
    },

    # ------------------------------------------------------------------ #
    # da vs nb
    # ------------------------------------------------------------------ #
    {
        "id": "da-clean-1",
        "gold": "da",
        "pair": "da-vs-nb",
        "kind": KIND_CLEAN,
        "title": "Et spørgsmål om sprog",
        "content": (
            "Det er et spørgsmål om sprog, og ikke kun om ord. Hvad vi "
            "kalder tingene ændrer sådan set hvordan vi ser dem, og det "
            "gælder også for et fag der ellers påstår at være neutralt. En "
            "stor del af diskussionen handler af den grund om hvem der får "
            "lov til at navngive."
        ),
        "note": "Danish: af, hvad, sådan, sprog, spørgsmål.",
    },
    {
        "id": "da-short-1",
        "gold": "da",
        "pair": "da-vs-nb",
        "kind": KIND_SHORT,
        "title": "Hvad er det for et sprog?",
        "content": "Et spørgsmål af den slags.",
        "note": "Short Danish.",
    },
    {
        "id": "nb-clean-2",
        "gold": "nb",
        "pair": "da-vs-nb",
        "kind": KIND_CLEAN,
        "title": "Et spørsmål om språk",
        "content": (
            "Det er et spørsmål om språk, og ikke bare om ord. Hva vi kaller "
            "tingene endrer sånn sett hvordan vi ser dem, og det gjelder "
            "også for et fag som ellers påstår å være nøytralt. En stor del "
            "av diskusjonen handler av den grunn om hvem som får lov til å "
            "navngi."
        ),
        "note": "The same text in Bokmål: av, hva, sånn, språk, spørsmål.",
    },
    {
        "id": "nb-short-2",
        "gold": "nb",
        "pair": "da-vs-nb",
        "kind": KIND_SHORT,
        "title": "Hva er det for et språk?",
        "content": "Et spørsmål av det slaget.",
        "note": "Short Bokmål against Danish.",
    },

    # ------------------------------------------------------------------ #
    # cs vs sk
    # ------------------------------------------------------------------ #
    {
        "id": "cs-clean-1",
        "gold": "cs",
        "pair": "cs-vs-sk",
        "kind": KIND_CLEAN,
        "title": "Město, které se nedá obejít",
        "content": (
            "Je to město, které se nedá obejít za jediný den. Řekl bych, že "
            "nejlepší je začít u řeky a vydat se nahoru, protože odtud "
            "člověk může vidět, jak je celá kotlina uspořádaná. Byl jsem tam "
            "na podzim a doporučuji stejné období každému, kdo nemá rád davy."
        ),
        "note": "Czech: který, jsem, může, město, řekl.",
    },
    {
        "id": "cs-short-1",
        "gold": "cs",
        "pair": "cs-vs-sk",
        "kind": KIND_SHORT,
        "title": "Který den to může být?",
        "content": "Řekl jsem to včera.",
        "note": "Short Czech.",
    },
    {
        "id": "sk-clean-1",
        "gold": "sk",
        "pair": "cs-vs-sk",
        "kind": KIND_CLEAN,
        "title": "Mesto, ktoré sa nedá obísť",
        "content": (
            "Je to mesto, ktoré sa nedá obísť za jediný deň. Povedal by som, "
            "že najlepšie je začať pri rieke a vydať sa nahor, pretože "
            "odtiaľ človek môže vidieť, ako je celá kotlina usporiadaná. Bol "
            "som tam na jeseň a odporúčam rovnaké obdobie každému, kto nemá "
            "rád davy."
        ),
        "note": "Slovak: ktorý, som, môže, mesto, povedal.",
    },
    {
        "id": "sk-short-1",
        "gold": "sk",
        "pair": "cs-vs-sk",
        "kind": KIND_SHORT,
        "title": "Ktorý deň to môže byť?",
        "content": "Povedal som to včera.",
        "note": "Short Slovak.",
    },

    # ------------------------------------------------------------------ #
    # bs vs hr vs sr
    # ------------------------------------------------------------------ #
    {
        "id": "hr-clean-1",
        "gold": "hr",
        "pair": "bs-vs-hr-vs-sr",
        "kind": KIND_CLEAN,
        "title": "Tko još peče kruh kod kuće",
        "content": (
            "Tko još peče kruh kod kuće, zna da je jedini pravi uvjet "
            "strpljenje. Prošli tjedan sam pokušao s novim brašnom i "
            "rezultat je bio bolji nego u tisuću prijašnjih pokušaja. "
            "Tijesto treba odmarati dulje nego što većina recepata "
            "predlaže, a pećnicu zagrijati jače."
        ),
        "note": "Croatian: tko, kruh, tisuća, tjedan, uvjet.",
    },
    {
        "id": "hr-short-1",
        "gold": "hr",
        "pair": "bs-vs-hr-vs-sr",
        "kind": KIND_SHORT,
        "title": "Tko je kupio kruh?",
        "content": "Prošli tjedan, tisuću puta.",
        "note": "Short Croatian.",
    },
    {
        "id": "bs-clean-1",
        "gold": "bs",
        "pair": "bs-vs-hr-vs-sr",
        "kind": KIND_CLEAN,
        "title": "Ko još peče hljeb kod kuće",
        "content": (
            "Ko još peče hljeb kod kuće, zna da je jedini pravi uslov "
            "strpljenje. Prošle sedmice sam pokušao s novim brašnom i "
            "rezultat je bio bolji nego ikad. Od hiljada ranijih "
            "pokušaja nijedan nije bio ovakav. "
            "Tijesto treba odmarati duže nego što većina recepata "
            "predlaže, a ćevapi su sasvim druga priča."
        ),
        "note": "Bosnian: hljeb, hiljada, sedmica, uslov, ćevapi.",
    },
    {
        "id": "bs-short-1",
        "gold": "bs",
        "pair": "bs-vs-hr-vs-sr",
        "kind": KIND_SHORT,
        "title": "Ko je kupio hljeb?",
        "content": "Prošle sedmice, hiljada puta.",
        "note": "Short Bosnian.",
    },
    {
        "id": "sr-latn-clean-1",
        "gold": "sr-Latn",
        "pair": "bs-vs-hr-vs-sr",
        "kind": KIND_CLEAN,
        "title": "Ko još peče hleb kod kuće",
        "content": (
            "Ko još peče hleb kod kuće, zna da je jedini pravi sastojak "
            "strpljenje. Prošle nedelje sam probao novo brašno i rezultat "
            "je bio bolji nego ranije. Testo treba da odmara duže nego što "
            "većina recepata predlaže, a posle pečenja ga ne treba seći dok "
            "se ne ohladi. Uz to ide mleko, a ne voda, i to je razlika koja "
            "se oseti. Naša opština nema boljeg mirisa, a vreme koje "
            "potrošiš na to se isplati."
        ),
        "note": (
            "Serbian in Latin script, ekavian: hleb, opština, mleko, vreme, "
            "posle. The ekavian reflex is the whole separation from Bosnian."
        ),
    },
    {
        "id": "sr-latn-short-1",
        "gold": "sr-Latn",
        "pair": "bs-vs-hr-vs-sr",
        "kind": KIND_SHORT,
        "title": "Ko je kupio hleb?",
        "content": "Posle podne, uz mleko.",
        "note": "Short Serbian in Latin script.",
    },
    {
        "id": "sr-cyrl-clean-1",
        "gold": "sr",
        "accept": ["sr-Cyrl"],
        "pair": "bs-vs-hr-vs-sr",
        "kind": KIND_CLEAN,
        "title": "Ко још пече хлеб код куће",
        "content": (
            "Ко још пече хлеб код куће, зна да је једини прави услов "
            "стрпљење. Прошле недеље сам пробао ново брашно и резултат је "
            "био бољи него раније. Тесто треба да одмара дуже него што "
            "већина рецепата предлаже, а после печења га не треба сећи док "
            "се не охлади. Уз то иде млеко, а не вода. Наша општина нема "
            "бољег мириса, а време које потрошиш на то се исплати."
        ),
        "note": (
            "The easy control: script alone answers it. Gold is bare `sr` "
            "because Cyrillic is Serbian's usual script; `sr-Cyrl` is "
            "accepted."
        ),
    },
    {
        "id": "sr-cyrl-short-1",
        "gold": "sr",
        "accept": ["sr-Cyrl"],
        "pair": "bs-vs-hr-vs-sr",
        "kind": KIND_SHORT,
        "title": "Ко је купио хлеб?",
        "content": "После подне, уз млеко.",
        "note": "Short Serbian in Cyrillic.",
    },

    # ------------------------------------------------------------------ #
    # fa vs ps vs ur
    # ------------------------------------------------------------------ #
    {
        "id": "fa-clean-1",
        "gold": "fa",
        "pair": "fa-vs-ps-vs-ur",
        "kind": KIND_CLEAN,
        "title": "کتابخانه‌ای که هر روز باز است",
        "content": (
            "این کتابخانه هر روز هفته باز است و برای همه رایگان است. "
            "کسانی که در نزدیکی آن زندگی می‌کنند هر بعدازظهر می‌آیند و تا "
            "شب می‌مانند. آن‌ها بیشتر دانشجو هستند. کتابدار می‌گوید که تعداد کتاب‌های "
            "قرض‌گرفته‌شده هر سال بیشتر می‌شود و این نشان می‌دهد که مردم "
            "هنوز کتاب می‌خوانند."
        ),
        "note": "Persian: است, این, برای, هستند, می‌کند.",
    },
    {
        "id": "fa-short-1",
        "gold": "fa",
        "pair": "fa-vs-ps-vs-ur",
        "kind": KIND_SHORT,
        "title": "این برای شما است",
        "content": "آن‌ها اینجا هستند.",
        "note": "Short Persian.",
    },
    {
        "id": "ps-clean-1",
        "gold": "ps",
        "pair": "fa-vs-ps-vs-ur",
        "kind": KIND_CLEAN,
        "title": "کتابتون چې هره ورځ پرانیستی دی",
        "content": (
            "دا کتابتون د اونۍ هره ورځ پرانیستی دی او د ټولو لپاره وړیا دی. "
            "هغه کسان چې نږدې اوسېږي، هره ماښام راځي او تر ناوخته پاتې کېږي. "
            "کتابدار وايي چې د پور اخیستل شویو کتابونو شمېر هر کال زیاتېږي "
            "او دا ښه نښه ده چې خلک لا هم کتاب لولي. دوی په دې اړه ښه نظر "
            "لري او هڅه کوي چې نور کتابونه هم راولي."
        ),
        "note": "Pashto: دی, لري, چې, ښه, کوي — plus ټ/ړ/ږ/ښ.",
    },
    {
        "id": "ps-short-1",
        "gold": "ps",
        "pair": "fa-vs-ps-vs-ur",
        "kind": KIND_SHORT,
        "title": "دا ښه دی چې راغلې",
        "content": "دوی ډېر کتابونه لري.",
        "note": "Short Pashto.",
    },
    {
        "id": "ur-clean-2",
        "gold": "ur",
        "pair": "fa-vs-ps-vs-ur",
        "kind": KIND_CLEAN,
        "title": "لائبریری جو ہر روز کھلی ہے",
        "content": (
            "یہ لائبریری ہفتے کے ہر دن کھلی ہے اور سب کے لیے مفت ہے۔ "
            "جو لوگ قریب رہتے ہیں وہ ہر شام آتے ہیں اور رات تک ٹھہرتے ہیں۔ "
            "لائبریرین کہتا ہے کہ ادھار لی گئی کتابوں کی تعداد ہر سال بڑھ "
            "رہی ہے اور اس سے معلوم ہوتا ہے کہ لوگ اب بھی کتاب پڑھتے ہیں۔ "
            "کیا یہ اچھی خبر نہیں ہے؟"
        ),
        "note": "Urdu: ہے, ہیں, کے, ہوتا, کیا.",
    },
    {
        "id": "ur-short-2",
        "gold": "ur",
        "pair": "fa-vs-ps-vs-ur",
        "kind": KIND_SHORT,
        "title": "کیا یہ آپ کے لیے ہے؟",
        "content": "وہ یہاں ہیں۔",
        "note": "Short Urdu against Persian and Pashto.",
    },

    # ------------------------------------------------------------------ #
    # hi vs mr vs ne (shared Devanagari)
    # ------------------------------------------------------------------ #
    {
        "id": "hi-clean-2",
        "gold": "hi",
        "pair": "hi-vs-mr-vs-ne",
        "kind": KIND_CLEAN,
        "title": "पुरानी साइकिल कैसे चुनें",
        "content": (
            "पुरानी साइकिल खरीदते समय सबसे पहले फ्रेम देखना चाहिए। "
            "बहुत से लोग सिर्फ रंग देखकर सोचते हैं कि साइकिल ठीक है, "
            "लेकिन ऐसा नहीं है। जो साइकिल लंबे समय तक बाहर पड़ी रही हो, "
            "उसमें जंग लग जाता है। इसीलिए खरीदने से पहले पूछना जरूरी है कि "
            "वह कहाँ रखी जाती थी। मैं खुद यह पूछना भूल गया था, क्योंकि उस "
            "दिन मैं जल्दी में खरीद रहा था, और इसी लिए यह सलाह दे रहा हूँ।"
        ),
        "note": "Hindi: है, नहीं, रहा, लिए.",
    },
    {
        "id": "hi-short-2",
        "gold": "hi",
        "pair": "hi-vs-mr-vs-ne",
        "kind": KIND_SHORT,
        "title": "यह ठीक नहीं है",
        "content": "वह कहाँ रहा है?",
        "note": "Short Hindi against Marathi and Nepali.",
    },
    {
        "id": "mr-clean-1",
        "gold": "mr",
        "pair": "hi-vs-mr-vs-ne",
        "kind": KIND_CLEAN,
        "title": "जुनी सायकल कशी निवडावी",
        "content": (
            "जुनी सायकल घेताना सर्वात आधी फ्रेम पाहिली पाहिजे. "
            "बरेच लोक फक्त रंग पाहून सायकल चांगली आहे असे समजतात, "
            "पण तसे नाही. जी सायकल बराच काळ बाहेर ठेवलेली असते, "
            "तिला गंज लागतो. त्यामुळे विकत घेण्याआधी ती कुठे ठेवली "
            "जात होती हे विचारणे आवश्यक आहे आणि तेच लोक विसरतात. "
            "अशा गोष्टी नंतर महाग पडतात आणि दुरुस्तीचे पैसे वाढतात."
        ),
        "note": "Marathi: आहे, नाही, आणि, मध्ये.",
    },
    {
        "id": "mr-short-1",
        "gold": "mr",
        "pair": "hi-vs-mr-vs-ne",
        "kind": KIND_SHORT,
        "title": "हे बरोबर नाही",
        "content": "ते कुठे आहे आणि का?",
        "note": "Short Marathi.",
    },
    {
        "id": "ne-clean-1",
        "gold": "ne",
        "pair": "hi-vs-mr-vs-ne",
        "kind": KIND_CLEAN,
        "title": "पुरानो साइकल कसरी छान्ने",
        "content": (
            "पुरानो साइकल किन्दा सबैभन्दा पहिले फ्रेम हेर्नुपर्छ। "
            "धेरै मानिस रङ मात्र हेरेर साइकल राम्रो छ भन्ने सोच्छन्, "
            "तर त्यस्तो हुँदैन। लामो समय बाहिर राखिएको साइकलमा खिया लाग्छ, "
            "र त्यो पछि समस्या हुन्छ। त्यसैले किन्नुअघि कहाँ राखिएको थियो "
            "भनेर सोध्नु आवश्यक छ। मर्मत गरेको खर्च पछि धेरै हुन्छ र "
            "किनेको मूल्यभन्दा बढी भएको पनि देखिन्छ।"
        ),
        "note": "Nepali: छ, छन्, गरेको, भएको, हुन्छ.",
    },
    {
        "id": "ne-short-1",
        "gold": "ne",
        "pair": "hi-vs-mr-vs-ne",
        "kind": KIND_SHORT,
        "title": "यो ठीक छैन",
        "content": "त्यो कहाँ छ र कसरी हुन्छ?",
        "note": "Short Nepali.",
    },

    # ------------------------------------------------------------------ #
    # es vs gl vs pt
    # ------------------------------------------------------------------ #
    {
        "id": "es-clean-1",
        "gold": "es",
        "pair": "es-vs-gl-vs-pt",
        "kind": KIND_CLEAN,
        "title": "Un año haciendo pan en casa",
        "content": (
            "Llevo un año haciendo pan en casa y lo primero que aprendí es "
            "que la harina importa muy poco comparada con el tiempo. Ella me "
            "decía que había que amasar más, pero en realidad hay que "
            "esperar más. También conviene calentar el horno antes de lo que "
            "dicen las recetas, porque hacer pan es sobre todo cuestión de "
            "temperatura."
        ),
        "note": "Spanish: muy, también, año, hacer, ella.",
    },
    {
        "id": "es-short-1",
        "gold": "es",
        "pair": "es-vs-gl-vs-pt",
        "kind": KIND_SHORT,
        "title": "Es muy tarde este año",
        "content": "Ella también quiere hacer pan.",
        "note": "Short Spanish.",
    },
    {
        "id": "gl-clean-1",
        "gold": "gl",
        "pair": "es-vs-gl-vs-pt",
        "kind": KIND_CLEAN,
        "title": "Unha mañá facendo pan na casa",
        "content": (
            "Levo un ano facendo pan na casa e o primeiro que aprendín é que "
            "a fariña importa moi pouco comparada co tempo. A miña avoa "
            "dicía que había que amasar máis, pero en realidade hai que "
            "agardar máis. Tamén convén quentar o forno antes do que din as "
            "receitas, porque facer pan é sobre todo unha cuestión de "
            "temperatura, e unha mañá enteira non chega."
        ),
        "note": "Galician: moi, tamén, facer, unha, mañá.",
    },
    {
        "id": "gl-short-1",
        "gold": "gl",
        "pair": "es-vs-gl-vs-pt",
        "kind": KIND_SHORT,
        "title": "É moi tarde esta mañá",
        "content": "Tamén quero facer unha cousa.",
        "note": "Short Galician.",
    },
    {
        "id": "pt-clean-1",
        "gold": "pt-PT",
        "pair": "es-vs-gl-vs-pt",
        "kind": KIND_CLEAN,
        "title": "Uma manhã a fazer pão em casa",
        "content": (
            "Faço pão em casa há um ano e a primeira coisa que aprendi é que "
            "a farinha importa muito pouco comparada com o tempo. A minha "
            "avó dizia que era preciso amassar mais, mas na verdade é "
            "preciso esperar mais. Se estiveres a pensar em começar, não "
            "vale a pena comprar nada caro: estou a fazer isto há meses com "
            "uma taça e uma colher. Também convém aquecer o forno antes do "
            "que dizem as receitas, porque fazer pão é sobretudo uma questão "
            "de temperatura, e uma manhã inteira não chega."
        ),
        "note": (
            "European Portuguese: muito, também, fazer, uma, manhã — plus "
            "`estás a fazer` for the region, which the pair markers do not "
            "cover. Without a European construction the gold pt-PT would be "
            "undecidable from the text and a `pt` answer (which normalizes "
            "to pt-BR) would be scored wrong for no reason."
        ),
    },
    {
        "id": "pt-short-1",
        "gold": "pt-PT",
        "pair": "es-vs-gl-vs-pt",
        "kind": KIND_SHORT,
        "title": "É muito tarde esta manhã",
        "content": "Estou a fazer uma coisa e também apanho o comboio.",
        "note": (
            "Short European Portuguese. Note the gold is pt-PT: a bare `pt` "
            "answer normalizes to pt-BR, which is a DIFFERENT sellable "
            "language, so this sample also tests the regional default."
        ),
    },
    {
        "id": "es-mixed-1",
        "gold": "es",
        "pair": "es-vs-gl-vs-pt",
        "kind": KIND_MIXED,
        "title": "Notas sobre un artículo en inglés",
        "segments": [
            ("en", (
                "A system that cannot be reasoned about locally cannot be "
                "maintained by the people who join it later."
            )),
            ("es", (
                "Ese argumento me parece muy bueno, aunque el autor no dice "
                "nada sobre el coste de mantener la abstracción, que es "
                "justamente lo que se paga todos los días. También hay que "
                "decir que hacer un sistema así lleva más de un año, y ella "
                "lo sabe perfectamente porque lo intentó dos veces en la "
                "empresa anterior. La primera vez salió mal porque nadie "
                "quiso escribir la documentación; la segunda salió mal "
                "porque la escribieron y nadie volvió a leerla. Mi "
                "conclusión, después de leer el artículo entero, es que el "
                "problema nunca fue la abstracción sino el número de "
                "personas que tenían que estar de acuerdo antes de cambiarla."
            )),
        ],
        "note": (
            "A quoted claim in English, then the commentary in Spanish. The "
            "Spanish is the clear majority (asserted from `segments`) and the "
            "head is entirely English."
        ),
    },
    {
        "id": "es-code-1",
        "gold": "es",
        "pair": "es-vs-gl-vs-pt",
        "kind": KIND_CODE,
        "title": "Tres versiones del mismo cliente, muy comentadas",
        "content": _code_sample(
            "Las tres versiones anteriores son el mismo cliente. Si sólo "
            "miras la última es fácil pensar que las dos primeras sobran, "
            "pero no es así: las dejo para poder explicar también por qué "
            "hacer la última de esa manera, no para que las copies este año.",
            repeat=3,
        ),
        "note": (
            "The Spanish equivalent of yue-code-2: only the title survives "
            "into the live path's window, and it carries one marker (muy)."
        ),
    },
    {
        "id": "pt-code-1",
        "gold": "pt-PT",
        "pair": "es-vs-gl-vs-pt",
        "kind": KIND_CODE,
        "title": "Um cliente HTTP simples em Python",
        "content": _code_sample(
            "O código acima é um cliente HTTP muito simples. Se quiser "
            "acrescentar um mecanismo de repetição, basta mudar o valor de "
            "MAX_RETRIES. Eu não costumo usar uma manhã inteira a afinar "
            "isto, porque também há APIs lentas e fazer um timeout curto "
            "de mais só cria problemas."
        ),
        "note": "Prose after a long fence; the title is the only early prose.",
    },
]


# --------------------------------------------------------------------------- #
# Loading + marker matching
# --------------------------------------------------------------------------- #
@dataclasses.dataclass(frozen=True)
class Sample:
    id: str
    gold: str
    pair: str
    kind: str
    title: str
    content: str
    note: str
    #Tags other than ``gold`` that are ALSO correct for this sample.
    #
    #Reserved for genuinely under-determined answers — today, only the
    #romanized pair, where a model may reasonably answer ``hi-Latn`` (what
    #the prompt asks for) or ``hi`` (not wrong, just less specific). The
    #integrity test confines it: only KIND_ROMANIZED may use it, and an
    #accepted tag must share a primary language with gold. Without that
    #fence this field is a way to make any eval pass.
    accept: tuple = ()
    #For KIND_MIXED only: ``((tag, text),...)`` in document order.
    #
    #A mixed sample's ``content`` is BUILT from these, so "which language
    #dominates" stops being a claim in a comment and becomes something the
    #integrity test measures. The gold label of a mixed document is the
    #majority language; a sample whose minority language is labelled would
    #score a *correct* detector as wrong, and would then be read as evidence
    #that the detector needs tuning.
    segments: tuple = ()

    @property
    def text(self):
        return f"{self.title}\n\n{self.content}"

    def segment_chars(self):
        """``{tag: characters}`` over the body, for a mixed sample."""
        counts = {}
        for tag, text in self.segments:
            counts[tag] = counts.get(tag, 0) + len(text)
        return counts


@functools.lru_cache(maxsize=1)
def corpus():
    """Every sample, as:class:`Sample` objects, in declaration order."""
    return tuple(
        Sample(
            id=raw["id"],
            gold=raw["gold"],
            pair=raw["pair"],
            kind=raw["kind"],
            title=raw["title"],
            content=raw.get("content") or "\n\n".join(
                text for _tag, text in raw["segments"]
            ),
            note=raw.get("note", ""),
            accept=tuple(raw.get("accept", ())),
            segments=tuple(tuple(part) for part in raw.get("segments", ())),
        )
        for raw in SAMPLES
    )


def by_id(sample_id):
    for sample in corpus():
        if sample.id == sample_id:
            return sample
    raise KeyError(sample_id)


def own_markers(sample):
    """The markers of ``sample``'s own language within its pair."""
    return tuple(PAIRS[sample.pair]["members"][sample.gold])


def rival_markers(sample):
    """Every marker belonging to a *sibling* of ``sample``'s language."""
    members = PAIRS[sample.pair]["members"]
    return tuple(
        marker
        for tag, markers in members.items()
        if tag != sample.gold
        for marker in markers
    )


#Scripts written without inter-word spaces, where ``\\b`` is meaningless
#because the whole run is one "word" to a regex.
_UNSPACED_SCRIPTS = ("CJK", "HIRAGANA", "KATAKANA", "HANGUL", "THAI", "LAO")


@functools.lru_cache(maxsize=4096)
def _is_unspaced(marker):
    return any(
        any(script in unicodedata.name(ch, "") for script in _UNSPACED_SCRIPTS)
        for ch in marker
    )


def _is_wordish(ch):
    """Whether ``ch`` continues a word for the purposes of marker matching.

    This is deliberately NOT ``re``'s ``\\w``. Python's ``\\w`` excludes
    combining marks, so ``(?<!\\w)है(?!\\w)`` matches happily *inside* ``हैं``
    — the anusvara after it is category ``Mn`` and reads as a boundary. Every
    Devanagari and Arabic marker in this file would be wrong in the same way,
    silently and in the direction that inflates the score. Marks join.
    """
    return (
        ch.isalnum()
        or ch == "_"
        or unicodedata.category(ch) in ("Mn", "Mc", "Me")
    )


def contains_marker(text, marker):
    """Whether ``marker`` occurs in ``text`` as a word (or, for CJK, at all).

    Word-boundary matching is what makes short markers usable: Nynorsk ``eg``
    must not fire inside Bokmål ``meget``, Serbian ``vreme`` must not fire
    inside Bosnian ``vrijeme``, Hindi ``है`` must not fire inside ``हैं``, and
    Nepali ``छ`` must not fire inside ``छन्``. Chinese has no word boundaries
    at all, so its markers are substring matches — which is correct, because
    唔 is a morpheme, not a word.

    Matching is case-insensitive: a marker is as likely to open a sentence as
    to sit inside one, and ``Karena`` is ``karena``.
    """
    text = (text or "").casefold()
    marker = marker.casefold()
    if _is_unspaced(marker):
        return marker in text
    start = 0
    while True:
        i = text.find(marker, start)
        if i < 0:
            return False
        before = text[i - 1] if i else ""
        after_at = i + len(marker)
        after = text[after_at] if after_at < len(text) else ""
        if not (before and _is_wordish(before)) and not (
            after and _is_wordish(after)
        ):
            return True
        start = i + 1


def markers_present(text, markers):
    return tuple(m for m in markers if contains_marker(text, m))
