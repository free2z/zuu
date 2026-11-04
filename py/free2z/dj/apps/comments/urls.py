from django.urls import path
from .views import (
    ParentCommentListCreateAPIView,
    vote_comment,
    CommentListCreateAPIView, CommentViewSet
)


urlpatterns = [
    path('', CommentViewSet.as_view({
        'get': 'list',
        'post': 'create'
    }), name='comment-list-create'),
    path('<uuid:uuid>/', CommentViewSet.as_view({
        'get': 'retrieve',
        'put': 'update',
        'patch': 'partial_update',
        'delete': 'destroy'
    }), name='comment-crud'),
    path('<uuid:uuid>/replies/',
         ParentCommentListCreateAPIView.as_view(), name='comment-replies'),
    path('<uuid:uuid>/vote/', vote_comment, name='vote_comment'),
    path('<str:type>/<uuid:uuid>/',
         CommentListCreateAPIView.as_view(), name='comments-for-content'),
]
