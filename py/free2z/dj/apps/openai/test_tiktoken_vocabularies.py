"""Every model we sell must resolve to a vocabulary baked into the image.

`docker/py3base/Dockerfile` warms the encodings in
`utils.warm_tiktoken_cache.REQUIRED_ENCODINGS`, and `bin/check-build-image-
hygiene.py` keeps that warming step wired in. Neither of them can notice the
thing most likely to go wrong: somebody adds a model to `seed_ai_models.LINEUP`
whose name tiktoken maps to an encoding nobody warmed. That is a one-line
catalogue change with no Dockerfile diff, and its cost is a worker lane wedged
on an untimed download the first time a creator picks the new model.

So the catalogue is checked against the warm list here, where adding the model
is.

No network: `encoding_name_for_model` is a pure name-to-name mapping and never
touches the BPE file.
"""
import pytest

from dj.apps.openai.management.commands.seed_ai_models import LINEUP, RETIRED
from utils.warm_tiktoken_cache import REQUIRED_ENCODINGS

tiktoken = pytest.importorskip("tiktoken")


def _catalogue_model_names():
    """Every model name the deployed catalogue can hold, seeded or retired.

    RETIRED rows are included deliberately: retiring a model sets `is_ga=False`,
    which removes it from the picker but leaves the row, and
    `translate_zpage` resolves the model recorded on the CHARGE rather than
    re-picking one. A job bought just before a retirement still runs after it.
    """
    for entry in LINEUP:
        yield entry[1]
    for _provider, model in RETIRED:
        yield model


@pytest.mark.parametrize("model", sorted(set(_catalogue_model_names())))
def test_every_catalogue_model_uses_a_baked_in_vocabulary(model):
    try:
        encoding = tiktoken.encoding_name_for_model(model)
    except KeyError:
        # tiktoken has no mapping, so `openai.models._get_encoding` falls back
        # to cl100k_base -- which is warmed. This is every Anthropic, xAI and
        # Kimi row, and it is the documented degradation, not a gap.
        assert "cl100k_base" in REQUIRED_ENCODINGS
        return

    assert encoding in REQUIRED_ENCODINGS, (
        f"{model} resolves to {encoding}, which py3base does not bake in. "
        f"Add it to utils.warm_tiktoken_cache.REQUIRED_ENCODINGS, or the first "
        f"request for this model on a fresh pod downloads the vocabulary with "
        f"no timeout and can wedge the worker lane (#1918)."
    )


def test_the_warm_list_is_not_silently_empty():
    """A guard that warms nothing would pass every assertion above."""
    assert "cl100k_base" in REQUIRED_ENCODINGS
    assert "o200k_base" in REQUIRED_ENCODINGS


def test_the_translation_default_models_are_covered():
    """The models `translate_zpage` actually reaches for, by name.

    `DEFAULT_MODEL_PREFERENCE` is the ordered fallback the translation service
    picks from, and  is the reason this file exists, so name it explicitly
    rather than relying on it being a subset of the catalogue.
    """
    from dj.apps.g12f.translation.service import DEFAULT_MODEL_PREFERENCE

    for entry in DEFAULT_MODEL_PREFERENCE:
        model = entry.split(":", 1)[1]
        try:
            encoding = tiktoken.encoding_name_for_model(model)
        except KeyError:
            continue
        assert encoding in REQUIRED_ENCODINGS, (
            f"{model} is a translation fallback and resolves to {encoding}, "
            f"which is not baked into the image (#1918)"
        )
