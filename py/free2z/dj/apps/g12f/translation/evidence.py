"""What we have actually checked about each language we sell a translation into.

We take 2Z for a translation, so the record of "can we do this language, and do
we know what it costs" has to exist somewhere that a test can read. This is
that somewhere, and it is deliberately the lightest thing that works: one row
per language, holding a short **parallel reference text** and a note saying what
has been verified about that language and how.

WHY THE ROW CARRIES A SAMPLE RATHER THAN A NUMBER
-------------------------------------------------
The expensive thing to get wrong is the price, and the price turns on how many
tokens a translation INTO this language costs. That is not a constant: it is a
property of the language, of its script, and of whichever tokenizer the model
of the day meters in. A hardcoded ratio would be right for one encoding and
silently wrong for the next (exactly the `cl100k_base` / `o200k_base` mix-up
that  and  cost us), so the row stores the TEXT and
:func:`dj.apps.g12f.translation.service.output_token_ratio` measures the ratio
at runtime with whatever counter the quote is denominated in. Change the
tokenizer and the table follows without anybody editing a number.

Every sample is **Article 1 of the Universal Declaration of Human Rights**,
transcribed from the published translation for that language -- a genuinely parallel corpus
(the same sentence, in every language, translated by people whose job it was),
in the public domain, and short enough to read in a diff. Parallelism is the
whole point: the ratio ``tokens(target sample) / tokens(source sample)`` is only
meaningful because both sides say the same thing.

Its one known bias, stated so nobody has to rediscover it: Article 1 is a
single terse sentence, and short text under-states expansion a little for
targets that are close to English. Measured against the real article in
(``o200k_base``), a full document runs ~10-25% higher than this corpus does for
European targets (German 1.49x there against 1.15x here, French 1.48x against
1.24x) while the distant scripts agree closely (Thai 1.97x against 1.94x,
Japanese 1.98x against 2.15x). The corpus is therefore slightly CONSERVATIVE in
the creator's favour on Latin-script targets, the ceil-to-a-whole-2Z in
``get_tuzi_price`` absorbs that on any ordinary zPage, and ``tasks.py``'s
"settled under its cost" warning is the instrument that would show it becoming
systematic.

WHAT A ROW DOES *NOT* CLAIM
---------------------------
``checked`` records what has been VERIFIED MECHANICALLY, by a test, in CI. It
does not claim that a fluent speaker has read a translation into this language.
Nobody has, for any of them, and inventing a field that says otherwise would be
worse than having none.

The guarantees that are language-INDEPENDENT are not repeated per row, because
repeating them would imply they were established per language when they are
structural:

* fenced and indented code, ``$$``-math and ``::embed``-style directives are
  never sent to a model at all (``service.split_units``);
* a translation may not introduce a destination, an HTML tag, a currency
  amount, a dangling footnote or a code identifier the source did not have
  (``safety.check_translation``);
* Free2Z, 2Z, zPage, Zcash and ZEC are named in the prompt as do-not-translate
  terms and their survival is enforced by ``safety.check_translation``.

DEMOTING A LANGUAGE IS MEANT TO BE BORING
-----------------------------------------
Drop it from ``f2z.languages.TRANSLATABLE`` and it stops being sellable. The
row here may stay -- an unsold language with a measured sample costs nothing and
keeps the measurement if it is ever promoted back. The gate runs the other way:
``test_translation_quality.py`` fails if a language is in ``TRANSLATABLE`` and
has no row here, so growing the sell list forces the evidence to grow with it.
That is the only thing standing between "we added forty languages" and "we are
charging for forty languages we have never measured".

A SAMPLE MUST BE THE WHOLE PASSAGE, AND THAT IS ON THE REVIEWER
---------------------------------------------------------------
The ratio is ``tokens(target sample) / tokens(source sample)``, so a sample
that is missing half its content is not merely imprecise -- it moves money in
both directions at once. An Armenian sample that stopped after "reason and
conscience" made Armenian-to-English divide by an artificially small
denominator (inflating the quote a creator pays) and English-to-Armenian
under-estimate its output (which we eat). The codex adversarial review caught
exactly that, and the same truncation turned out to be in the Georgian and
Sinhala rows, which it had not named.

**Semantic completeness cannot be asserted in CI** -- no test can read two
languages and say "these mean the same thing", and pretending otherwise would
be this repo's dominant defect class written into the one file whose job is to
be trustworthy. What CI *can* assert, and does in
``test_translation_quality.py``, is the shape of the failure that actually
occurred: no ASCII digit or stray Latin letter in a non-Latin sample (a
mistyped ``\u0c83`` escape leaves a literal ``3`` behind, and two rows had
one), no duplicate samples, and a per-script length band for scripts with more
than one sample. Everything beyond that is a reviewer reading the row against
the published Article 1, and the three corrections above are the precedent for
taking that seriously.

ADDING A LANGUAGE
-----------------
Add a row with that language's UDHR Article 1 and ``checked=("token-expansion",)``.
A row with an empty ``sample`` is legitimate and means "no parallel text yet;
priced from other languages in the same script" -- honest, and visibly weaker
than a measured row.
"""
import functools
from dataclasses import dataclass

from f2z import languages


@dataclass(frozen=True)
class LanguageEvidence:
    """One language's record. See the module docstring."""

    #Parallel reference text (UDHR Article 1). Empty when we have none, in
    #which case pricing falls back to the mean of this language's script.
    sample: str = ""
    #What has been verified mechanically. ``"token-expansion"`` means a test
    #measures this language's token ratio against the live tokenizer.
    checked: tuple = ()
    #Anything a reader of this table needs to know.
    note: str = ""


#One row per language. Keys are normalized BCP-47 tags, as
#``f2z.languages.normalize`` produces them.
EVIDENCE = {
    "af": LanguageEvidence(
        checked=(),
        note=(
            "Latin script; priced from the Latin-script mean. No parallel "
            "sample yet."
        ),
    ),
    "am": LanguageEvidence(
        sample=(
            "የሰው ልጅ ሁሉ ሲወለድ ነጻና በክብርና በመብትም እኩልነት ያለው ነው። የተፈጥሮ ማስተዋልና ሕሊና ስላለው አንዱ ሌላውን በወንድማማችነት መንፈስ ሊይዝ ይገባል።"
        ),
        checked=("token-expansion",),
        note=(
            "SELLABLE since #1928 -- this note said otherwise until #1967. "
            "Ethiopic is the most token-expensive script measured here by a "
            "wide margin (5.49x English in o200k_base), and the flat output "
            "cap could not fit a correct translation on EITHER attempt, so "
            "`am` was on sale and undeliverable. See #1967."
        ),
    ),
    "ar": LanguageEvidence(
        sample=(
            "يولد جميع الناس أحرارًا متساوين في الكرامة والحقوق. وقد وهبوا عقلاً وضميرًا وعليهم أن يعامل بعضهم بعضًا بروح الإخاء."
        ),
        checked=("token-expansion",),
        note=(
            "RTL. The content container is not yet told so -- #1930."
        ),
    ),
    "bn": LanguageEvidence(
        sample=(
            "সমস্ত মানুষ স্বাধীনভাবে সমান মর্যাদা এবং অধিকার নিয়ে জন্মগ্রহণ করে। তাঁদের বিবেক এবং বুদ্ধি আছে; সুতরাং সকলেরই একে অপরের প্রতি ভ্রাতৃত্বসুলভ মনোভাব নিয়ে আচরণ করা উচিত।"
        ),
        checked=("token-expansion",),
    ),
    "cs": LanguageEvidence(
        checked=(),
        note=(
            "Latin script; priced from the Latin-script mean. No parallel "
            "sample yet."
        ),
    ),
    "da": LanguageEvidence(
        checked=(),
        note=(
            "Latin script; priced from the Latin-script mean. No parallel "
            "sample yet."
        ),
    ),
    "de": LanguageEvidence(
        sample=(
            "Alle Menschen sind frei und gleich an Würde und Rechten geboren. Sie sind mit Vernunft und Gewissen begabt und sollen einander im Geist der Brüderlichkeit begegnen."
        ),
        checked=("token-expansion",),
    ),
    "el": LanguageEvidence(
        sample=(
            "Όλοι οι άνθρωποι γεννιούνται ελεύθεροι και ίσοι στην αξιοπρέπεια και τα δικαιώματα. Είναι προικισμένοι με λογική και συνείδηση, και οφείλουν να συμπεριφέρονται μεταξύ τους με πνεύμα αδελφοσύνης."
        ),
        checked=("token-expansion",),
    ),
    "en": LanguageEvidence(
        sample=(
            "All human beings are born free and equal in dignity and rights. They are endowed with reason and conscience and should act towards one another in a spirit of brotherhood."
        ),
        checked=("token-expansion",),
    ),
    "es": LanguageEvidence(
        sample=(
            "Todos los seres humanos nacen libres e iguales en dignidad y derechos y, dotados como están de razón y conciencia, deben comportarse fraternalmente los unos con los otros."
        ),
        checked=("token-expansion",),
    ),
    "fa": LanguageEvidence(
        sample=(
            "تمام افراد بشر آزاد به دنیا می‌آیند و از لحاظ حیثیت و حقوق با هم برابرند، همه دارای عقل و وجدان می‌باشند و باید نسبت به یکدیگر با روح برادری رفتار کنند."
        ),
        checked=("token-expansion",),
        note=(
            "RTL. #1930."
        ),
    ),
    "fi": LanguageEvidence(
        checked=(),
        note=(
            "Latin script; priced from the Latin-script mean. Finnish is "
            "agglutinative and runs longer than the Latin mean -- a "
            "parallel sample would sharpen it."
        ),
    ),
    "fil": LanguageEvidence(
        checked=(),
        note=(
            "Latin script; priced from the Latin-script mean. No parallel "
            "sample yet."
        ),
    ),
    "fr": LanguageEvidence(
        sample=(
            "Tous les êtres humains naissent libres et égaux en dignité et en droits. Ils sont doués de raison et de conscience et doivent agir les uns envers les autres dans un esprit de fraternité."
        ),
        checked=("token-expansion",),
    ),
    "he": LanguageEvidence(
        sample=(
            "כל בני אדם נולדו בני חורין ושווים בערכם ובזכויותיהם. כולם חוננו בתבונה ובמצפון, לפיכך חובה עליהם לנהוג איש ברעהו ברוח של אחוה."
        ),
        checked=("token-expansion",),
        note=(
            "RTL. #1930."
        ),
    ),
    "hi": LanguageEvidence(
        sample=(
            "सभी मनुष्यों को गौरव और अधिकारों के मामले में जन्मजात स्वतन्त्रता और समानता प्राप्त है। उन्हें बुद्धि और अन्तरात्मा की देन प्राप्त है और परस्पर उन्हें भाईचारे के भाव से बर्ताव करना चाहिए।"
        ),
        checked=("token-expansion",),
    ),
    "hu": LanguageEvidence(
        checked=(),
        note=(
            "Latin script; priced from the Latin-script mean. "
            "Agglutinative, as Finnish."
        ),
    ),
    "hy": LanguageEvidence(
        sample=(
            "Բոլոր մարդիկ ծնվում են ազատ ու հավասար իրենց արժանապատվությամբ ու իրավունքներով։ Նրանք օժտված են բանականությամբ ու խղճով և պետք է միմյանց նկատմամբ գործեն եղբայրության ոգով։"
        ),
        checked=("token-expansion",),
        note=(
            "Sellable since #1928 -- this note said otherwise until #1967."
        ),
    ),
    "id": LanguageEvidence(
        checked=(),
        note=(
            "Latin script; priced from the Latin-script mean. No parallel "
            "sample yet."
        ),
    ),
    "it": LanguageEvidence(
        sample=(
            "Tutti gli esseri umani nascono liberi ed eguali in dignità e diritti. Essi sono dotati di ragione e di coscienza e devono agire gli uni verso gli altri in spirito di fratellanza."
        ),
        checked=("token-expansion",),
    ),
    "ja": LanguageEvidence(
        sample=(
            "すべての人間は、生れながらにして自由であり、かつ、尊厳と権利とについて平等である。人間は、理性と良心とを授けられており、互いに同胞の精神をもって行動しなければならない。"
        ),
        checked=("token-expansion",),
    ),
    "ka": LanguageEvidence(
        sample=(
            "ყველა ადამიანი იბადება თავისუფალი და თანასწორი თავისი ღირსებითა და უფლებებით. მათ მინიჭებული აქვთ გონება და სინდისი და ერთმანეთის მიმართ მათ უნდა იქცეოდნენ ძმობის სულისკვეთებით."
        ),
        checked=("token-expansion",),
        note=(
            "Sellable since #1928 -- this note said otherwise until #1967."
        ),
    ),
    "km": LanguageEvidence(
        sample=(
            "មនុស្សទាំងអស់ កើតមកមានសេរីភាព និងសមភាព ក្នុងផ្នែកសេចក្ដីថ្លៃថ្នូរនិងសិទ្ធិ។ មនុស្សមានវិចារណញ្ញាណនិងសតិសម្បជញ្ញៈជាប់ពីកំណើត ហើយគប្បីប្រព្រឹត្តចំពោះគ្នាទៅវិញទៅមកក្នុងស្មារតីភាតរភាពជាបងប្អូន។"
        ),
        checked=("token-expansion",),
        note=(
            "SELLABLE since #1928 -- this note said otherwise until #1967, "
            "and 3.46x expansion did not fit the flat output cap. Khmer has "
            "no inter-word spaces; see #1930."
        ),
    ),
    "ko": LanguageEvidence(
        sample=(
            "모든 인간은 태어날 때부터 자유로우며 그 존엄과 권리에 있어 동등하다. 인간은 천부적으로 이성과 양심을 부여받았으며 서로 형제애의 정신으로 행동하여야 한다."
        ),
        checked=("token-expansion",),
    ),
    "ms": LanguageEvidence(
        checked=(),
        note=(
            "Latin script; priced from the Latin-script mean. No parallel "
            "sample yet."
        ),
    ),
    "my": LanguageEvidence(
        sample=(
            "လူတိုင်းသည် တူညီသော ဂုဏ်သိက္ခာနှင့် တူညီသော အခွင့်အရေးများဖြင့် လွတ်လပ်စွာ မွေးဖွားလာသည်။ ထိုသူတို့တွင် ဆင်ခြင်တုံနို့သော ဥာဏ်နှင့် ကိုယ်ကျင့်စိတ်တို့ ရှိကြသည်ဖြစ်ရာ ထိုသူတို့သည် အချင်းချင်း ဆက်ဆံသင့်ပေသည်။"
        ),
        checked=("token-expansion",),
        note=(
            "SELLABLE since #1928 -- this note said otherwise until #1967. "
            "The worst case in the table: 3.42x in o200k_base and 12.12x in "
            "cl100k_base, which is OVER the old MAX_OUTPUT_TOKEN_RATIO of "
            "12.0 -- so on the model translation actually picks the "
            "measurement was discarded for 1.15 and Burmese was "
            "undeliverable. Burmese has no inter-word spaces; see #1930."
        ),
    ),
    "nb": LanguageEvidence(
        checked=(),
        note=(
            "Latin script; priced from the Latin-script mean. No parallel "
            "sample yet."
        ),
    ),
    "ne": LanguageEvidence(
        sample=(
            "सबै व्यक्तिहरू जन्मदेखि नै स्वतन्त्र हुन् र मर्यादा र अधिकारमा सबै समान छन्। निजमा विवेक र बुद्धि भएकाले निज बिच मायालु भावले ब्यवहार गर्नु पर्दछ।"
        ),
        checked=("token-expansion",),
        note=(
            "Sellable since #1928 -- this note said otherwise until #1967. "
            "Devanagari, as Hindi."
        ),
    ),
    "nl": LanguageEvidence(
        checked=(),
        note=(
            "Latin script; priced from the Latin-script mean. No parallel "
            "sample yet."
        ),
    ),
    "pl": LanguageEvidence(
        sample=(
            "Wszyscy ludzie rodzą się wolni i równi pod względem swej godności i swych praw. Są oni obdarzeni rozumem i sumieniem i powinni postępować wobec innych w duchu braterstwa."
        ),
        checked=("token-expansion",),
    ),
    "pt-BR": LanguageEvidence(
        sample=(
            "Todos os seres humanos nascem livres e iguais em dignidade e direitos. São dotados de razão e consciência e devem agir em relação uns aos outros com espírito de fraternidade."
        ),
        checked=("token-expansion",),
    ),
    "pt-PT": LanguageEvidence(
        sample=(
            "Todos os seres humanos nascem livres e iguais em dignidade e em direitos. Dotados de razão e de consciência, devem agir uns para com os outros em espírito de fraternidade."
        ),
        checked=("token-expansion",),
    ),
    "ro": LanguageEvidence(
        checked=(),
        note=(
            "Latin script; priced from the Latin-script mean. No parallel "
            "sample yet."
        ),
    ),
    "ru": LanguageEvidence(
        sample=(
            "Все люди рождаются свободными и равными в своем достоинстве и правах. Они наделены разумом и совестью и должны поступать в отношении друг друга в духе братства."
        ),
        checked=("token-expansion",),
    ),
    "si": LanguageEvidence(
        sample=(
            "සියලු මනුෂ්‍යයෝ නිදහස්ව උපත ලබා ඇත. ගරුත්වයෙන් හා අයිතිවාසිකම්වලින් සමාන වෙති. යුක්ති අයුක්ති තේරුම් ගැනීමේ බුද්ධිය හා හෘදය සාක්ෂිය ඔවුනට උරුම වී ඇත. එකිනෙකා කෙරෙහි සහෝදර හැඟීමෙන් යුතුව කටයුතු කිරීම ඔවුන්ගේ වගකීම වේ."
        ),
        checked=("token-expansion",),
        note=(
            "Sellable since #1928 -- this note said otherwise until #1967."
        ),
    ),
    "sv": LanguageEvidence(
        checked=(),
        note=(
            "Latin script; priced from the Latin-script mean. No parallel "
            "sample yet."
        ),
    ),
    "sw": LanguageEvidence(
        checked=(),
        note=(
            "Latin script; priced from the Latin-script mean. No parallel "
            "sample yet."
        ),
    ),
    "ta": LanguageEvidence(
        sample=(
            "மனிதப் பிறவியினர் சேர்ந்து சுதந்திரமாகவே பிறக்கின்றனர்; அவர்கள் மதிப்புரிமையிலும் உரிமைகளிலும் சமமானவர்கள். அவர்கள் நியாயத்தையும் மனசாட்சியையும் இயற்பயில்பெற்றவர்கள்; அவர்கள் ஒருவருடனொருவர் சகோதர உணர்வுப் பான்மையில் நடந்துகொள்ளுதல் வேண்டும்."
        ),
        checked=("token-expansion",),
    ),
    "te": LanguageEvidence(
        sample=(
            "ప్రతిపత్తిస్వత్వముల విషయమున మానవులెల్లరును జన్మతః స్వతంత్రులును సమానులును నగుదురు. వారు వివేచన-అంతఃకరణ సంపన్నులగుటచే పరస్పరము సౌభ్రాతృభావముతో వర్తించవలయును."
        ),
        checked=("token-expansion",),
    ),
    "th": LanguageEvidence(
        sample=(
            "มนุษย์ทั้งหลายเกิดมาอิสระเสรีและเท่าเทียมกันทั้งศักดิ์ศรีและสิทธิ ทุกคนได้รับการประสิทธิ์ประสาทเหตุผลและมโนธรรม และควรปฏิบัติต่อกันอย่างฉันพี่น้อง"
        ),
        checked=("token-expansion",),
        note=(
            "No inter-word spaces; line-breaking is #1930."
        ),
    ),
    "tr": LanguageEvidence(
        sample=(
            "Bütün insanlar hür, haysiyet ve haklar bakımından eşit doğarlar. Akıl ve vicdana sahiptirler ve birbirlerine karşı kardeşlik zihniyeti ile hareket etmelidirler."
        ),
        checked=("token-expansion",),
    ),
    "uk": LanguageEvidence(
        sample=(
            "Всі люди народжуються вільними і рівними у своїй гідності та правах. Вони наділені розумом і совістю і повинні діяти у відношенні один до одного в дусі братерства."
        ),
        checked=("token-expansion",),
    ),
    "ur": LanguageEvidence(
        sample=(
            "تمام انسان آزاد اور حقوق و عزت کے اعتبار سے برابر پیدا ہوئے ہیں۔ انہیں ضمیر اور عقل ودیعت ہوئی ہے۔ اس لئے انہیں ایک دوسرے کے ساتھ بھائی چارے کا سلوک کرنا چاہیے۔"
        ),
        checked=("token-expansion",),
        note=(
            "RTL. #1930."
        ),
    ),
    "vi": LanguageEvidence(
        sample=(
            "Tất cả mọi người sinh ra đều được tự do và bình đẳng về nhân phẩm và quyền. Mọi con người đều được tạo hoá ban cho lý trí và lương tâm và cần phải đối xử với nhau trong tình bằng hữu."
        ),
        checked=("token-expansion",),
    ),
    "zh-Hans": LanguageEvidence(
        sample=(
            "人人生而自由，在尊严和权利上一律平等。他们赋有理性和良心，并应以兄弟关系的精神相对待。"
        ),
        checked=("token-expansion",),
        note=(
            "Script, not language: Standard Written Chinese in simplified "
            "script. Cantonese (yue) is a different language -- see #1904."
        ),
    ),
    "zh-Hant": LanguageEvidence(
        sample=(
            "人人生而自由，在尊嚴和權利上一律平等。他們賦有理性和良心，並應以兄弟關係的精神相對待。"
        ),
        checked=("token-expansion",),
        note=(
            "Script, not language: Standard Written Chinese in traditional "
            "script."
        ),
    ),
    "az": LanguageEvidence(
        checked=(),
        note=(
            "Latin script (CLDR default for bare `az`). Priced from the "
            "Latin-script mean. The prompt names the script (#1942)."
        ),
    ),
    "bg": LanguageEvidence(
        checked=(),
        note=(
            "Cyrillic; priced from the Cyrillic-script mean. No parallel "
            "sample yet."
        ),
    ),
    "ca": LanguageEvidence(
        checked=(),
        note=(
            "Latin script; priced from the Latin-script mean. No parallel "
            "sample yet."
        ),
    ),
    "et": LanguageEvidence(
        checked=(),
        note=(
            "Latin script; priced from the Latin-script mean. No parallel "
            "sample yet."
        ),
    ),
    "eu": LanguageEvidence(
        checked=(),
        note=(
            "Latin script; priced from the Latin-script mean. Basque is an "
            "isolate and agglutinative; a parallel sample would sharpen it."
        ),
    ),
    "gl": LanguageEvidence(
        checked=(),
        note=(
            "Latin script; priced from the Latin-script mean. No parallel "
            "sample yet."
        ),
    ),
    "gu": LanguageEvidence(
        sample=(
            "પ્રતિષ્ઠા અને અધિકારોની દૃષ્ટિએ સર્વ માનવો જન્મથી સ્વતંત્ર અને સમાન હોય છે. તેમનામાં વિચારશક્તિ અને અંતઃકરણ હોય છે અને તેમણે પરસ્પર બંધુત્વની ભાવનાથી વર્તવું જોઈએ."
        ),
        checked=("token-expansion",),
        note=(
            "Not previously sellable. Gujarati was one of five scripts with "
            "no parallel text anywhere in this table, which made it "
            "unpriceable rather than merely unmeasured."
        ),
    ),
    "ha": LanguageEvidence(
        checked=(),
        note=(
            "Latin script; priced from the Latin-script mean. No parallel "
            "sample yet."
        ),
    ),
    "hr": LanguageEvidence(
        checked=(),
        note=(
            "Latin script; priced from the Latin-script mean. No parallel "
            "sample yet."
        ),
    ),
    "ht": LanguageEvidence(
        checked=(),
        note=(
            "Latin script; priced from the Latin-script mean. No parallel "
            "sample yet."
        ),
    ),
    "ig": LanguageEvidence(
        checked=(),
        note=(
            "Latin script; priced from the Latin-script mean. No parallel "
            "sample yet."
        ),
    ),
    "is": LanguageEvidence(
        checked=(),
        note=(
            "Latin script; priced from the Latin-script mean. No parallel "
            "sample yet."
        ),
    ),
    "kk": LanguageEvidence(
        checked=(),
        note=(
            "Cyrillic (CLDR default for bare `kk`); priced from the "
            "Cyrillic-script mean. Script named in the prompt (#1942)."
        ),
    ),
    "kn": LanguageEvidence(
        sample=(
            "ಎಲ್ಲಾ ಮಾನವರೂ ಸ್ವತಂತ್ರರಾಗಿಯೇ ಜನಿಸಿದ್ದಾರೆ. ಹಾಗೂ ಘನತೆ ಮತ್ತು ಹಕ್ಕುಗಳಲ್ಲಿ ಸಮಾನರಾಗಿದ್ದಾರೆ. ವಿವೇಕ ಮತ್ತು ಅಂತಃಕರಣಗಳನ್ನು ಪಡೆದವರಾದ್ದರಿಂದ ಅವರು ಪರಸ್ಪರ ಸಹೋದರ ಭಾವದಿಂದ ವರ್ತಿಸಬೇಕು."
        ),
        checked=("token-expansion",),
        note=(
            "Not previously sellable; Kannada had no script sample at all "
            "until now."
        ),
    ),
    "lo": LanguageEvidence(
        sample=(
            "ມະນຸດທຸກຄົນເກີດມາມີອິດສະລະ ແລະ ສະເໝີພາບກັນໃນທາງກຽດຕິສັກ ແລະ ທາງສິດທິ. ທຸກໆຄົນມີເຫດຜົນ ແລະ ຄວາມຄິດຄວາມເຫັນສ່ວນຕົວ ແລະ ຄວນປະຕິບັດຕໍ່ກັນດ້ວຍນໍ້າໃຈພີ່ນໍ້ອງ."
        ),
        checked=("token-expansion",),
        note=(
            "No inter-word spaces; line-breaking is #1930. Lao had no "
            "script sample at all until now."
        ),
    ),
    "lt": LanguageEvidence(
        checked=(),
        note=(
            "Latin script; priced from the Latin-script mean. No parallel "
            "sample yet."
        ),
    ),
    "lv": LanguageEvidence(
        checked=(),
        note=(
            "Latin script; priced from the Latin-script mean. No parallel "
            "sample yet."
        ),
    ),
    "mk": LanguageEvidence(
        checked=(),
        note=(
            "Cyrillic; priced from the Cyrillic-script mean. No parallel "
            "sample yet."
        ),
    ),
    "ml": LanguageEvidence(
        sample=(
            "മനുഷ്യരെല്ലാവരും തുല്യാവകാശങ്ങളോടും അന്തസ്സോടും സ്വാതന്ത്ര്യത്തോടുംകൂടി ജനിച്ചിട്ടുള്ളവരാണ്. അന്യോന്യം ഭ്രാതൃഭാവത്തോടെ പെരുമാറുവാനാണ് മനുഷ്യന്നു വിവേകബുദ്ധിയും മനസ്സാക്ഷിയും സിദ്ധമായിരിക്കുന്നത്."
        ),
        checked=("token-expansion",),
        note=(
            "Not previously sellable; Malayalam had no script sample at all "
            "until now."
        ),
    ),
    "mn": LanguageEvidence(
        checked=(),
        note=(
            "Cyrillic (CLDR default for bare `mn`); priced from the "
            "Cyrillic-script mean. Script named in the prompt (#1942)."
        ),
    ),
    "mr": LanguageEvidence(
        checked=(),
        note=(
            "Devanagari; priced from the Devanagari-script mean (Hindi, "
            "Nepali). No parallel sample yet."
        ),
    ),
    "nn": LanguageEvidence(
        checked=(),
        note=(
            "Latin script; priced from the Latin-script mean. No parallel "
            "sample yet."
        ),
    ),
    "pa": LanguageEvidence(
        sample=(
            "ਸਾਰੇ ਮਨੁੱਖ ਆਜ਼ਾਦ ਅਤੇ ਹੱਕਾਂ ਤੇ ਇੱਜ਼ਤ ਦੇ ਪੱਖੋਂ ਬਰਾਬਰ ਪੈਦਾ ਹੋਏ ਹਨ। ਉਨ੍ਹਾਂ ਨੂੰ ਤਰਕ ਅਤੇ ਜ਼ਮੀਰ ਦੀ ਸੌਗਾਤ ਮਿਲੀ ਹੋਈ ਹੈ ਅਤੇ ਉਨ੍ਹਾਂ ਨੂੰ ਭਰਾਤਰੀ ਭਾਵਨਾ ਨਾਲ ਇੱਕ ਦੂਜੇ ਨਾਲ ਵਰਤਾਓ ਕਰਨਾ ਚਾਹੀਦਾ ਹੈ।"
        ),
        checked=("token-expansion",),
        note=(
            "Gurmukhi. `pa` is also written in the Arabic script "
            "(`pa-Arab`) in Pakistan, so the prompt names the script "
            "(#1942); this sample is the Gurmukhi one CLDR makes the "
            "default."
        ),
    ),
    "ps": LanguageEvidence(
        checked=(),
        note=(
            "Arabic script, RTL; priced from the Arabic-script mean. #1930 "
            "owns the rendering half."
        ),
    ),
    "sk": LanguageEvidence(
        checked=(),
        note=(
            "Latin script; priced from the Latin-script mean. No parallel "
            "sample yet."
        ),
    ),
    "sl": LanguageEvidence(
        checked=(),
        note=(
            "Latin script; priced from the Latin-script mean. No parallel "
            "sample yet."
        ),
    ),
    "so": LanguageEvidence(
        checked=(),
        note=(
            "Latin script; priced from the Latin-script mean. No parallel "
            "sample yet."
        ),
    ),
    "sq": LanguageEvidence(
        checked=(),
        note=(
            "Latin script; priced from the Latin-script mean. No parallel "
            "sample yet."
        ),
    ),
    "sr": LanguageEvidence(
        checked=(),
        note=(
            "Cyrillic (CLDR default for bare `sr`) -- and the sharp case "
            "for #1942, because BOTH scripts are in genuine daily use in "
            "Serbia. The prompt names the script and the reply is checked "
            "against it. Priced from the Cyrillic-script mean."
        ),
    ),
    "uz": LanguageEvidence(
        checked=(),
        note=(
            "Latin script (CLDR default for bare `uz`); priced from the "
            "Latin-script mean. Script named in the prompt (#1942)."
        ),
    ),
    "yo": LanguageEvidence(
        checked=(),
        note=(
            "Latin script; priced from the Latin-script mean. No parallel "
            "sample yet."
        ),
    ),
    "yue-Hant": LanguageEvidence(
        checked=(),
        note=(
            "Cantonese in traditional script -- a different LANGUAGE from "
            "`zh-Hant`, not a script transform of it (#1904). Priced from "
            "the Hant mean, which is `zh-Hant`: the two share a script and "
            "tokenize alike even though the lexicon differs, so the ratio "
            "carries over where a translation would not."
        ),
    ),
    "zu": LanguageEvidence(
        checked=(),
        note=(
            "Latin script; priced from the Latin-script mean. No parallel "
            "sample yet."
        ),
    ),
}


DEFAULT_OUTPUT_TOKEN_RATIO = 1.15
"""Ratio used when neither the language nor its script has a sample.

The number this module replaced: a single constant applied to every target.
Keeping it as the FALLBACK rather than as the rule means this change can only
correct a language it has measured, and can never make an unmeasured one behave
differently from the way it behaves today.
"""

MAX_OUTPUT_TOKEN_RATIO = 20.0
"""Guard against a corrupt or mistyped sample, not a product cap.

It exists only so a one-character mistake in a sample -- a stray ``\\u`` escape,
a doubled passage -- cannot produce an absurd quote. That is an
order-of-magnitude error, so the guard is allowed to sit well above every real
measurement, and it MUST: a real measurement it rejects falls back to
:data:`DEFAULT_OUTPUT_TOKEN_RATIO` (1.15), which under-quotes the language AND
gives it the floor cap, i.e. exactly the #1967 defect.

**It was 12.0, and that was below a real measurement.** Written when the largest
ratio the corpus produced was Tamil from English at ~10.2x in ``cl100k_base``,
it stopped being true when #1928 grew the sell list: English to Burmese is
**12.12x** in ``cl100k_base`` (3.42x in ``o200k_base`` -- the 3.5x over-count is
the whole reason #1912 corrected the unit). So on every model tiktoken has no
mapping for -- Anthropic and Kimi -- Burmese was quoted at 1.15x and capped at
2.5x against a translation that really is ~15x its source in that encoding:
undeliverable, on both attempts, forever, with one INFO line about a "probably
corrupt" sample that named the wrong cause. Sinhala at 11.91x was one percent
from the same fate.

Two constants, one drift, one cause: a threshold whose justification was a
measurement of a sell list that then changed. 20.0 is ~65% above the corpus's
real maximum (12.12x) and still absurd for any genuine translation, and
``test_translation_output_cap.py`` now asserts no pair in ``TRANSLATABLE`` is
rejected by it on **any** row of the seeded catalogue -- so the next expansion
fails a test instead of quietly repricing a language at 1.15.

THE PRICE THIS MOVES, SAID OUT LOUD. Raising the guard does not only widen a
cap; it lets the measurement through, and the measurement IS the quote. On an
unmappable model the quoted ratio for ``en -> my`` goes **1.15 -> 12.12, a
10.5x increase in the Burmese price**. That is the wrong direction by this
module's own rule -- over-quoting takes a creator's money while under-quoting
only costs us margin -- and it is 3.5x more than the true ``o200k``-equivalent
expansion, because the unit is inflated on both sides. It is accepted here for
three reasons, in order: the alternative was a 100% refund rate for Burmese on
those models, which is worse for the creator than any price; it is **latent, not
live** -- 30 days of production logs show translation running OpenAI only
(``gpt-5.6-luna`` and ``gpt-4o``, both of which tiktoken maps to ``o200k_base``,
where the ratio is 3.42x and the guard is nowhere near it). Provider-reported
usage would address this unit estimate; #1909 addresses truncation detection
with termination reasons and does not change prices. If an Anthropic or Kimi
key is ever added to the translation path, account for the unmapped-tokenizer
price estimates before selling Burmese, Sinhala, Tamil, Georgian, Malayalam or
Armenian on it -- their quotes are 8-12x their true expansion in that unit.
"""


def sample_for(tag):
    """This language's parallel reference text, or ``""``."""
    row = EVIDENCE.get(tag)
    return row.sample if row is not None else ""


def has_evidence(tag):
    """Whether ``tag`` has a row here at all."""
    return tag in EVIDENCE


@functools.lru_cache(maxsize=256)
def script_of(tag):
    """ISO 15924 script for ``tag`` per CLDR likely-subtags, or ``None``."""
    try:
        return languages.likely_script(tag)
    except Exception:
        return None


@functools.lru_cache(maxsize=1)
def _samples_by_script():
    table = {}
    for tag, row in EVIDENCE.items():
        if not row.sample:
            continue
        script = script_of(tag)
        if script:
            table.setdefault(script, []).append(row.sample)
    return {script: tuple(items) for script, items in table.items()}


def samples_for_script(tag):
    """Every parallel sample written in the same script as ``tag``.

    The fallback for a language with no sample of its own. Averaging over the
    script is not a guess about the language -- it is the statement that the
    script is what dominates the token count, which is the finding that made
    this module necessary (Ethiopic costs ~9x English per character in
    ``o200k_base``; Latin languages sit within a few tens of percent of each
    other).
    """
    script = script_of(tag)
    if not script:
        return ()
    return _samples_by_script().get(script, ())
