# `language_eval_recording.json`

Recorded provider replies for the the application contract close-pair detection eval. Written by

```sh
python dj/free2z/manage.py record_language_eval --spend 0.25
```

and replayed for free by `test_language_detection_evals.py`, so CI never calls
a paid API and a provider outage is never a red gate.

Each run stores the model's **raw replies**, keyed by sample id, plus two
fingerprints:

* `corpus_fingerprint` — the sample text the model was shown.
* `detector_fingerprint` — the prompts and sampling caps it was shown them
  with.

A partial run (from `--pair`, or from hitting the spend ceiling) is merged into
an earlier run of the same model, but only when both fingerprints match. When
either has moved the old replies describe something that no longer exists, so
they are dropped rather than blended.

`runs` is empty. Accuracy measurements require a recording made with provider
credentials. The corpus and scorer can run without a paid request; see
`ACCURACY_FLOORS` in the test module.
