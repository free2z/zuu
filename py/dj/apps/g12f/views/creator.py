import requests
# from django.core.exceptions import ValidationError
from django.conf import settings
from django.shortcuts import get_object_or_404, render
from django.db import models

from rest_framework import status, viewsets, mixins, filters
from rest_framework.response import Response
from rest_framework.views import APIView
from dj_rest_auth.views import UserDetailsView
from django_filters.rest_framework import DjangoFilterBackend

from dj.apps.g12f.models import Creator, zPage
from dj.apps.g12f.serializers.creator import (
    RegistrationSerializer,
    CreatorDetailSerializer,
    CreatorListSerializer,
)
from dj.apps.g12f.serializers.creator import (
    CreatorProfileDetailSerializer, CreatorProfileUpdateSerializer
)

# Privacy versus telling Google to protect us more?
# security or freedom?
# def get_client_ip(request):
#     x_forwarded_for = request.META.get('HTTP_X_FORWARDED_FOR')
#     if x_forwarded_for:
#         ip = x_forwarded_for.split(',')[0]
#     else:
#         ip = request.META.get('REMOTE_ADDR')
#     return ip


def creator_social(request, username):
    creator = get_object_or_404(Creator, username__iexact=username)
    return render(request, 'creator/social.html', {
        'creator': creator,
        'request': request,
    })


class SignUpView(
    # viewsets.ModelViewSet,
    # mixins.ListModelMixin, mixins.RetrieveModelMixin,
    mixins.CreateModelMixin,
    viewsets.GenericViewSet,
):
    """
    /api/start - create new user with POST
    """

    serializer_class = RegistrationSerializer

    def create(self, request, *args, **kwargs):
        if 'captcha_result' not in request.data:
            return Response(
                data={'error': 'ReCAPTCHA not supplied.'},
                status=status.HTTP_406_NOT_ACCEPTABLE
            )
        # Pop the captcha result out of request.data so we don't keep it around
        captcha_result = request.data.pop('captcha_result', '')

        # Allow a dev stub token for local development to avoid requiring a
        # real reCAPTCHA flow. Only accept this bypass when DEBUG is True and
        # the token is exactly 'test'. In production a real verification
        # against Google's siteverify API is performed.
        if settings.DEBUG and captcha_result == 'test':
            verified = True
        else:
            r = requests.post(
                'https://www.google.com/recaptcha/api/siteverify',
                data={
                    'secret': settings.RECAPTCHA_SECRET_KEY,
                    'response': captcha_result,
                    # 'remoteip': get_client_ip(request),
                }
            )
            verified = r.json().get('success')

        if not verified:
            return Response(
                data={'error': 'ReCAPTCHA not verified.'},
                status=status.HTTP_406_NOT_ACCEPTABLE
            )

        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)

        username = serializer.data['username']
        password = serializer.data['password']

        # validate in serializer
        # if Creator.objects.filter(username__iexact=username).count():
        #     raise ValidationError("Not a good username")
        c = Creator.objects.create(username=username)
        c.set_password(password)
        # Initial login
        c.save()

        # self.perform_create(serializer)
        # headers = self.get_success_headers(serializer.data)
        return Response(serializer.data['username'], status=status.HTTP_201_CREATED)


class CustomUserDetailsView(UserDetailsView):
    """
    This is only for the owner
    """

    def get_serializer_class(self):
        if self.request.method == 'GET':
            return CreatorProfileDetailSerializer
        elif self.request.method == 'PATCH':
            return CreatorProfileUpdateSerializer
        return super().get_serializer_class()


class CreatorView(
    mixins.RetrieveModelMixin,
    mixins.ListModelMixin,
    viewsets.GenericViewSet,
):
    """
    List Creators on Free2z
    """
    queryset = Creator.objects.filter(is_active=True)
    lookup_field = "username__iexact"

    serializers = {
        'list': CreatorListSerializer,
        'retrieve': CreatorDetailSerializer,
    }

    filter_backends = [DjangoFilterBackend, filters.SearchFilter, filters.OrderingFilter]
    filterset_fields = ['is_verified']
    search_fields = ['username', 'full_name']
    ordering_fields = ['date_joined', 'total', 'updated_at', 'username']

    def get_serializer_class(self):
        return self.serializers.get(self.action)

    def get_queryset(self):
        if self.action == 'list':
            home_sort = self.request.query_params.get('homeSort', None)

            base = Creator.objects.select_related(
                'avatar_image', 'banner_image'
            ).prefetch_related(
                'avatar_image__webp',
                'banner_image__webp',
                'zpage_set'
            ).exclude(
                models.Q(banner_image__isnull=True)
                | models.Q(avatar_image__isnull=True),
            )
            # random | updated | score
            if home_sort == "random":
                return base.order_by('?')
            if home_sort == "updated":
                return base.order_by('-updated_at')
            
            # If explicit ordering is requested via generic param, don't force default
            if self.request.query_params.get('ordering'):
                return base

            return base.order_by('-total')

        return super().get_queryset()


# TODO: this is a stopgap that may last a while:
# returns either "zpage" or "creator" based on id
# this allows us to serve pages and creators at the root
# over time we will remove the pages at the root
class GetTypeAPI(APIView):
    def get(self, request, *args, **kwargs):
        id = kwargs.get('id')

        try:
            Creator.objects.get(username__iexact=id)
            return Response("creator")
        except Creator.DoesNotExist:
            pass

        try:
            zpage: zPage = zPage.objects.get(
                models.Q(vanity__iexact=id) | models.Q(free2zaddr__iexact=id)
            )
            return Response("zpage")
        except zPage.DoesNotExist:
            return Response(status=status.HTTP_404_NOT_FOUND)
