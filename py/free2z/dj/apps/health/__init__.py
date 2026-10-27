"""Process-level health endpoints for kubelet probes.

Deliberately NOT a Django app (no models, no AppConfig, not in
INSTALLED_APPS): it is a middleware, a view and a log filter. Keeping it out
of the app registry means the health path cannot be broken by an app-loading
problem -- which is precisely the class of failure it exists to report.
"""
