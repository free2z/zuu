import django_filters

from .models import GenericFile


class GenericFileFilter(django_filters.FilterSet):
    access = django_filters.CharFilter(field_name='access')
    mime_type = django_filters.CharFilter(
        field_name='mime_type', lookup_expr='istartswith')

    class Meta:
        model = GenericFile
        fields = ['access', 'mime_type']
