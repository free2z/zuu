from django.urls import path

from .views import (
    autocomplete,
    decide_zpage_tag_suggestions,
    tag_hub,
    zpage_tag_suggestions,
)

urlpatterns = [
    path('autocomplete', autocomplete, name="tagging_autocomplete"),
    # The resolver behind the public `/tag/<slug>` hub. `<str:>`
    # rather than `<slug:>`: Django's slug converter is `[-a-zA-Z0-9_]+`,
    # ASCII-only, so it would 404 every non-Latin tag on a multilingual
    # platform before the view ever ran. The view validates the shape
    # itself -- `is_canonical_slug` is the one spelling of that rule --
    # and a `<str:>` segment cannot contain `/`, so no path outside this
    # namespace is reachable through it.
    path('hub/<str:slug>', tag_hub, name="tagging_hub"),
    # AI tag suggestions live here rather than as `@action`s on `zPageView`
    #the viewset is already the biggest surface in the codebase, and
    # tagging is this app's subject. The zPage is identified by a path
    # segment — it is the resource being read and mutated — and the accept /
    # dismiss decisions travel in the POST body, never in the query string.
    path(
        'zpage/<str:free2zaddr>/suggestions',
        zpage_tag_suggestions,
        name="tagging_zpage_suggestions",
    ),
    path(
        'zpage/<str:free2zaddr>/suggestions/decide',
        decide_zpage_tag_suggestions,
        name="tagging_zpage_suggestions_decide",
    ),
]
