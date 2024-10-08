from django.urls import path
from ninja import NinjaAPI
from .views import router as efm_router

api = NinjaAPI()

api.add_router("/", efm_router)

urlpatterns = [
    path("", api.urls),
]
