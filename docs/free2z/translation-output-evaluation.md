# Free2Z translation output evaluation

Run the manual `eval_translation_output` Django management command from
`py/free2z`. By default it prices every current `TRANSLATABLE` target and makes
no provider calls. Select a bounded subset with repeated `--language` options.
The command rejects codes outside `TRANSLATABLE`.

```sh
python dj/free2z/manage.py eval_translation_output --language fr --language sr
```

The report includes the creator-facing estimate from the shipping
`translation.service.quote_document` path. It is denominated in 2Z and is not a
provider-cost limit. Live execution requires `--max-provider-usd`, a finite,
positive USD cap. Before the first call, the evaluator uses the production
chunk plan, exact message token counts, provider output caps, cap retry, and
the model's provider rate card to calculate an aggregate maximum cost. It
fails closed when that bound cannot be established or exceeds the cap.
No call is possible without `--execute`:

```sh
python dj/free2z/manage.py eval_translation_output \
  --language fr --language sr --max-provider-usd 0.10 --execute \
  --output translation-eval-record.json
```

The synthetic checked-in sample contains no personal data. Before spending,
the output path is reserved without overwriting an existing file; the JSON is
atomically checkpointed after each language. The record stores model pricing,
prompt template digests by language and context, sample/source digests,
timestamp, creator quote, conservative provider USD bound and cap, reply,
provider usage or error type, and per-target script and brand observations.
Raw provider replies are observed through an opt-in callback on the production
translation path, before its script gate. A provider failure remains an error;
a script-gate failure retains the observed synthetic reply and is scored as a
gate rejection. `script_conformance` is the production script check's mismatch
count (or no opinion); `require_target_script` records accepted, no opinion,
rejected, or not reached. Han codepoints do not distinguish
Simplified from Traditional Chinese, so both Chinese tags require human review.

Do not calculate a false-positive rate from output alone: it needs independently
human-labeled correct/incorrect translations. Report observed gate rejections
and human labels separately; this command invents neither labels nor quality
floors. Keep an executed record with its run artifacts and link it from
`translation/evidence.py` only after an actual run has been reviewed. Never
link a plan-only output as evidence.

Rerun when the sell list grows, the production translation prompt changes, or
the default model changes. This is an operator-run evaluation, not CI.
