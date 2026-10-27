from django.test import override_settings

from dj.apps.ztripe.checks import check_native_return_cache


@override_settings(DEBUG=False, CACHES={
    "default": {"BACKEND": "django_redis.cache.RedisCache", "LOCATION": "redis://unused"}
})
def test_native_return_accepts_production_shared_redis_configuration():
    assert check_native_return_cache(None) == []


@override_settings(DEBUG=False, CACHES={
    "default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache"}
})
def test_native_return_rejects_process_local_production_cache():
    errors = check_native_return_cache(None)
    assert [error.id for error in errors] == ["ztripe.E008"]


@override_settings(DEBUG=True, CACHES={
    "default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache"}
})
def test_native_return_allows_local_cache_only_in_debug():
    assert check_native_return_cache(None) == []
