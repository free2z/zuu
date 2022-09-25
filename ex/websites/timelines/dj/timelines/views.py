from django.shortcuts import render

from timelines.models import Timeline

from django.shortcuts import get_object_or_404, render


def detail(request, timeline_slug):
    timeline = get_object_or_404(Timeline, slug=timeline_slug)
    print(timeline)
    print(timeline.to_json())
    return render(request, 'timelines/detail.html', {
        'timeline': timeline,
        'json': timeline.to_json(),
    })

