import json
import itertools

from django.db import models

from django_extensions.db.fields import AutoSlugField


class CreatedUpdated(models.Model):
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        abstract = True


class Timeline(CreatedUpdated):
    """
    Holds the Title and Events
    """

    # "title": {
    #     "media": {
    #       "url": "//imgs.search.brave.com/NQjGzZHWJ76xjy1NXvtVrztv0RZonz5GWJiVT5oMtB8/rs:fit:474:225:1/g:ce/aHR0cHM6Ly90c2Uy/Lm1tLmJpbmcubmV0/L3RoP2lkPU9JUC5O/RjYtUDUxTEtva0g4/MFlHRXFRdi1BSGFI/YSZwaWQ9QXBp",
    #       "caption": "A Timeline of ALL HISTORY",
    #       "credit": "https://www.onceuponapicture.co.uk/"
    #     },
    #     "text": {
    #       "headline": "Human History",
    #       "text": "<p>Checkit</p>"
    #     }
    # },

    headline = models.CharField(max_length=255)
    slug = AutoSlugField(populate_from='headline')
    text = models.TextField()

    # Inlines better admin experience
    media_url = models.URLField(blank=True)
    media_caption = models.CharField(max_length=255, blank=True)
    media_credit = models.CharField(max_length=255, blank=True)

    children = models.ManyToManyField(
        'self', blank=True, help_text="Sub-timelines",
    )

    # timelinejs options
    scale_factor = models.PositiveSmallIntegerField(
        default=2, blank=True)

    class Meta:
        pass

    def __str__(self) -> str:
        return self.headline

    def render_events(self) -> list:
        return [
            ev.render() for ev in self.events.all()
        ]

    def render(self) -> dict:
        d = {}
        d["title"] = {
            "media": {
                "url": self.media_url,
                "caption": self.media_caption,
                "credit": self.media_credit,
            },
            "text": {
                "headline": self.headline,
                "text": self.text,
            },
        }
        # TODO: recursive render of events and chain.
        # now only renders one level
        d["events"] = list(itertools.chain(
            self.render_events(),
            *[child.render_events() for child in self.children.all()],
        ))
        return d

    def to_json(self) -> str:
        return json.dumps(self.render())


class Event(CreatedUpdated):
    #      {
    #     "start_date": {
    #       "year": "-12000"
    #     },
    #     "end_date": {
    #       "year": "-8000"
    #     },
    #     "media": {
    #       "url": "//imgs.search.brave.com/NQjGzZHWJ76xjy1NXvtVrztv0RZonz5GWJiVT5oMtB8/rs:fit:474:225:1/g:ce/aHR0cHM6Ly90c2Uy/Lm1tLmJpbmcubmV0/L3RoP2lkPU9JUC5O/RjYtUDUxTEtva0g4/MFlHRXFRdi1BSGFI/YSZwaWQ9QXBp",
    #       "caption": "A Timeline of ALL HISTORY",
    #       "credit": "https://www.onceuponapicture.co.uk/"
    #     },
    #     "text": {
    #       "headline": "Paleolithic",
    #       "text": "<p>Early stone age</p>"
    #     }
    #   },
    timeline = models.ForeignKey(
        'timelines.Timeline', on_delete=models.SET_NULL, null=True,
        related_name="events")

    # start
    start_year = models.IntegerField()
    start_month = models.PositiveSmallIntegerField(
        blank=True, null=True, choices=[(n, n) for n in range(1,13)]
    )
    start_day = models.PositiveSmallIntegerField(
        blank=True, null=True, choices=[(n, n) for n in range(1,31)]
    )
    start_hour = models.PositiveSmallIntegerField(
        blank=True, null=True, choices=[(n, n) for n in range(24)]
    )
    start_minute = models.PositiveSmallIntegerField(
        blank=True, null=True, choices=[(n, n) for n in range(60)]
    )
    start_second = models.PositiveSmallIntegerField(
        blank=True, null=True, choices=[(n, n) for n in range(60)]
    )
    start_millisecond = models.PositiveIntegerField(blank=True, null=True)

    # end
    end_year = models.IntegerField(blank=True, null=True)
    end_month = models.PositiveSmallIntegerField(
        blank=True, null=True, choices=[(n, n) for n in range(1,13)]
    )
    end_day = models.PositiveSmallIntegerField(
        blank=True, null=True, choices=[(n, n) for n in range(1,31)]
    )
    end_hour = models.PositiveSmallIntegerField(
        blank=True, null=True, choices=[(n, n) for n in range(24)]
    )
    end_minute = models.PositiveSmallIntegerField(
        blank=True, null=True, choices=[(n, n) for n in range(60)]
    )
    end_second = models.PositiveSmallIntegerField(
        blank=True, null=True, choices=[(n, n) for n in range(60)]
    )
    end_millisecond = models.PositiveIntegerField(blank=True, null=True)

    headline = models.CharField(max_length=255, blank=False)
    text = models.TextField()

    # MEDIA
    # media = models.ForeignKey('timelines.Media', null=True, blank=True, on_delete=models.SET_NULL)
    # Inlines better admin experience
    media_url = models.URLField(blank=True)
    media_caption = models.CharField(max_length=255, blank=True)
    media_credit = models.CharField(max_length=255, blank=True)


    class Meta:
        pass

    def __str__(self) -> str:
        return self.headline

    def render(self) -> dict:
        d = {}
        d['text'] = {
            "headline": self.headline,
            "text": self.text,
        }
        d['media'] = {
            "url": self.media_url,
            "caption": self.media_caption,
            "credit": self.media_credit,
        }
        d['start_date'] = {
            "year": self.start_year,
            "month": self.start_month,
            "day": self.start_day,
            "hour": self.start_hour,
            "minute": self.start_minute,
            "second": self.start_second,
            "millisecond": self.start_millisecond,
        }
        d['end_date'] = {
            "year": self.end_year or self.start_year,
            "month": self.end_month,
            "day": self.end_day,
            "hour": self.end_hour,
            "minute": self.end_minute,
            "second": self.end_second,
            "millisecond": self.end_millisecond,
        }
        return d
